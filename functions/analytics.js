const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {logger} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");

const db = getFirestore();

/**
 * Converts a Date object or a Firestore Timestamp to a YYYYMMDD string.
 * @param {Date|import("firebase-admin/firestore").Timestamp} dateOrTimestamp The
 * date or timestamp.
 * @return {string} The formatted date string.
 */
function getYYYYMMDD(dateOrTimestamp) {
  const date = dateOrTimestamp.toDate ?
    dateOrTimestamp.toDate() :
    dateOrTimestamp;
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * Processes raw analytics data into the format expected by the frontend.
 * @param {object} data The raw analytics data from Firestore.
 * @return {object} The processed analytics data.
 */
function processAnalyticsData(data) {
  const revenueBySource = {
    main: data.byGameType?.main?.gmvCashFunded || 0,
    instant: data.byGameType?.instant?.gmvCashFunded || 0,
    hero: data.byGameType?.hero?.gmvCashFunded || 0,
    token: data.byGameType?.token?.gmvCashFunded || 0,
    other: data.byGameType?.other?.gmvCashFunded || 0,
  };

  const spinnerTokenRevenue = (revenueBySource.instant) +
    (revenueBySource.hero) + (revenueBySource.token) +
    (data.spinnerCashSales || 0);
  const totalCashCost = data.spinnerCashPrizes || 0;
  const netProfit = spinnerTokenRevenue - totalCashCost;

  return {
    revenueBySource,
    revenueFromSiteCredit: data.gmvCreditFunded || 0,
    spinnerTokenRevenue,
    totalCashCost,
    totalSiteCreditAwarded: data.creditIssued || 0,
    netProfit,
  };
}

/**
 * Asserts that the user is an administrator by checking the Firestore user doc.
 * @param {object} request The request object from the callable function.
 * @throws {HttpsError} If the user is not an admin.
 */
const assertIsAdmin = async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }
  const userDoc = await db.collection("users").doc(request.auth.uid).get();
  if (!userDoc.exists() || !userDoc.data().isAdmin) {
    throw new HttpsError(
        "permission-denied",
        "You must be an administrator to perform this action.",
    );
  }
};

exports.getRevenueAnalytics = onCall({
  enforceAppCheck: true,
}, async (request) => {
  await assertIsAdmin(request);
  const {dateRange} = request.data;

  try {
    if (dateRange === "lifetime") {
      const totalsSnap = await db
          .collection("analytics_totals")
          .doc("global")
          .get();
      if (!totalsSnap.exists) {
        throw new HttpsError("not-found",
            "Analytics totals document not found. Please run a backfill.");
      }
      const data = totalsSnap.data();
      return {success: true, ...processAnalyticsData(data)};
    }

    const endDate = new Date();
    const startDate = new Date();
    switch (dateRange) {
      case "30d":
        startDate.setDate(endDate.getDate() - 30);
        break;
      case "7d":
        startDate.setDate(endDate.getDate() - 7);
        break;
      case "today":
        break;
      default:
        throw new HttpsError("invalid-argument",
            "Invalid date range specified.");
    }

    const startStr = getYYYYMMDD(startDate);
    const endStr = getYYYYMMDD(endDate);

    const dailyQuery = db
        .collection("analytics_daily")
        .where(db.FieldPath.documentId(), ">=", startStr)
        .where(db.FieldPath.documentId(), "<=", endStr);

    const dailySnapshots = await dailyQuery.get();

    if (dailySnapshots.empty) {
      return {success: true, ...processAnalyticsData({})};
    }

    const aggregatedData = {
      byGameType: {
        main: {gmv: 0, gmvCashFunded: 0},
        instant: {gmv: 0, gmvCashFunded: 0},
        hero: {gmv: 0, gmvCashFunded: 0},
        token: {gmv: 0, gmvCashFunded: 0},
        other: {gmv: 0, gmvCashFunded: 0},
      },
    };
    const topLevelKeys = [
      "grossCashIn", "fees", "netCashIn", "creditIssued", "creditRedeemed",
      "gmvCreditFunded", "entriesCountCredit", "cashPrizesPaid", "cogs",
      "shipping", "spinnerCashPrizes", "spinsSoldCash", "spinnerCashSales",
    ];
    dailySnapshots.forEach((doc) => {
      const dailyData = doc.data();
      for (const key of topLevelKeys) {
        if (typeof dailyData[key] === "number") {
          aggregatedData[key] = (aggregatedData[key] || 0) + dailyData[key];
        }
      }
      if (dailyData.byGameType) {
        for (const gameType in aggregatedData.byGameType) {
          if (dailyData.byGameType[gameType]) {
            const dailySource = dailyData.byGameType[gameType];
            const aggregatedSource = aggregatedData.byGameType[gameType];
            if (typeof dailySource.gmv === "number") {
              aggregatedSource.gmv += dailySource.gmv;
            }
            if (typeof dailySource.gmvCashFunded === "number") {
              aggregatedSource.gmvCashFunded += dailySource.gmvCashFunded;
            }
          }
        }
      }
    });

    return {success: true, ...processAnalyticsData(aggregatedData)};
  } catch (error) {
    logger.error("Error fetching revenue analytics:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal",
        "An unexpected error occurred while fetching analytics: " +
        error.message);
  }
});

exports.onPaymentCreate = onDocumentCreated("payments/{paymentId}",
    async (event) => {
      const paymentData = event.data.data();

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

exports.onSiteCreditLedgerCreate = onDocumentCreated("site_credit_ledger/{entryId}",
    async (event) => {
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

exports.onPrizeLedgerCreate = onDocumentCreated("prize_ledger/{prizeId}",
    async (event) => {
      const prizeData = event.data.data();
      const dateStr = getYYYYMMDD(prizeData.createdAt);

      const dailyRef = db.collection("analytics_daily").doc(dateStr);
      const totalsRef = db.collection("analytics_totals").doc("global");

      const incrementPayload = {
        cashPrizesPaid: FieldValue.increment(prizeData.cashAmount || 0),
        cogs: FieldValue.increment(prizeData.cogsAmount || 0),
        shipping: FieldValue.increment(prizeData.shippingCost || 0),
      };

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

exports.backfillAnalytics = onCall({memory: "1GiB"}, async (request) => {
  logger.log("Starting analytics backfill process...");

  const totalsRef = db.collection("analytics_totals").doc("global");

  await totalsRef.set({});

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

  const creditLedgerSnapshot =
    await db.collection("site_credit_ledger").get();
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

  return {success: true,
    message: "Global analytics totals have been backfilled."};
});
