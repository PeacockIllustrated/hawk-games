const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const crypto = require("crypto");

// sha256 is not a built-in crypto function in Node, so we implement it.
const { createHash } = require("crypto");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

initializeApp();
const db = getFirestore();

// Helper to check if the caller is an admin
const assertIsAdmin = async (auth) => {
    if (!auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to call this function.');
    }
    const userDoc = await db.collection('users').doc(auth.uid).get();
    if (!userDoc.exists() || !userDoc.data().isAdmin) {
        throw new HttpsError('permission-denied', 'You must be an admin to perform this action.');
    }
};

/**
 * Seeds a competition with securely generated instant win ticket numbers.
 * Only callable by admins.
 */
exports.seedInstantWins = onCall(async (request) => {
    await assertIsAdmin(request.auth);
    const { compId, instantWinPrizes, totalTickets } = request.data;
    if (!compId || !instantWinPrizes || !totalTickets) {
        throw new HttpsError('invalid-argument', 'Missing required parameters.');
    }

    const totalPrizeCount = instantWinPrizes.reduce((sum, tier) => sum + tier.count, 0);
    if (totalPrizeCount > totalTickets) {
        throw new HttpsError('invalid-argument', 'Total number of instant prizes cannot exceed the total number of tickets.');
    }

    // 1. Generate unique winning ticket numbers using a Cryptographically Secure PRNG
    const winningPicks = new Set();
    while (winningPicks.size < totalPrizeCount) {
        winningPicks.add(crypto.randomInt(0, totalTickets));
    }
    const sortedWinningNumbers = Array.from(winningPicks).sort((a, b) => a - b);
    
    // 2. Create the commit-reveal hash for provable fairness
    const salt = crypto.randomBytes(16).toString('hex');
    const positionsToHash = JSON.stringify(sortedWinningNumbers);
    const hash = sha256(positionsToHash + ':' + salt);

    const batch = db.batch();

    // 3. Create the instant_wins documents, keyed by ticket number for fast lookups
    const instantWinsRef = db.collection('competitions').doc(compId).collection('instant_wins');
    let prizeCursor = 0;
    instantWinPrizes.forEach(tier => {
        for (let i = 0; i < tier.count; i++) {
            const ticketNumber = sortedWinningNumbers[prizeCursor++];
            const docRef = instantWinsRef.doc(String(ticketNumber));
            batch.set(docRef, {
                ticketNumber: ticketNumber,
                prizeValue: tier.value,
                claimed: false,
                claimedBy: null,
                claimedAt: null,
            });
        }
    });
    
    // 4. Update the main competition document with the config and fairness hash
    const compRef = db.collection('competitions').doc(compId);
    batch.update(compRef, {
        'instantWinsConfig.enabled': true,
        'instantWinsConfig.prizes': instantWinPrizes,
        'instantWinsConfig.positionsHash': hash,
        'instantWinsConfig.generator': 'v2-csprng-salt',
    });
    
    // 5. Store the salt securely on the server (inaccessible to clients)
    const serverMetaRef = compRef.collection('server_meta').doc('fairness_reveal');
    batch.set(serverMetaRef, { salt, positions: sortedWinningNumbers });
    
    await batch.commit();

    return { success: true, positionsHash: hash };
});


/**
 * Atomically allocates tickets to a user and checks for instant wins.
 * This is the primary entry transaction. Callable by any authenticated user.
 */
exports.allocateTicketsAndCheckWins = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError('unauthenticated', 'You must be logged in to enter.');
    }

    const { compId, ticketsBought } = request.data;
    if (!compId || !ticketsBought || ticketsBought <= 0) {
        throw new HttpsError('invalid-argument', 'Competition ID and number of tickets are required.');
    }

    const compRef = db.collection('competitions').doc(compId);
    const userRef = db.collection('users').doc(uid);
    const wonPrizes = [];
    let ticketStartNumber;

    try {
        await db.runTransaction(async (transaction) => {
            const compDoc = await transaction.get(compRef);
            const userDoc = await transaction.get(userRef);

            if (!compDoc.exists()) throw new HttpsError('not-found', 'Competition not found.');
            if (!userDoc.exists()) throw new HttpsError('not-found', 'User profile not found.');

            const compData = compDoc.data();
            const userData = userDoc.data();

            // Validations
            if (compData.status !== 'live') throw new HttpsError('failed-precondition', 'This competition is no longer live.');
            
            // CORRECTED LINE: Check if endDate exists before trying to use it.
            if (compData.endDate && compData.endDate.toDate() < new Date()) {
                throw new HttpsError('failed-precondition', 'This competition has ended.');
            }

            const userEntryCount = userData.entryCount?.[compId] || 0;
            const limit = compData.userEntryLimit || 75;
            if (userEntryCount + ticketsBought > limit) {
                throw new HttpsError('failed-precondition', `Entry limit exceeded. You can enter ${limit - userEntryCount} more times.`);
            }

            const ticketsSoldBefore = compData.ticketsSold || 0;
            if (ticketsSoldBefore + ticketsBought > compData.totalTickets) {
                throw new HttpsError('failed-precondition', `Not enough tickets available. Only ${compData.totalTickets - ticketsSoldBefore} left.`);
            }

            ticketStartNumber = ticketsSoldBefore;

            // Perform all writes within the transaction
            transaction.update(compRef, { ticketsSold: ticketsSoldBefore + ticketsBought });
            transaction.update(userRef, { [`entryCount.${compId}`]: userEntryCount + ticketsBought });
            
            const entryRef = compRef.collection('entries').doc();
            transaction.set(entryRef, {
                userId: uid,
                userDisplayName: userData.displayName || "N/A",
                ticketsBought: ticketsBought,
                ticketStart: ticketStartNumber,
                ticketEnd: ticketStartNumber + ticketsBought - 1,
                enteredAt: FieldValue.serverTimestamp(),
                entryType: 'paid'
            });

            if (compData.instantWinsConfig?.enabled) {
                const instantWinsRef = compRef.collection('instant_wins');
                for (let i = 0; i < ticketsBought; i++) {
                    const currentTicketNumber = ticketStartNumber + i;
                    const winDocRef = instantWinsRef.doc(String(currentTicketNumber));
                    const winDoc = await transaction.get(winDocRef);
                    if (winDoc.exists && winDoc.data().claimed === false) {
                        transaction.update(winDocRef, {
                            claimed: true,
                            claimedBy: uid,
                            claimedAt: FieldValue.serverTimestamp()
                        });
                        wonPrizes.push({
                            ticketNumber: currentTicketNumber,
                            prizeValue: winDoc.data().prizeValue
                        });
                    }
                }
            }
        });

        return {
            success: true,
            ticketStart: ticketStartNumber,
            ticketsBought: ticketsBought,
            wonPrizes: wonPrizes
        };

    } catch (error) {
        console.error("Transaction failed:", error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError('internal', 'An error occurred while processing your entry. Please try again.');
    }
});
