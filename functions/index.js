const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const crypto = require("crypto");
const { z } = require("zod");
const { logger } = require("firebase-functions");

initializeApp();
const db = getFirestore();

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
            } else if (finalPrize.prizeType === 'cash') {
                transaction.update(userRef, { cashBalance: FieldValue.increment(finalPrize.value) });
            }
        }
        return finalPrize;
    });
});

// --- transferCashToCredit ---
exports.transferCashToCredit = onCall(functionOptions, async (request) => {
    const schema = z.object({
        amount: z.number().positive("Amount must be a positive number."),
    });

    const validation = schema.safeParse(request.data);
    if (!validation.success) {
        throw new HttpsError('invalid-argument', validation.error.errors[0].message);
    }
    const { amount } = validation.data;

    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const userRef = db.collection('users').doc(uid);

    return db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
            throw new HttpsError('not-found', 'User profile not found.');
        }

        const userData = userDoc.data();
        const userCashBalance = userData.cashBalance || 0;

        if (userCashBalance < amount) {
            throw new HttpsError('failed-precondition', 'Insufficient cash balance.');
        }

        const creditToAdd = amount * 1.5;

        transaction.update(userRef, {
            cashBalance: FieldValue.increment(-amount),
            creditBalance: FieldValue.increment(creditToAdd)
        });

        return { success: true, newCreditBalance: (userData.creditBalance || 0) + creditToAdd };
    });
});

// --- requestCashPayout ---
exports.requestCashPayout = onCall(functionOptions, async (request) => {
    const schema = z.object({
        amount: z.number().positive("Amount must be a positive number."),
    });

    const validation = schema.safeParse(request.data);
    if (!validation.success) {
        throw new HttpsError('invalid-argument', validation.error.errors[0].message);
    }
    const { amount } = validation.data;

    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const userRef = db.collection('users').doc(uid);

    return db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
            throw new HttpsError('not-found', 'User profile not found.');
        }

        const userData = userDoc.data();
        const userCashBalance = userData.cashBalance || 0;

        if (userCashBalance < amount) {
            throw new HttpsError('failed-precondition', 'Insufficient cash balance.');
        }

        transaction.update(userRef, {
            cashBalance: FieldValue.increment(-amount)
        });

        const payoutRequestRef = db.collection('payoutRequests').doc();
        transaction.set(payoutRequestRef, {
            userId: uid,
            amount: amount,
            status: 'pending',
            requestedAt: FieldValue.serverTimestamp(),
            userDisplayName: userData.displayName || 'N/A',
            userEmail: userData.email || 'N/A'
        });

        return { success: true, message: "Payout request submitted successfully." };
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

// --- getRevenueAnalytics ---
exports.getRevenueAnalytics = onCall(functionOptions, async (request) => {
    await assertIsAdmin(request);

    try {
        // 1. Calculate Spinner Costs (Cash vs. Credit)
        const spinWinsSnapshot = await db.collection('spin_wins').get();
        let totalCashCost = 0;
        let totalSiteCreditAwarded = 0;
        spinWinsSnapshot.docs.forEach(doc => {
            const prize = doc.data();
            if (prize.prizeType === 'cash') {
                totalCashCost += prize.prizeValue || 0;
            } else if (prize.prizeType === 'credit') {
                totalSiteCreditAwarded += prize.prizeValue || 0;
            }
        });

        // 2. Calculate Revenue from all competitions, categorized by type
        const competitionsSnapshot = await db.collection('competitions').get();
        const revenueBySource = {
            main: 0,
            instant: 0,
            hero: 0,
            token: 0,
            other: 0
        };

        for (const compDoc of competitionsSnapshot.docs) {
            const compData = compDoc.data();
            const ticketTiersMap = new Map(compData.ticketTiers.map(tier => [tier.amount, tier.price]));
            const compType = compData.competitionType || 'other';

            const entriesSnapshot = await db.collection('competitions').doc(compDoc.id).collection('entries').get();
            for (const entryDoc of entriesSnapshot.docs) {
                const entryData = entryDoc.data();
                if (entryData.entryType === 'paid' || entryData.entryType === 'credit') {
                     if (ticketTiersMap.has(entryData.ticketsBought)) {
                        const price = ticketTiersMap.get(entryData.ticketsBought);
                        if (revenueBySource.hasOwnProperty(compType)) {
                            revenueBySource[compType] += price;
                        } else {
                            revenueBySource.other += price;
                        }
                    }
                }
            }
        }

        // 3. Calculate Spinner-specific revenue and profit
        const spinnerTokenRevenue = (revenueBySource.instant || 0) + (revenueBySource.hero || 0) + (revenueBySource.token || 0);
        const netProfit = spinnerTokenRevenue - totalCashCost;

        return {
            success: true,
            revenueBySource,
            spinnerTokenRevenue,
            totalCashCost,
            totalSiteCreditAwarded,
            netProfit
        };

    } catch (error) {
        logger.error("Error calculating revenue analytics:", error);
        throw new HttpsError('internal', 'An unexpected error occurred while calculating analytics.');
    }
});

// --- resetSpinnerStats ---
exports.resetSpinnerStats = onCall(functionOptions, async (request) => {
    await assertIsAdmin(request);

    const collectionRef = db.collection('spin_wins');
    const batchSize = 100;

    try {
        let query = collectionRef.orderBy('__name__').limit(batchSize);
        let snapshot = await query.get();

        while (snapshot.size > 0) {
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();

            const lastDoc = snapshot.docs[snapshot.docs.length - 1];
            query = collectionRef.orderBy('__name__').startAfter(lastDoc).limit(batchSize);
            snapshot = await query.get();
        }

        logger.log("Successfully deleted all documents from 'spin_wins' collection.");
        return { success: true, message: "Spinner stats have been reset." };

    } catch (error) {
        logger.error("Error resetting spinner stats:", error);
        throw new HttpsError('internal', 'Could not reset spinner stats.');
    }
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
