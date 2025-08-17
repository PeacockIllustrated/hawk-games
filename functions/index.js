const { onCall, HttpsError } = require("firebase-functions/v2/onCall");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const crypto = require("crypto");
const { z } = require("zod"); // --- SECURITY: Import Zod for schema validation ---

initializeApp();
const db = getFirestore();

// --- Helpers ---
const assertIsAdmin = async (context) => {
    // --- SECURITY: App Check is enforced by functionOptions now ---
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) throw new HttpsError('permission-denied', 'Admin privileges required.');
};
const assertIsAuthenticated = (context) => {
    // --- SECURITY: App Check is enforced by functionOptions now ---
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
};

// --- SECURITY: Enforce App Check on all callable functions ---
const functionOptions = {
    region: "us-central1",
    enforceAppCheck: true, // This is the crucial addition
    cors: [ "https://the-hawk-games-64239.web.app", "https://the-hawk-games.co.uk", /the-hawk-games\.co\.uk$/, "http://localhost:5000", "http://127.0.0.1:5000" ]
};

// --- allocateTicketsAndAwardTokens ---
// This function now handles ALL competition entries, including the new 'token' type competitions.
exports.allocateTicketsAndAwardTokens = onCall(functionOptions, async (request) => {
    // --- SECURITY: Zod schema for strict input validation ---
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

// --- spendSpinToken ---
exports.spendSpinToken = onCall(functionOptions, async (request) => {
    // --- SECURITY: Zod schema for strict input validation ---
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

// --- DEPRECATED: enterSpinnerCompetition ---
// This function is no longer needed as all entries now go through allocateTicketsAndAwardTokens.
// It is removed to simplify the backend and centralize logic.

// --- drawWinner ---
exports.drawWinner = onCall(functionOptions, async (request) => {
    // --- SECURITY: Zod schema for strict input validation ---
    const schema = z.object({
        compId: z.string().min(1),
    });

    const validation = schema.safeParse(request.data);
    if (!validation.success) {
      throw new HttpsError('invalid-argument', 'Competition ID is required.');
    }
    const { compId } = validation.data;

    await assertIsAdmin(request);
    
    const compRef = db.collection('competitions').doc(compId);
    const entriesRef = compRef.collection('entries');
    const compDocForCheck = await compRef.get();
    if (!compDocForCheck.exists) throw new HttpsError('not-found', 'Competition not found.');
    const compDataForCheck = compDocForCheck.data();
    if (compDataForCheck.status !== 'ended') throw new HttpsError('failed-precondition', 'Competition must be ended.');
    if (compDataForCheck.winnerId) throw new HttpsError('failed-precondition', 'Winner already drawn.');
    if (!compDataForCheck.ticketsSold || compDataForCheck.ticketsSold === 0) throw new HttpsError('failed-precondition', 'No entries to draw from.');
    const winningTicketNumber = crypto.randomInt(0, compDataForCheck.ticketsSold);
    const winnerQuery = entriesRef.where('ticketStart', '<=', winningTicketNumber).orderBy('ticketStart', 'desc').limit(1);
    const winnerSnapshot = await winnerQuery.get();
    if (winnerSnapshot.empty) throw new HttpsError('internal', `Could not find owner for ticket #${winningTicketNumber}.`);
    const winnerEntryDoc = winnerSnapshot.docs[0];
    const winnerData = winnerEntryDoc.data();
    const winnerId = winnerData.userId;
    return await db.runTransaction(async (transaction) => {
        const compDoc = await transaction.get(compRef); 
        const compData = compDoc.data();
        const winnerUserDocSnap = await db.collection('users').doc(winnerId).get();
        const winnerPhotoURL = winnerUserDocSnap.exists ? winnerUserDocSnap.data().photoURL : null;
        const winnerDisplayName = winnerData.userDisplayName;
        transaction.update(compRef, { status: 'drawn', winnerId, winnerDisplayName, winningTicketNumber, drawnAt: FieldValue.serverTimestamp() });
        const pastWinnerRef = db.collection('pastWinners').doc(compId);
        transaction.set(pastWinnerRef, { prizeTitle: compData.title, prizeImage: compData.prizeImage, winnerId, winnerDisplayName, winnerPhotoURL, winningTicketNumber, drawDate: FieldValue.serverTimestamp() });
        return { success: true, winnerDisplayName, winningTicketNumber };
    });
});
