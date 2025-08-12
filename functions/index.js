const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const crypto = require("crypto");
const { createHash } = require("crypto");

initializeApp();
const db = getFirestore();

// Helper to check if the caller is an admin.
const assertIsAdmin = async (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) throw new HttpsError('permission-denied', 'Admin privileges required.');
};

// Helper to check for authentication.
const assertIsAuthenticated = (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in.');
};

const functionOptions = {
    region: "us-central1",
    cors: [
        "https://the-hawk-games-64239.web.app",
        "https://the-hawk-games.co.uk",
        /the-hawk-games\.co\.uk$/,
        "http://localhost:5000",
        "http://127.0.0.1:5000"
    ]
};

exports.seedInstantWins = onCall(functionOptions, async (request) => {
    await assertIsAdmin(request);
    const { compId, instantWinPrizes, totalTickets } = request.data;
    if (!compId || !instantWinPrizes || !totalTickets) throw new HttpsError('invalid-argument', 'Missing parameters.');
    const totalPrizeCount = instantWinPrizes.reduce((sum, tier) => sum + tier.count, 0);
    if (totalPrizeCount > totalTickets) throw new HttpsError('invalid-argument', 'Too many prizes for the number of tickets.');
    const winningPicks = new Set();
    while (winningPicks.size < totalPrizeCount) {
        winningPicks.add(crypto.randomInt(0, totalTickets));
    }
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

exports.allocateTicketsAndCheckWins = onCall(functionOptions, async (request) => {
    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const { compId, ticketsBought } = request.data;
    if (!compId || !ticketsBought || ticketsBought <= 0) throw new HttpsError('invalid-argument', 'Invalid parameters.');
    const compRef = db.collection('competitions').doc(compId);
    const userRef = db.collection('users').doc(uid);
    
    return await db.runTransaction(async (transaction) => {
        const compDoc = await transaction.get(compRef);
        const userDoc = await transaction.get(userRef);
        
        // THE FIX IS HERE: Changed compDoc.exists() to compDoc.exists
        if (!compDoc.exists) throw new HttpsError('not-found', 'Competition not found.');
        if (!userDoc.exists) throw new HttpsError('not-found', 'User profile not found.');
        
        const compData = compDoc.data();
        const userData = userDoc.data();

        if (compData.status !== 'live') throw new HttpsError('failed-precondition', 'Competition is not live.');
        if (compData.endDate && compData.endDate.toDate() < new Date()) throw new HttpsError('failed-precondition', 'Competition has ended.');
        
        const userEntryCount = (userData.entryCount && userData.entryCount[compId]) ? userData.entryCount[compId] : 0;
        
        const limit = compData.userEntryLimit || 75;
        if (userEntryCount + ticketsBought > limit) throw new HttpsError('failed-precondition', `Entry limit exceeded.`);
        
        const ticketsSoldBefore = compData.ticketsSold || 0;
        if (ticketsSoldBefore + ticketsBought > compData.totalTickets) throw new HttpsError('failed-precondition', `Not enough tickets available.`);
        
        const ticketStartNumber = ticketsSoldBefore;
        
        transaction.update(compRef, { ticketsSold: ticketsSoldBefore + ticketsBought });
        transaction.update(userRef, { [`entryCount.${compId}`]: userEntryCount + ticketsBought });
        const entryRef = compRef.collection('entries').doc();
        transaction.set(entryRef, { userId: uid, userDisplayName: userData.displayName || "N/A", ticketsBought, ticketStart: ticketStartNumber, ticketEnd: ticketStartNumber + ticketsBought - 1, enteredAt: FieldValue.serverTimestamp(), entryType: 'paid' });
        
        const wonPrizes = [];
        if (compData.instantWinsConfig && compData.instantWinsConfig.enabled) {
            const instantWinsRef = compRef.collection('instant_wins');
            for (let i = 0; i < ticketsBought; i++) {
                const currentTicketNumber = ticketStartNumber + i;
                const winDocRef = instantWinsRef.doc(String(currentTicketNumber));
                const winDoc = await transaction.get(winDocRef);
                
                // THE FIX IS HERE: Changed winDoc.exists() to winDoc.exists
                if (winDoc.exists && winDoc.data().claimed === false) {
                    transaction.update(winDocRef, { claimed: true, claimedBy: uid, claimedAt: FieldValue.serverTimestamp() });
                    wonPrizes.push({ ticketNumber: currentTicketNumber, prizeValue: winDoc.data().prizeValue });
                }
            }
        }
        return { success: true, ticketStart: ticketStartNumber, ticketsBought, wonPrizes };
    });
});

exports.drawWinner = onCall(functionOptions, async (request) => {
    await assertIsAdmin(request);
    const { compId } = request.data;
    if (!compId) throw new HttpsError('invalid-argument', 'Competition ID is required.');
    
    const compRef = db.collection('competitions').doc(compId);
    const entriesRef = compRef.collection('entries');
    
    const compDocForCheck = await compRef.get();
    // THE FIX IS HERE: Changed compDocForCheck.exists() to compDocForCheck.exists
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
        // THE FIX IS HERE: Changed winnerUserDocSnap.exists() to winnerUserDocSnap.exists
        const winnerPhotoURL = winnerUserDocSnap.exists ? winnerUserDocSnap.data().photoURL : null;
        const winnerDisplayName = winnerData.userDisplayName;

        transaction.update(compRef, { status: 'drawn', winnerId, winnerDisplayName, winningTicketNumber, drawnAt: FieldValue.serverTimestamp() });
        const pastWinnerRef = db.collection('pastWinners').doc(compId);
        transaction.set(pastWinnerRef, { prizeTitle: compData.title, prizeImage: compData.prizeImage, winnerId, winnerDisplayName, winnerPhotoURL, winningTicketNumber, drawDate: FieldValue.serverTimestamp() });
        
        return { success: true, winnerDisplayName, winningTicketNumber };
    });
});
