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
      paymentMethod: z.enum(['card', 'credit']).default('card'),
      tokenType: z.enum(['spinner', 'plinko']),
    });

    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'Invalid or malformed request data.');
    }
    const { compId, ticketsBought, expectedPrice, paymentMethod, tokenType } = validation.data;

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
        
        const tokenFieldToUpdate = tokenType === 'plinko' ? 'plinkoTokens' : 'spinTokens';
        transaction.update(userRef, { [tokenFieldToUpdate]: FieldValue.arrayUnion(...newTokens) });
        
        return { success: true, ticketsBought, awardedTokens: newTokens };
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
        // Fetch all settings and user data first
        const settingsRef = db.collection('admin_settings').doc('plinkoPrizes');
        const [userDoc, settingsDoc] = await Promise.all([transaction.get(userRef), transaction.get(settingsRef)]);

        if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');
        if (!settingsDoc.exists) throw new HttpsError('internal', 'Plinko prize configuration is not available.');
        
        const userData = userDoc.data();
        const settings = settingsDoc.data();
        const PLINKO_ROWS = settings.rows || 12; // Use configured rows, default to 12
        const payouts = settings.payouts || [];

        const userTokens = userData.plinkoTokens || [];
        const tokenIndex = userTokens.findIndex(t => t.tokenId === tokenId);
        if (tokenIndex === -1) {
            throw new HttpsError('not-found', 'Plinko token not found or already spent.');
        }
        const updatedTokens = userTokens.filter(t => t.tokenId !== tokenId);
        transaction.update(userRef, { plinkoTokens: updatedTokens });

        // Generate the path using pure binomial distribution (p=0.5)
        let rights = 0;
        const steps = [];
        for (let i = 0; i < PLINKO_ROWS; i++) {
            const step = Math.random() < 0.5 ? -1 : 1; // -1 for left, 1 for right
            steps.push(step);
            if (step === 1) rights++;
        }
        const finalSlotIndex = rights;

        const prizeValue = payouts[finalSlotIndex] || 0;

        const finalPrize = {
            won: prizeValue > 0,
            type: 'credit', // All Plinko prizes are site credit
            value: prizeValue
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
            transaction.update(userRef, { creditBalance: FieldValue.increment(finalPrize.value) });
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
