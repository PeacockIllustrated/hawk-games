const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {logger} = require("firebase-functions");

const db = getFirestore();

// Helper to get the date string in YYYYMMDD format from a Firestore Timestamp
/**
 * Converts a Firestore Timestamp to a YYYYMMDD string.
 * @param {import("firebase-admin/firestore").Timestamp} timestamp The timestamp.
 * @return {string} The formatted date string.
 */
function getYYYYMMDD(timestamp) {
  const date = timestamp.toDate();
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

// --- Rollup Triggers ---

/**
 * Triggered when a new payment document is created.
 * Rolls up payment data into daily and global aggregates.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").QueryDocumentSnapshot | undefined>} event The event.
 * @return {Promise<null>} A promise that resolves when the rollup is complete.
 */
exports.onPaymentCreate = onDocumentCreated("payments/{paymentId}", async (event) => {
  const paymentData = event.data.data();

  // Don't process failed payments
  if (paymentData.status !== "captured") {
    logger.log(`Payment ${event.params.paymentId} has status ${paymentData.status}, skipping rollup.`);
    return null;
  }

  const dateStr = getYYYYMMDD(paymentData.createdAt);
  const dailyRef = db.collection("analytics_daily").doc(dateStr);
  const totalsRef = db.collection("analytics_totals").doc("global");

  const incrementPayload = {
    grossCashIn: FieldValue.increment(paymentData.amountGross),
    fees: FieldValue.increment(paymentData.amountFee),
    netCashIn: FieldValue.increment(paymentData.amountNet),
    [`byGameType.${paymentData.source}.gmv`]:
      FieldValue.increment(paymentData.amountGross),
    [`byGameType.${paymentData.source}.gmvCashFunded`]:
      FieldValue.increment(paymentData.amountGross),
  };

  try {
    await db.runTransaction(async (transaction) => {
      transaction.set(dailyRef, incrementPayload, {merge: true});
      transaction.set(totalsRef, incrementPayload, {merge: true});
    });
    logger.log(`Successfully rolled up payment ${event.params.paymentId} for date ${dateStr}.`);
  } catch (error) {
    logger.error(`Error rolling up payment ${event.params.paymentId}:`, error);
  }

  return null;
});

// --- Backfill and Sanity Check ---
const {onCall} = require("firebase-functions/v2/https");

/**
 * A callable function to backfill analytics data.
 * This is a simplified version for demonstration purposes.
 * @param {import("firebase-functions/v2/https").CallableRequest} request The request.
 * @return {Promise<{success: boolean, message: string}>} A promise that resolves with a success message.
 */
exports.backfillAnalytics = onCall({memory: "1GiB"}, async (request) => {
  // NOTE: This is a simplified backfill for demonstration.
  // A production-ready version would need more robust date handling,
  // error checking, and batching for all collections.

  // For now, it just re-calculates the 'global' total document from scratch.
  logger.log("Starting analytics backfill process...");

  const totalsRef = db.collection("analytics_totals").doc("global");

  // Reset totals
  await totalsRef.set({});

  // Process all payments
  const paymentsSnapshot = await db.collection("payments")
      .where("status", "==", "captured").get();
  for (const doc of paymentsSnapshot.docs) {
    const paymentData = doc.data();
    const incrementPayload = {
      grossCashIn: FieldValue.increment(paymentData.amountGross),
      fees: FieldValue.increment(paymentData.amountFee),
      netCashIn: FieldValue.increment(paymentData.amountNet),
      [`byGameType.${paymentData.source}.gmv`]:
        FieldValue.increment(paymentData.amountGross),
      [`byGameType.${paymentData.source}.gmvCashFunded`]:
        FieldValue.increment(paymentData.amountGross),
    };
    await totalsRef.set(incrementPayload, {merge: true});
  }
  logger.log(`Backfilled ${paymentsSnapshot.size} payments.`);

  // Process all site credit ledger entries
  const creditLedgerSnapshot = await db.collection("site_credit_ledger").get();
  for (const doc of creditLedgerSnapshot.docs) {
    const ledgerEntry = doc.data();
    const incrementPayload = {};
    if (ledgerEntry.delta > 0) {
      incrementPayload.creditIssued = FieldValue.increment(ledgerEntry.delta);
    } else {
      incrementPayload.creditRedeemed =
        FieldValue.increment(Math.abs(ledgerEntry.delta));
    }
    if (ledgerEntry.reason === "redeem_entry") {
      incrementPayload.gmvCreditFunded =
        FieldValue.increment(Math.abs(ledgerEntry.delta));
      incrementPayload.entriesCountCredit = FieldValue.increment(1);
    }
    if (Object.keys(incrementPayload).length > 0) {
      await totalsRef.set(incrementPayload, {merge: true});
    }
  }
  logger.log(`Backfilled ${creditLedgerSnapshot.size} site credit entries.`);

  // Process all prizes
  const prizeLedgerSnapshot = await db.collection("prize_ledger").get();
  for (const doc of prizeLedgerSnapshot.docs) {
    const prizeData = doc.data();
    const incrementPayload = {
      cashPrizesPaid: FieldValue.increment(prizeData.cashAmount || 0),
      cogs: FieldValue.increment(prizeData.cogsAmount || 0),
      shipping: FieldValue.increment(prizeData.shippingCost || 0),
    };
    if (prizeData.gameType === "spinner" && prizeData.type === "cash") {
      incrementPayload.spinnerCashPrizes =
        FieldValue.increment(prizeData.cashAmount || 0);
    }
    await totalsRef.set(incrementPayload, {merge: true});
  }
  logger.log(`Backfilled ${prizeLedgerSnapshot.size} prize entries.`);

  // Process all spins
  const spinsSnapshot = await db.collection("spins").get();
  for (const doc of spinsSnapshot.docs) {
    const spinData = doc.data();
    const incrementPayload = {
      spinsSoldCash: FieldValue.increment(spinData.priceCash > 0 ? 1 : 0),
      spinnerCashSales: FieldValue.increment(spinData.priceCash || 0),
    };
    await totalsRef.set(incrementPayload, {merge: true});
  }
  logger.log(`Backfilled ${spinsSnapshot.size} spin entries.`);

  return {success: true, message: "Global analytics totals have been backfilled."};
});

/**
 * Triggered when a new prize ledger document is created.
 * Rolls up prize data into daily and global aggregates.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").QueryDocumentSnapshot | undefined>} event The event.
 * @return {Promise<null>} A promise that resolves when the rollup is complete.
 */
exports.onPrizeLedgerCreate = onDocumentCreated("prize_ledger/{prizeId}", async (event) => {
  const prizeData = event.data.data();
  const dateStr = getYYYYMMDD(prizeData.createdAt);

  const dailyRef = db.collection("analytics_daily").doc(dateStr);
  const totalsRef = db.collection("analytics_totals").doc("global");

  const incrementPayload = {
    cashPrizesPaid: FieldValue.increment(prizeData.cashAmount || 0),
    cogs: FieldValue.increment(prizeData.cogsAmount || 0),
    shipping: FieldValue.increment(prizeData.shippingCost || 0),
  };

  // Spinner-specific metrics
  if (prizeData.gameType === "spinner" && prizeData.type === "cash") {
    incrementPayload.spinnerCashPrizes =
      FieldValue.increment(prizeData.cashAmount || 0);
  }

  try {
    await db.runTransaction(async (transaction) => {
      transaction.set(dailyRef, incrementPayload, {merge: true});
      transaction.set(totalsRef, incrementPayload, {merge: true});
    });
    logger.log(`Successfully rolled up prize ${event.params.prizeId} for date ${dateStr}.`);
  } catch (error) {
    logger.error(`Error rolling up prize ${event.params.prizeId}:`, error);
  }

  return null;
});

/**
 * Triggered when a new spin document is created.
 * Rolls up spin data into daily and global aggregates.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").QueryDocumentSnapshot | undefined>} event The event.
 * @return {Promise<null>} A promise that resolves when the rollup is complete.
 */
exports.onSpinCreate = onDocumentCreated("spins/{spinId}", async (event) => {
  const spinData = event.data.data();
  const dateStr = getYYYYMMDD(spinData.createdAt);

  const dailyRef = db.collection("analytics_daily").doc(dateStr);
  const totalsRef = db.collection("analytics_totals").doc("global");

  const incrementPayload = {
    spinsSoldCash: FieldValue.increment(spinData.priceCash > 0 ? 1 : 0),
    spinnerCashSales: FieldValue.increment(spinData.priceCash || 0),
  };

  try {
    await db.runTransaction(async (transaction) => {
      transaction.set(dailyRef, incrementPayload, {merge: true});
      transaction.set(totalsRef, incrementPayload, {merge: true});
    });
    logger.log(`Successfully rolled up spin ${event.params.spinId} for date ${dateStr}.`);
  } catch (error) {
    logger.error(`Error rolling up spin ${event.params.spinId}:`, error);
  }

  return null;
});

/**
 * Triggered when a new site credit ledger document is created.
 * Rolls up site credit data into daily and global aggregates.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").QueryDocumentSnapshot | undefined>} event The event.
 * @return {Promise<null>} A promise that resolves when the rollup is complete.
 */
exports.onSiteCreditLedgerCreate = onDocumentCreated("site_credit_ledger/{entryId}", async (event) => {
  const ledgerEntry = event.data.data();
  const dateStr = getYYYYMMDD(ledgerEntry.createdAt);

  const dailyRef = db.collection("analytics_daily").doc(dateStr);
  const totalsRef = db.collection("analytics_totals").doc("global");

  const incrementPayload = {};
  if (ledgerEntry.delta > 0) {
    incrementPayload.creditIssued = FieldValue.increment(ledgerEntry.delta);
  } else {
    incrementPayload.creditRedeemed =
      FieldValue.increment(Math.abs(ledgerEntry.delta));
  }

  // Also update GMV for credit-funded entries
  if (ledgerEntry.reason === "redeem_entry") {
    incrementPayload.gmvCreditFunded =
      FieldValue.increment(Math.abs(ledgerEntry.delta));
    incrementPayload.entriesCountCredit = FieldValue.increment(1);
  }

  if (Object.keys(incrementPayload).length === 0) {
    logger.log(`Site credit entry ${event.params.entryId} had no values to rollup, skipping.`);
    return null;
  }

  try {
    await db.runTransaction(async (transaction) => {
      transaction.set(dailyRef, incrementPayload, {merge: true});
      transaction.set(totalsRef, incrementPayload, {merge: true});
    });
    logger.log(`Successfully rolled up site credit entry ${event.params.entryId} for date ${dateStr}.`);
  } catch (error) {
    logger.error(`Error rolling up site credit entry ${event.params.entryId}:`, error);
  }

  return null;
});
