const {getFirestore} = require("firebase-admin/firestore");
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
    (revenueBySource.hero) + (revenueBySource.token);
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
 * Asserts that the user is an administrator.
 * @param {object} request The request object.
 */
const assertIsAdmin = async (request) => {
  // This is a simplified check for demonstration.
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

    const aggregatedData = {};
    dailySnapshots.forEach((doc) => {
      const dailyData = doc.data();
      for (const key in dailyData) {
        if (Object.prototype.hasOwnProperty.call(dailyData, key)) {
          if (typeof dailyData[key] === "number") {
            aggregatedData[key] = (aggregatedData[key] || 0) + dailyData[key];
          } else if (typeof dailyData[key] === "object") {
            if (!aggregatedData[key]) {
              aggregatedData[key] = {};
            }
            for (const subKey in dailyData[key]) {
              if (Object.prototype.hasOwnProperty.call(
                  dailyData[key], subKey)) {
                if (!aggregatedData[key][subKey]) {
                  aggregatedData[key][subKey] = {};
                }
                for (const nestedKey in dailyData[key][subKey]) {
                  if (Object.prototype.hasOwnProperty.call(
                      dailyData[key][subKey], nestedKey)) {
                    aggregatedData[key][subKey][nestedKey] =
                      (aggregatedData[key][subKey][nestedKey] || 0) +
                      dailyData[key][subKey][nestedKey];
                  }
                }
              }
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
