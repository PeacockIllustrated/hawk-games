const functions = require("firebase-functions");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const crypto = require("crypto");
const { createHash } = require("crypto");

initializeApp();
const db = getFirestore();
const { HttpsError } = functions.https;

// --- CORS Configuration ---
// This explicitly allows your website domains to communicate with these functions.
const allowedOrigins = [
    "https://the-hawk-games-64239.web.app", // Your Firebase Hosting URL
    "https://the-hawk-games.co.uk",      // Your custom domain
    "http://localhost:5000",             // For local testing
    "http://127.0.0.1:5000"               // For local testing
];
const cors = require("cors")({ origin: allowedOrigins });


// --- Helper Functions for Security & Code Reusability ---
const assertIsAdmin = async (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in to call this function.');
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists() || !userDoc.data().isAdmin) throw new HttpsError('permission-denied', 'You must be an admin to perform this action.');
};

const assertIsAuthenticated = (context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'You must be logged in to perform this action.');
};

// This is the robust wrapper that applies CORS to all our functions.
const createCallable = (handler) => {
    return functions.https.onRequest((req, res) => {
        cors(req, res, async () => {
            try {
                const context = { auth: req.auth };
                const data = req.body.data;
                const result = await handler(data, context);
                res.status(200).send({ data: result });
            } catch (err) {
                if (err instanceof HttpsError) {
                    res.status(err.httpErrorCode.status).send({ error: { message: err.message, code: err.code } });
                } else {
                    console.error("Unhandled error:", err);
                    res.status(500).send({ error: { message: "An internal server error occurred." } });
                }
            }
        });
    });
};


// ======================================================================
// ===                CORE BUSINESS LOGIC FUNCTIONS                   ===
// ======================================================================


/**
 * Seeds a competition with securely generated instant win ticket numbers.
 */
exports.seedInstantWins = createCallable(async (data, context) => {
    await assertIsAdmin(context);
    const { compId, instantWinPrizes, totalTickets } = data;
    if (!compId || !instantWinPrizes || !totalTickets) throw new HttpsError('invalid-argument', 'Missing required parameters.');
    const totalPrizeCount = instantWinPrizes.reduce((sum, tier) => sum + tier.count, 0);
    if (totalPrizeCount > totalTickets) throw new HttpsError('invalid-argument', 'Total number of instant prizes cannot exceed the total number of tickets.');
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

/**
 * Atomically allocates tickets to a user and checks for instant wins.
 */
exports.allocateTicketsAndCheckWins = createCallable(async (data, context) => {
    assertIsAuthenticated(context);
    const uid = context.auth.uid;
    const { compId, ticketsBought } = data;
    if (!compId || !ticketsBought || ticketsBought <= 0) throw new HttpsError('invalid-argument', 'Competition ID and a valid number of tickets are required.');
    const compRef = db.collection('competitions').doc(compId);
    const userRef = db.collection('users').doc(uid);
    const wonPrizes = [];
    let ticketStartNumber;
    const result = await db.runTransaction(async (transaction) => {
        const compDoc = await transaction.get(compRef);
        const userDoc = await transaction.get(userRef);
        if (!compDoc.exists()) throw new HttpsError('not-found', 'Competition not found.');
        if (!userDoc.exists()) throw new HttpsError('not-found', 'User profile not found.');
        const compData = compDoc.data();
        const userData = userDoc.data();
        if (compData.status !== 'live') throw new HttpsError('failed-precondition', 'This competition is no longer live.');
        if (compData.endDate && compData.endDate.toDate() < new Date()) throw new HttpsError('failed-precondition', 'This competition has ended.');
        const userEntryCount = userData.entryCount?.[compId] || 0;
        const limit = compData.userEntryLimit || 75;
        if (userEntryCount + ticketsBought > limit) throw new HttpsError('failed-precondition', `Entry limit exceeded. You can enter ${limit - userEntryCount} more times.`);
        const ticketsSoldBefore = compData.ticketsSold || 0;
        if (ticketsSoldBefore + ticketsBought > compData.totalTickets) throw new HttpsError('failed-precondition', `Not enough tickets available. Only ${compData.totalTickets - ticketsSoldBefore} left.`);
        ticketStartNumber = ticketsSoldBefore;
        transaction.update(compRef, { ticketsSold: ticketsSoldBefore + ticketsBought });
        transaction.update(userRef, { [`entryCount.${compId}`]: userEntryCount + ticketsBought });
        const entryRef = compRef.collection('entries').doc();
        transaction.set(entryRef, { userId: uid, userDisplayName: userData.displayName || "N/A", ticketsBought, ticketStart: ticketStartNumber, ticketEnd: ticketStartNumber + ticketsBought - 1, enteredAt: FieldValue.serverTimestamp(), entryType: 'paid' });
        if (compData.instantWinsConfig?.enabled) {
            const instantWinsRef = compRef.collection('instant_wins');
            for (let i = 0; i < ticketsBought; i++) {
                const currentTicketNumber = ticketStartNumber + i;
                const winDocRef = instantWinsRef.doc(String(currentTicketNumber));
                const winDoc = await transaction.get(winDocRef);
                if (winDoc.exists() && winDoc.data().claimed === false) {
                    transaction.update(winDocRef, { claimed: true, claimedBy: uid, claimedAt: FieldValue.serverTimestamp() });
                    wonPrizes.push({ ticketNumber: currentTicketNumber, prizeValue: winDoc.data().prizeValue });
                }
            }
        }
        return { success: true, ticketStart: ticketStartNumber, ticketsBought, wonPrizes };
    });
    return result;
});


/**
 * Draws a winner for a closed competition.
 */
exports.drawWinner = createCallable(async (data, context) => {
    await assertIsAdmin(context);
    const { compId } = data;
    if (!compId) throw new HttpsError('invalid-argument', 'Competition ID is required.');
    const compRef = db.collection('competitions').doc(compId);
    const result = await db.runTransaction(async (transaction) => {
        const compDoc = await transaction.get(compRef);
        if (!compDoc.exists()) throw new HttpsError('not-found', 'Competition not found.');
        const compData = compDoc.data();
        if (compData.status !== 'ended') throw new HttpsError('failed-precondition', 'Competition must be ended before drawing a winner.');
        if (compData.winnerId) throw new HttpsError('failed-precondition', 'A winner has already been drawn for this competition.');
        if (!compData.ticketsSold || compData.ticketsSold === 0) throw new HttpsError('failed-precondition', 'Cannot draw a winner for a competition with no entries.');
        const winningTicketNumber = crypto.randomInt(0, compData.ticketsSold);
        const entriesRef = compRef.collection('entries');
        const winnerQuery = db.collection(entriesRef.path).where('ticketStart', '<=', winningTicketNumber).orderBy('ticketStart', 'desc').limit(1);
        const winnerSnapshot = await winnerQuery.get();
        if (winnerSnapshot.empty) throw new HttpsError('internal', `Could not find an owner for the winning ticket #${winningTicketNumber}.`);
        const winnerEntryDoc = winnerSnapshot.docs[0];
        const winnerData = winnerEntryDoc.data();
        const winnerId = winnerData.userId;
        const winnerDisplayName = winnerData.userDisplayName;
        const winnerUserDoc = await db.collection('users').doc(winnerId).get();
        const winnerPhotoURL = winnerUserDoc.exists() ? winnerUserDoc.data().photoURL : null;
        transaction.update(compRef, { status: 'drawn', winnerId, winnerDisplayName, winningTicketNumber, drawnAt: FieldValue.serverTimestamp() });
        const pastWinnerRef = db.collection('pastWinners').doc(compId);
        transaction.set(pastWinnerRef, { prizeTitle: compData.title, prizeImage: compData.prizeImage, winnerId, winnerDisplayName, winnerPhotoURL, winningTicketNumber, drawDate: FieldValue.serverTimestamp() });
        return { success: true, winnerDisplayName, winningTicketNumber };
    });
    return result;
});
