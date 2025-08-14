const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const crypto = require("crypto");
const { createHash } = require("crypto");

initializeApp();
const db = getFirestore();

// --- Helpers ---
const assertIsAdmin = async (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) throw new HttpsError('permission-denied', 'Admin privileges required.');
};
const assertIsAuthenticated = (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
};
const functionOptions = {
    region: "us-central1",
    cors: [ "https://the-hawk-games-64239.web.app", "https://the-hawk-games.co.uk", /the-hawk-games\.co\.uk$/, "http://localhost:5000", "http://127.0.0.1:5000" ]
};

// --- seedInstantWins ---
exports.seedInstantWins = onCall(functionOptions, async (request) => {
    await assertIsAdmin(request);
    const { compId, instantWinPrizes, totalTickets } = request.data;
    if (!compId || !instantWinPrizes || !totalTickets) throw new HttpsError('invalid-argument', 'Missing parameters.');
    const totalPrizeCount = instantWinPrizes.reduce((sum, tier) => sum + tier.count, 0);
    if (totalPrizeCount > totalTickets) throw new HttpsError('invalid-argument', 'Too many prizes for the number of tickets.');
    const winningPicks = new Set();
    while (winningPicks.size < totalPrizeCount) { winningPicks.add(crypto.randomInt(0, totalTickets)); }
    const sortedWinningNumbers = Array.from(winningPicks).sort((a, b) => a - b);
    const salt = crypto.randomBytes(16).toString('hex');
    const positionsToHash = JSON.stringify(sortedWinningNumbers);
    const hash = createHash("sha256").update(positionsToHash + ':' + salt).digest("hex");
    const batch = db.batch();
    const instantWinsRef = db.collection('competitions').doc(compId).collection('instant_wins');
    let prizeCursor = 0;
    instantWinPrizes.forEach(tier => {
        for (let i = 0; i < tier.count; i++) {
            const ticketNumber = sortedWinningNumbers[prizeCursor++];
            const docRef = instantWinsRef.doc(String(ticketNumber));
            batch.set(docRef, { ticketNumber, prizeValue: tier.value, claimed: false, claimedBy: null, claimedAt: null });
        }
    });
    const compRef = db.collection('competitions').doc(compId);
    batch.update(compRef, { 'instantWinsConfig.enabled': true, 'instantWinsConfig.prizes': instantWinPrizes, 'instantWinsConfig.positionsHash': hash, 'instantWinsConfig.generator': 'v2-csprng-salt' });
    const serverMetaRef = compRef.collection('server_meta').doc('fairness_reveal');
    batch.set(serverMetaRef, { salt, positions: sortedWinningNumbers });
    await batch.commit();
    return { success: true, positionsHash: hash };
});

// --- allocateTicketsAndAwardTokens ---
exports.allocateTicketsAndAwardTokens = onCall(functionOptions, async (request) => {
    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const { compId, ticketsBought } = request.data;
    if (!compId || !ticketsBought || ticketsBought <= 0) throw new HttpsError('invalid-argument', 'Invalid parameters.');
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

        transaction.update(compRef, { ticketsSold: ticketsSoldBefore + ticketsBought });
        transaction.update(userRef, { [`entryCount.${compId}`]: userEntryCount + ticketsBought });
        const entryRef = compRef.collection('entries').doc();
        transaction.set(entryRef, {
            userId: uid, userDisplayName: userData.displayName || "N/A",
            ticketsBought, ticketStart: ticketStartNumber, ticketEnd: ticketStartNumber + ticketsBought - 1,
            enteredAt: FieldValue.serverTimestamp(), entryType: 'paid',
            instantWins: []
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
        return { success: true, ticketStart: ticketStartNumber, ticketsBought, awardedTokens: newTokens.length };
    });
});

// --- spendSpinToken ---
exports.spendSpinToken = onCall(functionOptions, async (request) => {
    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const { tokenId } = request.data;
    if (!tokenId) throw new HttpsError('invalid-argument', 'A tokenId is required to spend a token.');

    const userRef = db.collection('users').doc(uid);
    let prizeResult = { won: false, prizeValue: 0 };

    return await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');

        const userData = userDoc.data();
        const userTokens = userData.spinTokens || [];
        
        const tokenToSpend = userTokens.find(token => token.tokenId === tokenId);
        if (!tokenToSpend) throw new HttpsError('not-found', 'Spin token not found or already spent.');
        
        const compRef = db.collection('competitions').doc(tokenToSpend.compId);
        const instantWinsRef = compRef.collection('instant_wins');
        
        const unclaimedPrizesQuery = db.collection(instantWinsRef.path).where('claimed', '==', false);
        const unclaimedPrizesSnap = await unclaimedPrizesQuery.get();
        const unclaimedPrizes = unclaimedPrizesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (unclaimedPrizes.length > 0) {
            const winningPrizeIndex = crypto.randomInt(0, unclaimedPrizes.length);
            const winningPrize = unclaimedPrizes[winningPrizeIndex];
            prizeResult = { won: true, prizeValue: winningPrize.prizeValue };
            
            const prizeToClaimRef = instantWinsRef.doc(winningPrize.id);
            transaction.update(prizeToClaimRef, {
                claimed: true,
                claimedBy: uid,
                claimedAt: FieldValue.serverTimestamp(),
                tokenIdUsed: tokenId
            });
        }
        
        const updatedTokens = userTokens.filter(token => token.tokenId !== tokenId);
        transaction.update(userRef, { spinTokens: updatedTokens });
        return prizeResult;
    });
});

// --- purchaseSpinTokens (FIXED) ---
exports.purchaseSpinTokens = onCall(functionOptions, async (request) => {
    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const { compId, amount, price } = request.data;

    if (!compId || !amount || !price) {
        throw new HttpsError('invalid-argument', 'Missing parameters for token purchase.');
    }

    const userRef = db.collection('users').doc(uid);
    const compRef = db.collection('competitions').doc(compId);

    const compSnap = await compRef.get();
    // ========= THIS IS THE FIX =========
    // Changed compSnap.exists() to compSnap.exists
    if (!compSnap.exists) {
    // ===================================
        throw new HttpsError('not-found', 'The competition associated with this prize pool is no longer available.');
    }
    const compData = compSnap.data();

    let newTokens = [];
    const earnedAt = new Date();
    for (let i = 0; i < amount; i++) {
        newTokens.push({
            tokenId: crypto.randomBytes(16).toString('hex'),
            compId: compId,
            compTitle: compData.title,
            earnedAt: earnedAt
        });
    }

    await userRef.update({
        spinTokens: FieldValue.arrayUnion(...newTokens)
    });

    return { success: true, tokensAdded: newTokens.length };
});

// --- drawWinner ---
exports.drawWinner = onCall(functionOptions, async (request) => {
    await assertIsAdmin(request);
    const { compId } = request.data;
    if (!compId) throw new HttpsError('invalid-argument', 'Competition ID is required.');
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
