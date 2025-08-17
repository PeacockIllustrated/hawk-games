const { onCall, HttpsError } = require("firebase-functions/v2/onCall");
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
        // If no tickets sold, we just mark it as drawn without a winner.
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

// --- allocateTicketsAndAwardTokens (No changes needed) ---
exports.allocateTicketsAndAwardTokens = onCall(functionOptions, async (request) => {
    const schema = z.object({
      compId: z.string().min(1),
      ticketsBought: z.number().int().positive(),
    });

    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'Invalid or malformed request data.');
    }
    const { compId, ticketsBought } = validation.data;

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
            enteredAt: FieldValue.serverTimestamp(), entryType: 'paid',
        });
        
        let newTokens = [];
        if (compData.instantWinsConfig && compData.instantWinsConfig.enabled) {
            const earnedAt = new Date();
            for (let i = 0; i < ticketsBought; i++) {
                newTokens.push({
                    tokenId: crypto.randomBytes(16).toString('hex'),
                    compId: compId,
                    compTitle: compData.title,
                    earnedAt: earnedAt 
                });
            }
            transaction.update(userRef, { spinTokens: FieldValue.arrayUnion(...newTokens) });
        }
        return { success: true, ticketStart: ticketStartNumber, ticketsBought, awardedTokens: newTokens };
    });
});

// --- spendSpinToken (No changes needed) ---
exports.spendSpinToken = onCall(functionOptions, async (request) => {
    const schema = z.object({
        tokenId: z.string().min(1),
    });
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
            const probability = 1 / prize.odds;
            cumulative += probability;
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

// --- drawWinner (Refactored to use internal function) ---
exports.drawWinner = onCall(functionOptions, async (request) => {
    const schema = z.object({
        compId: z.string().min(1),
    });
    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'Competition ID is required.');
    }
    const { compId } = validation.data;

    await assertIsAdmin(request);
    
    // Manual draw still requires ending the competition first via the admin panel
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

// --- NEW SCHEDULED FUNCTION ---
exports.weeklyTokenCompDraw = onSchedule({
    schedule: "every monday 12:00",
    timeZone: "Europe/London",
}, async (event) => {
    logger.log("Starting weekly token competition cycle...");

    const compsRef = db.collection('competitions');
    
    // 1. Find the currently live token competition
    const liveQuery = query(compsRef, where('competitionType', '==', 'token'), where('status', '==', 'live'), limit(1));
    const liveSnapshot = await liveQuery.get();

    if (!liveSnapshot.empty) {
        const liveDoc = liveSnapshot.docs[0];
        logger.log(`Found live token competition to close: ${liveDoc.id}`);

        // 2. End it and draw a winner
        await liveDoc.ref.update({ status: 'ended' });
        try {
            const drawResult = await performDraw(liveDoc.id);
            logger.log(`Successfully drew winner for ${liveDoc.id}: ${drawResult.winnerDisplayName}`);
        } catch (error) {
            logger.error(`Failed to automatically draw winner for ${liveDoc.id}`, error);
        }
    } else {
        logger.warn("No live token competition found to cycle. Will proceed to activate a new one if available.");
    }

    // 3. Find the next queued token competition
    const queuedQuery = query(compsRef, where('competitionType', '==', 'token'), where('status', '==', 'queued'), orderBy('createdAt', 'asc'), limit(1));
    const queuedSnapshot = await queuedQuery.get();
    
    if (!queuedSnapshot.empty) {
        const nextDoc = queuedSnapshot.docs[0];
        logger.log(`Activating next token competition: ${nextDoc.id}`);

        // 4. Activate it
        await nextDoc.ref.update({ 
            status: 'live',
            // Set the end date to next Monday at 12:00 London time
            endDate: Timestamp.fromDate(getNextMondayNoon())
        });
        logger.log(`Competition ${nextDoc.id} is now live.`);
    } else {
        logger.error("CRITICAL: No queued token competitions available to activate. Admin action required.");
    }

    return null;
});

function getNextMondayNoon() {
    const now = new Date();
    const londonOffset = 0; // UTC during winter, +1 during BST. JS handles this.
    const nowUTC = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));

    const dayOfWeek = nowUTC.getDay(); // Sunday = 0, Monday = 1...
    let daysUntilMonday = 1 - dayOfWeek;
    if (daysUntilMonday <= 0) {
        daysUntilMonday += 7;
    }

    const nextMonday = new Date(nowUTC);
    nextMonday.setDate(nowUTC.getDate() + daysUntilMonday);
    nextMonday.setHours(12, 0, 0, 0);

    return nextMonday;
}
