const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const crypto = require("crypto");
const { z } = require("zod");
const { logger } = require("firebase-functions");

initializeApp();
const db = getFirestore();

// --- Auditing Helper ---
const logAuditEvent = (eventType, details) => {
    // No need to get db again if it's already global
    const auditRef = db.collection('audits').doc();
    return auditRef.set({
        timestamp: FieldValue.serverTimestamp(),
        eventType,
        details,
    });
};

// --- Internal Helper for Reusable Draw Logic ---
const performDraw = async (compId) => {
    const compRef = db.collection('competitions').doc(compId);
    const entriesRef = compRef.collection('entries');

    const compDocForCheck = await compRef.get();
    if (!compDocForCheck.exists) throw new Error(`Competition ${compId} not found for drawing.`);
    
    const compDataForCheck = compDocForCheck.data();
    if (compDataForCheck.status !== 'ended') throw new Error(`Competition ${compId} must be in 'ended' status to be drawn.`);
    if (compDataForCheck.winnerId) throw new Error(`Winner already drawn for competition ${compId}.`);
    if (!compDataForCheck.ticketsSold || compDataForCheck.ticketsSold === 0) {
        await compRef.update({ status: 'drawn', drawnAt: FieldValue.serverTimestamp(), winnerDisplayName: 'No entries' });
        logger.warn(`Competition ${compId} had no entries. Marked as drawn.`);
        return { success: true, winnerDisplayName: 'No entries', winningTicketNumber: -1 };
    }

    const winningTicketNumber = crypto.randomInt(0, compDataForCheck.ticketsSold);
    const winnerQuery = entriesRef.where('ticketStart', '<=', winningTicketNumber).orderBy('ticketStart', 'desc').limit(1);
    const winnerSnapshot = await winnerQuery.get();

    if (winnerSnapshot.empty) throw new Error(`Could not find an entry for winning ticket number ${winningTicketNumber} in competition ${compId}.`);

    const winnerEntryDoc = winnerSnapshot.docs[0];
    const winnerData = winnerEntryDoc.data();
    const winnerId = winnerData.userId;

    return await db.runTransaction(async (transaction) => {
        const winnerUserDocSnap = await db.collection('users').doc(winnerId).get();
        const winnerPhotoURL = winnerUserDocSnap.exists ? winnerUserDocSnap.data().photoURL : null;
        const winnerDisplayName = winnerData.userDisplayName;

        transaction.update(compRef, { 
            status: 'drawn', 
            winnerId, 
            winnerDisplayName, 
            winningTicketNumber, 
            drawnAt: FieldValue.serverTimestamp() 
        });

        const pastWinnerRef = db.collection('pastWinners').doc(compId);
        transaction.set(pastWinnerRef, { 
            prizeTitle: compDataForCheck.title, 
            prizeImage: compDataForCheck.prizeImage, 
            winnerId, 
            winnerDisplayName, 
            winnerPhotoURL, 
            winningTicketNumber, 
            drawDate: FieldValue.serverTimestamp() 
        });

        return { success: true, winnerDisplayName, winningTicketNumber };
    });
};


// --- Helpers ---
const assertIsAdmin = async (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) throw new HttpsError('permission-denied', 'Admin privileges required.');
};
const assertIsAuthenticated = (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
};

// --- SECURITY: Enforce App Check on all callable functions ---
const functionOptions = {
    region: "us-central1",
    enforceAppCheck: true,
    cors: [ "https://the-hawk-games-64239.web.app", "https://the-hawk-games.co.uk", /the-hawk-games\.co\.uk$/, "http://localhost:5000", "http://127.0.0.1:5000" ]
};

// --- allocateTicketsAndAwardTokens ---
exports.allocateTicketsAndAwardTokens = onCall(functionOptions, async (request) => {
    const schema = z.object({
      compId: z.string().min(1),
      ticketsBought: z.number().int().positive(),
      expectedPrice: z.number().positive(),
      paymentMethod: z.enum(['card', 'credit']).default('card')
    });

    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'Invalid or malformed request data.');
    }
    const { compId, ticketsBought, expectedPrice, paymentMethod } = validation.data;

    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const compRef = db.collection('competitions').doc(compId);
    const userRef = db.collection('users').doc(uid);
    
    return await db.runTransaction(async (transaction) => {
        const compDoc = await transaction.get(compRef);
        const userDoc = await transaction.get(userRef);
        if (!compDoc.exists) throw new HttpsError('not-found', 'Competition not found.');
        if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');
        const compData = compDoc.data();
        const userData = userDoc.data();

        // --- Loyalty Unlock Gate ---
        if (compData.loyalty?.requiresUnlock) {
            const loyaltySettingsDoc = await db.collection('settings').doc('loyaltyTechDraw').get();
            if (!loyaltySettingsDoc.exists() || !loyaltySettingsDoc.data().enabled) {
                throw new HttpsError('failed-precondition', 'The loyalty program is not currently active.');
            }
            const loyaltySettings = loyaltySettingsDoc.data();
            const windowId = loyaltySettings.windowId;
            const userLoyalty = userData.loyalty || {};
            const unlockKey = `unlocked_${windowId}`;

            if (!userLoyalty[unlockKey]) {
                await logAuditEvent('purchase_denied_loyalty', {
                    userId: uid,
                    compId: compId,
                    reason: `User not unlocked for window ${windowId}.`,
                });
                throw new HttpsError('failed-precondition', 'You must unlock this competition by entering 3 eligible tech competitions this month.');
            }
        }

        const tier = compData.ticketTiers.find(t => t.amount === ticketsBought);
        if (!tier) {
            throw new HttpsError('invalid-argument', 'Selected ticket bundle is not valid for this competition.');
        }
        if (tier.price !== expectedPrice) {
            throw new HttpsError('invalid-argument', 'Price mismatch. Please refresh and try again.');
        }
        
        let entryType = 'paid';
        if (paymentMethod === 'credit') {
            entryType = 'credit';
            const userCredit = userData.creditBalance || 0;
            if (userCredit < expectedPrice) {
                throw new HttpsError('failed-precondition', 'Insufficient credit balance.');
            }
            transaction.update(userRef, { creditBalance: FieldValue.increment(-expectedPrice) });
        }

        if (compData.status !== 'live') throw new HttpsError('failed-precondition', 'Competition is not live.');
        const userEntryCount = (userData.entryCount && userData.entryCount[compId]) ? userData.entryCount[compId] : 0;
        const limit = compData.userEntryLimit || 75;
        if (userEntryCount + ticketsBought > limit) throw new HttpsError('failed-precondition', `Entry limit exceeded.`);
        const ticketsSoldBefore = compData.ticketsSold || 0;
        if (ticketsSoldBefore + ticketsBought > compData.totalTickets) throw new HttpsError('failed-precondition', `Not enough tickets available.`);
        const ticketStartNumber = ticketsSoldBefore;

        transaction.update(compRef, { ticketsSold: FieldValue.increment(ticketsBought) });
        transaction.update(userRef, { [`entryCount.${compId}`]: FieldValue.increment(ticketsBought) });
        
        const entryRef = compRef.collection('entries').doc();
        transaction.set(entryRef, {
            userId: uid, userDisplayName: userData.displayName || "N/A",
            ticketsBought, ticketStart: ticketStartNumber, ticketEnd: ticketStartNumber + ticketsBought - 1,
            enteredAt: FieldValue.serverTimestamp(), 
            entryType: entryType,
        });
        
        let awardedTokens = [];
        if (compData.instantWinsConfig?.enabled === true) {
            const newTokens = [];
            const earnedAt = new Date();
            for (let i = 0; i < ticketsBought; i++) {
                newTokens.push({
                    tokenId: crypto.randomBytes(16).toString('hex'),
                    compId: compId,
                    compTitle: compData.title,
                    earnedAt: earnedAt
                });
            }
            // Defaulting to 'spinTokens' as per README; plinko token logic is unclear.
            transaction.update(userRef, { spinTokens: FieldValue.arrayUnion(...newTokens) });
            awardedTokens = newTokens;
        }
        
        return { success: true, ticketsBought, awardedTokens };
    });
});

// --- spendSpinToken ---
exports.spendSpinToken = onCall(functionOptions, async (request) => {
    const schema = z.object({ tokenId: z.string().min(1) });
    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'A valid tokenId is required.');
    }
    const { tokenId } = validation.data;
    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const userRef = db.collection('users').doc(uid);

    return db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');
        const userData = userDoc.data();
        const userTokens = userData.spinTokens || [];
        const tokenIndex = userTokens.findIndex(t => t.tokenId === tokenId);
        if (tokenIndex === -1) {
            throw new HttpsError('not-found', 'Spin token not found or already spent.');
        }
        const updatedTokens = userTokens.filter(t => t.tokenId !== tokenId);
        transaction.update(userRef, { spinTokens: updatedTokens });
        const settingsRef = db.collection('admin_settings').doc('spinnerPrizes');
        const settingsDoc = await settingsRef.get();
        if (!settingsDoc.exists) {
            throw new HttpsError('internal', 'Spinner prize configuration is not available.');
        }
        const prizes = settingsDoc.data().prizes;
        const cumulativeProbabilities = [];
        let cumulative = 0;
        for (const prize of prizes) {
            cumulative += (1 / prize.odds);
            cumulativeProbabilities.push({ ...prize, cumulativeProb: cumulative });
        }
        const random = Math.random();
        let finalPrize = { won: false, prizeType: 'none', value: 0 };
        for (const prize of cumulativeProbabilities) {
            if (random < prize.cumulativeProb) {
                finalPrize = { won: true, prizeType: prize.type, value: prize.value };
                break;
            }
        }
        if (finalPrize.won) {
            const winLogRef = db.collection('spin_wins').doc();
            transaction.set(winLogRef, {
                userId: uid,
                prizeType: finalPrize.prizeType,
                prizeValue: finalPrize.value,
                wonAt: FieldValue.serverTimestamp(),
                tokenIdUsed: tokenId,
            });
            if (finalPrize.prizeType === 'credit') {
                transaction.update(userRef, { creditBalance: FieldValue.increment(finalPrize.value) });
            }
        }
        return finalPrize;
    });
});

// --- playPlinko ---
exports.playPlinko = onCall(functionOptions, async (request) => {
    const schema = z.object({ tokenId: z.string().min(1) });
    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'A valid tokenId is required.');
    }
    const { tokenId } = validation.data;
    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const userRef = db.collection('users').doc(uid);

    return db.runTransaction(async (transaction) => {
        const settingsRef = db.collection('admin_settings').doc('plinkoPrizes');
        const [userDoc, settingsDoc] = await Promise.all([transaction.get(userRef), transaction.get(settingsRef)]);

        if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');
        if (!settingsDoc.exists) throw new HttpsError('internal', 'Plinko prize configuration is not available.');
        
        const userData = userDoc.data();
        const settings = settingsDoc.data();
        const PLINKO_ROWS = settings.rows || 12;
        const payouts = settings.payouts || [];
        const mode = settings.mode || 'server';

        const userTokens = userData.plinkoTokens || [];
        const tokenIndex = userTokens.findIndex(t => t.tokenId === tokenId);
        if (tokenIndex === -1) {
            throw new HttpsError('not-found', 'Plinko token not found or already spent.');
        }
        const updatedTokens = userTokens.filter(t => t.tokenId !== tokenId);
        transaction.update(userRef, { plinkoTokens: updatedTokens });

        let rights = 0;
        const steps = [];
        for (let i = 0; i < PLINKO_ROWS; i++) {
            let step;
            if (mode === 'weighted') {
                // Example of a slight center bias, can be made more complex
                step = Math.random() < 0.55 ? 1 : -1;
            } else { // 'unbiased' and 'server' default to pure 50/50
                step = Math.random() < 0.5 ? -1 : 1;
            }
            steps.push(step);
            if (step === 1) rights++;
        }
        const finalSlotIndex = rights;

        const prize = payouts[finalSlotIndex] || { type: 'credit', value: 0 };
        const finalPrize = {
            won: prize.value > 0,
            type: prize.type || 'credit',
            value: prize.value || 0
        };

        if (finalPrize.won) {
            const winLogRef = db.collection('plinko_wins').doc();
            transaction.set(winLogRef, {
                userId: uid,
                prizeType: finalPrize.type,
                prizeValue: finalPrize.value,
                slotIndex: finalSlotIndex,
                wonAt: FieldValue.serverTimestamp(),
                tokenIdUsed: tokenId,
            });
            if (finalPrize.type === 'credit') {
                transaction.update(userRef, { creditBalance: FieldValue.increment(finalPrize.value) });
            }
        }
        
        return { prize: finalPrize, path: { steps, slotIndex: finalSlotIndex } };
    });
});

// --- drawWinner ---
exports.drawWinner = onCall(functionOptions, async (request) => {
    const schema = z.object({ compId: z.string().min(1) });
    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'Competition ID is required.');
    }
    const { compId } = validation.data;

    await assertIsAdmin(request);
    
    const compRef = db.collection('competitions').doc(compId);
    const compDoc = await compRef.get();
    if (!compDoc.exists || compDoc.data().status !== 'ended') {
        throw new HttpsError('failed-precondition', 'Competition must be in "ended" status to be drawn manually.');
    }

    try {
        const result = await performDraw(compId);
        return { success: true, ...result };
    } catch (error) {
        logger.error(`Manual draw failed for compId: ${compId}`, error);
        throw new HttpsError('internal', error.message || 'An internal error occurred during the draw.');
    }
});

// --- backfillCompetitionSchema (Admin-only Migration) ---
exports.backfillCompetitionSchema = onCall(functionOptions, async (request) => {
    await assertIsAdmin(request);

    logger.log("Starting competition schema backfill...");

    const batch = db.batch();
    let updatedCount = 0;

    // 1. Set up the global settings document
    const settingsRef = db.collection('settings').doc('loyaltyTechDraw');
    const settingsDoc = await settingsRef.get();

    if (!settingsDoc.exists) {
        batch.set(settingsRef, {
            enabled: false,
            windowStrategy: "monthly",
            windowId: "2025-08",
            threshold: 3,
            targetCompId: "replace-with-real-comp-id",
            postalLimitPerComp: 1,
            notifications: { email: true, inApp: true }
        });
        logger.log("Created 'settings/loyaltyTechDraw' document with default values.");
    } else {
        logger.log("'settings/loyaltyTechDraw' document already exists.");
    }

    // 2. Backfill all competition documents
    const compsSnapshot = await db.collection('competitions').get();

    compsSnapshot.forEach(doc => {
        const compData = doc.data();
        let needsUpdate = false;
        const updatePayload = {};

        // Check and apply default for each new field group
        if (compData.category === undefined) {
            updatePayload.category = "other";
            needsUpdate = true;
        }
        if (compData.labels === undefined) {
            updatePayload.labels = [];
            needsUpdate = true;
        }
        if (compData.loyalty === undefined) {
            updatePayload.loyalty = {
                isLoyaltyComp: false,
                requiresUnlock: false,
                eligibleForTechUnlock: false,
                windowId: null,
                displayBadge: null,
                eligibilityNote: null
            };
            needsUpdate = true;
        }
        if (compData.freeRoute === undefined) {
            updatePayload.freeRoute = {
                postalEnabled: true,
                postalLimitPerUser: 1
            };
            needsUpdate = true;
        }

        if (needsUpdate) {
            batch.update(doc.ref, updatePayload);
            updatedCount++;
        }
    });

    if (updatedCount > 0) {
        await batch.commit();
        logger.log(`Successfully backfilled schema for ${updatedCount} competitions.`);
        return { success: true, message: `Updated ${updatedCount} competitions and ensured settings doc exists.` };
    } else {
        // If there were no comps to update, we still need to commit the settings doc if it was created
        if (!settingsDoc.exists) {
            await batch.commit();
            return { success: true, message: "Created settings document. No competitions required updates." };
        }
        logger.log("No competitions required schema updates.");
        return { success: true, message: "No competitions required updates, and settings doc already exists." };
    }
});

// --- submitPostalEntry ---
exports.submitPostalEntry = onCall(functionOptions, async (request) => {
    const schema = z.object({
      compId: z.string().min(1),
    });

    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'A valid competition ID is required.');
    }
    const { compId } = validation.data;

    assertIsAuthenticated(request);
    const uid = request.auth.uid;

    const compRef = db.collection('competitions').doc(compId);
    const userRef = db.collection('users').doc(uid);
    const entriesRef = compRef.collection('entries');

    return await db.runTransaction(async (transaction) => {
        const [compDoc, userDoc] = await Promise.all([
            transaction.get(compRef),
            transaction.get(userRef)
        ]);

        if (!compDoc.exists) throw new HttpsError('not-found', 'Competition not found.');
        if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');

        const compData = compDoc.data();
        const userData = userDoc.data();

        if (compData.status !== 'live') {
            throw new HttpsError('failed-precondition', 'This competition is not live.');
        }
        if (compData.freeRoute?.postalEnabled !== true) {
            throw new HttpsError('failed-precondition', 'Postal entries are not enabled for this competition.');
        }

        const postalLimit = compData.freeRoute?.postalLimitPerUser || 1;

        const postalQuery = entriesRef
            .where('userId', '==', uid)
            .where('entryType', '==', 'free_postal');

        const existingPostalEntries = await transaction.get(postalQuery);

        if (existingPostalEntries.size >= postalLimit) {
            throw new HttpsError('failed-precondition', `You have reached the postal entry limit for this competition.`);
        }

        const ticketsSoldBefore = compData.ticketsSold || 0;
        if (ticketsSoldBefore + 1 > compData.totalTickets) {
            throw new HttpsError('failed-precondition', 'Not enough tickets available.');
        }

        // Grant one free ticket
        transaction.update(compRef, { ticketsSold: FieldValue.increment(1) });

        const entryRef = compRef.collection('entries').doc();
        transaction.set(entryRef, {
            userId: uid,
            userDisplayName: userData.displayName || "N/A",
            ticketsBought: 1,
            ticketStart: ticketsSoldBefore,
            ticketEnd: ticketsSoldBefore,
            enteredAt: FieldValue.serverTimestamp(),
            entryType: 'free_postal',
        });

        await logAuditEvent('postal_entry_submitted', {
            userId: uid,
            compId: compId,
            ticketCount: 1,
        });

        return { success: true, message: 'Your postal entry has been submitted successfully.' };
    });
});

const { onDocumentCreated } = require("firebase-functions/v2/firestore");

// --- onNewEntryCheckForUnlock ---
exports.onNewEntryCheckForUnlock = onDocumentCreated("competitions/{compId}/entries/{entryId}", async (event) => {
    const snap = event.data;
    if (!snap) {
        logger.log("No data associated with the event, exiting.");
        return;
    }
    const entryData = snap.data();
    const userId = entryData.userId;
    const compId = event.params.compId;

    try {
        // 1. Get loyalty settings and check if the feature is enabled
        const settingsDoc = await db.collection('settings').doc('loyaltyTechDraw').get();
        if (!settingsDoc.exists() || !settingsDoc.data().enabled) {
            logger.log("Loyalty feature is disabled. Exiting unlock check.");
            return;
        }
        const settings = settingsDoc.data();
        const { windowId, threshold, targetCompId } = settings;
        const unlockFlag = `loyalty.unlocked_${windowId}`;
        const bonusTicketFlag = `loyalty.bonus_${windowId}`;

        // 2. Check if the source competition is eligible
        const sourceCompDoc = await db.collection('competitions').doc(compId).get();
        if (!sourceCompDoc.exists() || sourceCompDoc.data().loyalty?.eligibleForTechUnlock !== true) {
            logger.log(`Comp ${compId} is not eligible for tech unlock. Exiting.`);
            return;
        }

        // 3. Check if user is already unlocked for this window
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists()) return;
        const userData = userDoc.data();
        if (userData.loyalty && userData.loyalty[`unlocked_${windowId}`]) {
            logger.log(`User ${userId} is already unlocked for window ${windowId}. Exiting.`);
            return;
        }

        // 4. Count unique, eligible tech comp entries for this user in this window
        const allUserEntriesSnapshot = await db.collectionGroup('entries').where('userId', '==', userId).get();
        const enteredCompIds = new Set();
        allUserEntriesSnapshot.forEach(doc => {
            enteredCompIds.add(doc.ref.parent.parent.id);
        });

        let eligibleEntryCount = 0;
        const compPromises = Array.from(enteredCompIds).map(id => db.collection('competitions').doc(id).get());
        const compDocs = await Promise.all(compPromises);

        for (const doc of compDocs) {
            if (doc.exists && doc.data().loyalty?.eligibleForTechUnlock === true) {
                 // Optional: Check if comp was live during the correct window. For now, we assume any entry counts.
                 eligibleEntryCount++;
            }
        }

        logger.log(`User ${userId} has ${eligibleEntryCount} eligible tech entries for window ${windowId}. Threshold is ${threshold}.`);

        // 5. If threshold is met, grant unlock and bonus ticket idempotently
        if (eligibleEntryCount >= threshold) {
            await db.runTransaction(async (transaction) => {
                const userSnap = await transaction.get(userRef);
                // Double-check the user hasn't been unlocked by a concurrent function run
                if (userSnap.data().loyalty && userSnap.data().loyalty[`unlocked_${windowId}`]) {
                    logger.log('Unlock race condition averted. User already unlocked.');
                    return;
                }

                // Grant the unlock
                transaction.update(userRef, { [unlockFlag]: true, [bonusTicketFlag]: 'granted' });

                // Grant the bonus ticket to the target competition
                const targetCompRef = db.collection('competitions').doc(targetCompId);
                const targetCompDoc = await transaction.get(targetCompRef);
                if (!targetCompDoc.exists() || targetCompDoc.data().status !== 'live') {
                    logger.error(`Target comp ${targetCompId} not found or not live. Cannot grant bonus ticket.`);
                    // Still grant the unlock, but log the error
                    return;
                }
                const targetCompData = targetCompDoc.data();
                const ticketsSoldBefore = targetCompData.ticketsSold || 0;

                transaction.update(targetCompRef, { ticketsSold: FieldValue.increment(1) });

                const bonusEntryRef = targetCompRef.collection('entries').doc(`bonus_${windowId}_${userId}`);
                transaction.set(bonusEntryRef, {
                    userId: userId,
                    userDisplayName: userData.displayName || "N/A",
                    ticketsBought: 1,
                    ticketStart: ticketsSoldBefore,
                    ticketEnd: ticketsSoldBefore,
                    enteredAt: FieldValue.serverTimestamp(),
                    entryType: 'bonus_loyalty_tech',
                });

                await logAuditEvent('loyalty_unlocked', {
                    userId: userId,
                    windowId: windowId,
                    threshold: threshold,
                    triggeringCompId: compId,
                });
                await logAuditEvent('bonus_ticket_granted', {
                    userId: userId,
                    targetCompId: targetCompId,
                    reason: `Loyalty unlock for window ${windowId}`,
                });

                logger.log(`Successfully unlocked user ${userId} for window ${windowId} and granted bonus ticket to ${targetCompId}.`);
            });
        }
    } catch (error) {
        logger.error(`Error in onNewEntryCheckForUnlock for user ${userId} and comp ${compId}:`, error);
    }
});

// --- weeklyTokenCompMaintenance ---
exports.weeklyTokenCompMaintenance = onSchedule({
    schedule: "every monday 12:00",
    timeZone: "Europe/London",
}, async (event) => {
    logger.log("Starting weekly token competition maintenance...");

    const compsRef = db.collection('competitions');
    const oneWeekAgo = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const oldCompsQuery = query(compsRef, 
        where('competitionType', '==', 'token'), 
        where('status', '==', 'live'),
        where('createdAt', '<=', oneWeekAgo)
    );
    
    const snapshot = await oldCompsQuery.get();

    if (snapshot.empty) {
        logger.log("No old token competitions found needing cleanup. Exiting.");
        return null;
    }

    logger.log(`Found ${snapshot.docs.length} old token competitions to process.`);

    for (const doc of snapshot.docs) {
        const compId = doc.id;
        logger.log(`Processing competition ${compId}...`);
        try {
            await doc.ref.update({ status: 'ended' });
            logger.log(`Competition ${compId} status set to 'ended'.`);
            const drawResult = await performDraw(compId);
            logger.log(`Successfully drew winner for ${compId}: ${drawResult.winnerDisplayName}`);
        } catch (error) {
            logger.error(`Failed to process and draw winner for ${compId}`, error);
        }
    }

    const liveTokenQuery = query(compsRef, where('competitionType', '==', 'token'), where('status', '==', 'live'));
    const liveTokenSnapshot = await liveTokenQuery.get();
    if (liveTokenSnapshot.size < 3) {
        logger.warn(`CRITICAL: The pool of live token competitions is low (${liveTokenSnapshot.size}). Admin should create more.`);
    }

    return null;
});
