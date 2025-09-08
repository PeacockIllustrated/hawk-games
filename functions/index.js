// Firebase Functions v2 (CommonJS) + Admin SDK
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {getFirestore, FieldValue, Timestamp} = require("firebase-admin/firestore");
const {initializeApp} = require("firebase-admin/app");
const {defineSecret} = require("firebase-functions/params");
const crypto = require("crypto");
const {z} = require("zod");
const {logger} = require("firebase-functions");

initializeApp();
const db = getFirestore();

/* ============================
   TRUST PAYMENTS — CONSTANTS & SECRETS
   ============================ */

// Known defaults from your Trust account + site. These are used if secrets are unset.
const DEFAULT_LIVE_SITE_REF = "thehawkgam142859";
const DEFAULT_TEST_SITE_REF = "test_thehawkgam142858";
const DEFAULT_SUCCESS_URL = "https://the-hawk-games.co.uk/app/success.html";
const DEFAULT_CANCEL_URL = "https://the-hawk-games.co.uk/app/cancel.html";

// Secrets (set with: firebase functions:secrets:set NAME --data="value")
const TRUST_MODE = defineSecret("TRUST_MODE"); // "test" | "live"
const TRUST_SITEREFERENCE = defineSecret("TRUST_SITEREFERENCE"); // live
const TRUST_TEST_SITEREFERENCE = defineSecret("TRUST_TEST_SITEREFERENCE"); // test
const TRUST_NOTIFY_PASSWORD = defineSecret("TRUST_NOTIFY_PASSWORD"); // required
const RETURN_URL_SUCCESS = defineSecret("RETURN_URL_SUCCESS");
const RETURN_URL_CANCEL = defineSecret("RETURN_URL_CANCEL");
const NOTIFICATION_URL = defineSecret("NOTIFICATION_URL"); // required (webhook URL)

// Helpers (Trust)
const asGBP = (pence) => (pence / 100).toFixed(2);

function priceTicketsFromComp(comp, qty) {
  if (!Array.isArray(comp.ticketTiers) || comp.ticketTiers.length === 0) {
    throw new HttpsError("failed-precondition", "Pricing not configured.");
  }

  // Find the base price per ticket from the first tier
  const basePricePerTicket = comp.ticketTiers[0].price / comp.ticketTiers[0].amount;

  const totalPrice = qty * basePricePerTicket;
  const totalPence = Math.round(totalPrice * 100);

  return {totalPence, tierPrice: totalPrice};
}

function buildHppFields({
  siteRef,
  orderId,
  amountPence,
  successUrl,
  cancelUrl,
  notifyUrl,
  user
}) {
  // helper: add/replace a query param in a URL
  const withParam = (url, key, value) => {
    try {
      const u = new URL(url);
      if (!u.searchParams.has(key)) u.searchParams.append(key, value);
      else u.searchParams.set(key, value);
      return u.toString();
    } catch {
      // fallback if a bare path somehow slips in
      const sep = url.includes("?") ? "&" : "?";
      return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
  };

  const successWithId = withParam(successUrl, "orderId", orderId);
  const cancelWithId  = withParam(cancelUrl,  "orderId", orderId);

  return {
    // REQUIRED
    sitereference: siteRef,
    orderreference: orderId,
    currencyiso3a: "GBP",
    mainamount: asGBP(amountPence), // e.g. "2.99" or "0.01"

    // Advanced Redirect (ensures STR-6/7 work & keeps ?orderId=...)
    successfulurlredirect: successWithId,
    declinedurlredirect:   cancelWithId,
    successfulurlredirectmethod: "GET",
    declinedurlredirectmethod:   "GET",

    // Webhook / URL notification (ensures STR-10 fires)
    allurlnotification: notifyUrl || "",

    // Legacy aliases (harmless; some configs read these)
    success_url: successWithId,
    cancel_url:  cancelWithId,
    notification_url: notifyUrl || "",

    // Optional niceties for the HPP
    billingemail:     user?.email || "",
    billingfirstname: user?.displayName?.split(" ")[0] || "",
    billinglastname:  (user?.displayName?.split(" ").slice(1).join(" ") || "")
  };
}



async function fulfilOrderTickets(orderId) {
  const orderRef = db.collection("orders").doc(orderId);

  await db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error("Order not found");
    const order = orderSnap.data();

    if (order.status !== "paid") {
      // Only fulfil after paid; tolerate re-entrancy (webhook may race)
      throw new Error("Order not paid");
    }
    if (order.fulfilled === true) return; // idempotent

    // Expect first item to be tickets
    const item = order.items && order.items[0];
    if (!item || item.kind !== "tickets") throw new Error("Unsupported order item");

    const compRef = db.collection("competitions").doc(item.compId);
    const compSnap = await tx.get(compRef);
    if (!compSnap.exists) throw new Error("Competition not found");
    const comp = compSnap.data();

    const qty = Number(item.qty || 0);
    if (!(qty > 0)) throw new Error("Invalid quantity");

    // Your existing entries are zero-based: ticketStart = current sold
    const ticketsSoldBefore = Number(comp.ticketsSold || 0);
    const ticketStart = ticketsSoldBefore;
    const ticketEnd = ticketStart + qty - 1;

    if (ticketEnd >= Number(comp.totalTickets)) {
      throw new Error("Sold out during fulfilment");
    }

    const entryRef = compRef.collection("entries").doc();
    tx.set(entryRef, {
      userId: order.userId,
      userDisplayName: order.userDisplayName || "N/A",
      orderId,
      ticketsBought: qty,
      ticketStart,
      ticketEnd,
      enteredAt: FieldValue.serverTimestamp(),
      entryType: "paid",
      paymentMethod: "card",
      provider: "trust",
      providerRef: order.providerRef || null,
    });

    tx.update(compRef, {ticketsSold: FieldValue.increment(qty)});

    tx.update(orderRef, {
      fulfilled: true,
      fulfilledAt: FieldValue.serverTimestamp(),
    });

    // Optional: user payments ledger
    const payRef = db.collection("users").doc(order.userId).collection("payments").doc();
    tx.set(payRef, {
      orderId,
      provider: "trust",
      providerRef: order.providerRef || null,
      amountPence: order.amountPence,
      status: "paid",
      createdAt: FieldValue.serverTimestamp(),
    });
  });
}

/* ============================
   EXISTING DRAW LOGIC (unchanged)
   ============================ */
const performDraw = async (compId) => {
  const compRef = db.collection("competitions").doc(compId);
  const entriesRef = compRef.collection("entries");

  const compDocForCheck = await compRef.get();
  if (!compDocForCheck.exists) throw new Error(`Competition ${compId} not found for drawing.`);

  const compDataForCheck = compDocForCheck.data();
  if (compDataForCheck.status !== "ended") throw new Error(`Competition ${compId} must be in 'ended' status to be drawn.`);
  if (compDataForCheck.winnerId) throw new Error(`Winner already drawn for competition ${compId}.`);
  if (!compDataForCheck.ticketsSold || compDataForCheck.ticketsSold === 0) {
    await compRef.update({status: "drawn", drawnAt: FieldValue.serverTimestamp(), winnerDisplayName: "No entries"});
    logger.warn(`Competition ${compId} had no entries. Marked as drawn.`);
    return {success: true, winnerDisplayName: "No entries", winningTicketNumber: -1};
  }

  const winningTicketNumber = crypto.randomInt(0, compDataForCheck.ticketsSold); // [0, sold)
  const winnerQuery = entriesRef.where("ticketStart", "<=", winningTicketNumber).orderBy("ticketStart", "desc").limit(1);
  const winnerSnapshot = await winnerQuery.get();

  if (winnerSnapshot.empty) throw new Error(`Could not find an entry for winning ticket number ${winningTicketNumber} in competition ${compId}.`);

  const winnerEntryDoc = winnerSnapshot.docs[0];
  const winnerData = winnerEntryDoc.data();
  const winnerId = winnerData.userId;

  return await db.runTransaction(async (transaction) => {
    const winnerUserDocSnap = await db.collection("users").doc(winnerId).get();
    const winnerPhotoURL = winnerUserDocSnap.exists ? winnerUserDocSnap.data().photoURL : null;
    const winnerDisplayName = winnerData.userDisplayName;

    transaction.update(compRef, {
      status: "drawn",
      winnerId,
      winnerDisplayName,
      winningTicketNumber,
      drawnAt: FieldValue.serverTimestamp(),
    });

    const pastWinnerRef = db.collection("pastWinners").doc(compId);
    transaction.set(pastWinnerRef, {
      prizeTitle: compDataForCheck.title,
      prizeImage: compDataForCheck.prizeImage,
      winnerId,
      winnerDisplayName,
      winnerPhotoURL,
      winningTicketNumber,
      drawDate: FieldValue.serverTimestamp(),
    });

    return {success: true, winnerDisplayName, winningTicketNumber};
  });
};

/* ============================
   SHARED GUARDS & OPTIONS
   ============================ */
const assertIsAdmin = async (context) => {
  if (!context.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
  const userDoc = await db.collection("users").doc(context.auth.uid).get();
  if (!userDoc.exists || !userDoc.data().isAdmin) throw new HttpsError("permission-denied", "Admin privileges required.");
};
const assertIsAuthenticated = (context) => {
  if (!context.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
};

const functionOptions = {
  region: "us-central1",
  enforceAppCheck: true,
  cors: [    "https://the-hawk-games-64239.web.app",
    "https://the-hawk-games.co.uk",
    "https://the-hawk-games-staging.netlify.app",
    "http://localhost:5000",
    "http://127.0.0.1:5000"
  ],
};

/* ============================
   TRUST PAYMENTS — FUNCTIONS
   ============================ */

/**
 * createTrustOrder — callable
 * Validates the requested ticket bundle, snapshots an order, and returns HPP fields.
 * Client never sends price; server prices from competition config.
 */
exports.createTrustOrder = onCall(
  {
    ...functionOptions,
    secrets: [
      TRUST_SITEREFERENCE,
      TRUST_TEST_SITEREFERENCE,
      RETURN_URL_SUCCESS,
      RETURN_URL_CANCEL,
      NOTIFICATION_URL,
      TRUST_MODE,                // <-- include mode secret
    ],
  },
  async (request) => {
    assertIsAuthenticated(request);
    const uid = request.auth.uid;
    const token = request.auth.token || {};

    const schema = z.object({
      intent: z.object({
        type: z.literal("tickets"),
        compId: z.string().min(1),
        ticketsBought: z.number().int().positive(),
      }),
    });

    const parse = schema.safeParse(request.data || {});
    if (!parse.success) throw new HttpsError("invalid-argument", "Invalid intent.");
    const { compId, ticketsBought } = parse.data.intent;

    const compRef = db.collection("competitions").doc(compId);
    const compSnap = await compRef.get();
    if (!compSnap.exists) throw new HttpsError("not-found", "Competition not found");
    const comp = compSnap.data();

    // Availability guard (final guard is in fulfilment)
    const sold = Number(comp.ticketsSold || 0);
    const total = Number(comp.totalTickets || 0);
    if (sold + ticketsBought > total) {
      throw new HttpsError("failed-precondition", "Not enough tickets remaining.");
    }

    // Price by selected bundle (uses your helper)
    const { totalPence } = priceTicketsFromComp(comp, ticketsBought);

    // --- Mode-aware site reference selection ---
    const liveRef = TRUST_SITEREFERENCE.value() || DEFAULT_LIVE_SITE_REF;
    const testRef = TRUST_TEST_SITEREFERENCE.value() || DEFAULT_TEST_SITE_REF;
    const mode = ((TRUST_MODE.value && TRUST_MODE.value()) || "test").toLowerCase();
    const useLive = mode === "live";
    const siteRef = useLive ? liveRef : testRef;

    // Create order snapshot
    const orderRef = db.collection("orders").doc();
    const orderDoc = {
      userId: uid,
      userDisplayName: token.name || null,
      type: "tickets",
      items: [{ kind: "tickets", compId, qty: ticketsBought }],
      amountPence: totalPence,
      currency: "GBP",
      status: "created",
      provider: "trust",
      env: useLive ? "live" : "test",
      isTest: !useLive,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await orderRef.set(orderDoc);

    // Build HPP fields
    const fields = buildHppFields({
      siteRef,
      orderId: orderRef.id,
      amountPence: totalPence,
      successUrl: RETURN_URL_SUCCESS.value() || DEFAULT_SUCCESS_URL,
      cancelUrl:  RETURN_URL_CANCEL.value()  || DEFAULT_CANCEL_URL,
      notifyUrl:  NOTIFICATION_URL.value()   || "", // should be set!
      user: { email: token.email || "", displayName: token.name || "" },
      success_url,                  // e.g. https://…/app/success.html?orderId=${orderRef.id}
      cancel_url,                   // e.g. https://…/app/cancel.html?orderId=${orderRef.id}
      successfulurlredirect: "1",   // <— REQUIRED for STR-6 “Advanced redirect browser to Success…”
      declinedurlredirect:   "1",   // <— REQUIRED for STR-7 “Advanced redirect browser to Declined…”
    });

    if (!fields.notification_url) {
      logger.warn("NOTIFICATION_URL secret is missing; set it to your trustWebhook URL.");
    }

    return {
      endpoint: "https://payments.securetrading.net/process/payments/details",
       orderId: orderRef.id, // <— add this
      fields,
    };
  }
);


/**
 * trustWebhook — onRequest
 * Verifies notification password, updates order status, and fulfils tickets idempotently.
 */
exports.trustWebhook = onRequest(
    {region: "us-central1", secrets: [TRUST_NOTIFY_PASSWORD]},
    async (req, res) => {
      try {
      // Parse form-encoded if necessary
        let payload = {};
        if (req.body && Object.keys(req.body).length) {
          payload = req.body;
        } else if (req.rawBody && req.rawBody.length) {
          const s = req.rawBody.toString("utf8");
          const params = new URLSearchParams(s);
          for (const [k, v] of params.entries()) payload[k] = v;
        }

        const pw = payload.notification_password || payload.notificationpassword || payload.password || "";
        if (!pw || pw !== TRUST_NOTIFY_PASSWORD.value()) {
          logger.warn("Webhook rejected: bad password");
          return res.status(403).send("Forbidden");
        }

        const orderId =
        payload.orderreference ||
        payload.orderReference ||
        payload.merchant_orderreference ||
        "";

        if (!orderId) {
          logger.error("Webhook missing orderreference", payload);
          return res.status(200).send("OK");
        }

        const paymentResult = String(
            payload.paymentresult || payload.payment_result || payload.errorcode || "",
        ).toLowerCase();

        const providerRef =
        payload.transactionreference ||
        payload.acquirertransactionreference ||
        payload.settlestatus ||
        "";

        const orderRef = db.collection("orders").doc(orderId);
        const orderSnap = await orderRef.get();
        if (!orderSnap.exists) {
          logger.error("Order not found for webhook", {orderId});
          return res.status(200).send("OK");
        }

        const order = orderSnap.data();
        if (["paid", "failed", "cancelled"].includes(order.status)) {
          return res.status(200).send("OK");
        }

        // Map Trust result to status
        let status = "failed";
        if (paymentResult === "success" || paymentResult === "y" || paymentResult === "approved") status = "paid";
        else if (paymentResult === "cancelled" || paymentResult === "c") status = "cancelled";

        await orderRef.update({
          status,
          providerRef,
          providerMeta: {
            paymentResult,
            receivedAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        });

        if (status === "paid") {
          try {
            await fulfilOrderTickets(orderId);
          } catch (e) {
            logger.error("Fulfilment error", {orderId, err: e?.message || e});
          // Keep status=paid; allow manual retry job if needed
          }
        }

        return res.status(200).send("OK");
      } catch (err) {
        logger.error("Webhook handler error", err);
        return res.status(200).send("OK");
      }
    },
);

/* ============================
   EXISTING BUSINESS FUNCTIONS
   ============================ */

// allocateTicketsAndAwardTokens
// UPDATED: expectedPrice now optional; for 'credit' we price server-side.
// For 'card' we reject (card is now via Trust HPP).
exports.allocateTicketsAndAwardTokens = onCall(functionOptions, async (request) => {
  const schema = z.object({
    compId: z.string().min(1),
    ticketsBought: z.number().int().positive(),
    expectedPrice: z.number().positive().optional(),
    paymentMethod: z.enum(["card", "credit"]).default("card"),
  });

  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", "Invalid or malformed request data.");
  }
  const {compId, ticketsBought, expectedPrice, paymentMethod} = validation.data;

  assertIsAuthenticated(request);
  const uid = request.auth.uid;
  const compRef = db.collection("competitions").doc(compId);
  const userRef = db.collection("users").doc(uid);

  // Card purchases are now handled via Trust HPP
  if (paymentMethod === "card") {
    throw new HttpsError("failed-precondition", "Card payments are processed via Trust Payments.");
  }

  return await db.runTransaction(async (transaction) => {
    const [compDoc, userDoc] = await Promise.all([transaction.get(compRef), transaction.get(userRef)]);
    if (!compDoc.exists) throw new HttpsError("not-found", "Competition not found.");
    if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
    const compData = compDoc.data();
    const userData = userDoc.data();

    // Calculate price based on base price per ticket
    if (!Array.isArray(compData.ticketTiers) || compData.ticketTiers.length === 0) {
      throw new HttpsError("failed-precondition", "Pricing not configured for this competition.");
    }
    const basePricePerTicket = compData.ticketTiers[0].price / compData.ticketTiers[0].amount;
    const priceToCharge = ticketsBought * basePricePerTicket;

    // For backward compatibility, if expectedPrice is provided and mismatched, reject
    if (typeof expectedPrice === "number" && expectedPrice !== priceToCharge) {
      throw new HttpsError("invalid-argument", "Price mismatch. Please refresh and try again.");
    }

    // CREDIT flow
    const entryType = "credit";
    const userCredit = Number(userData.creditBalance || 0);
    if (userCredit < priceToCharge) {
      throw new HttpsError("failed-precondition", "Insufficient credit balance.");
    }
    transaction.update(userRef, {creditBalance: FieldValue.increment(-priceToCharge)});

    if (compData.status !== "live") throw new HttpsError("failed-precondition", "Competition is not live.");
    const userEntryCount = (userData.entryCount && userData.entryCount[compId]) ? userData.entryCount[compId] : 0;
    const limit = compData.userEntryLimit || 75;
    if (userEntryCount + ticketsBought > limit) throw new HttpsError("failed-precondition", `Entry limit exceeded.`);
    const ticketsSoldBefore = compData.ticketsSold || 0;
    if (ticketsSoldBefore + ticketsBought > compData.totalTickets) throw new HttpsError("failed-precondition", `Not enough tickets available.`);
    const ticketStartNumber = ticketsSoldBefore;

    transaction.update(compRef, {ticketsSold: FieldValue.increment(ticketsBought)});
    transaction.update(userRef, {[`entryCount.${compId}`]: FieldValue.increment(ticketsBought)});

    const entryRef = compRef.collection("entries").doc();
    transaction.set(entryRef, {
      userId: uid, userDisplayName: userData.displayName || "N/A",
      ticketsBought, ticketStart: ticketStartNumber, ticketEnd: ticketStartNumber + ticketsBought - 1,
      enteredAt: FieldValue.serverTimestamp(),
      entryType: entryType,
    });

    let awardedTokens = [];
    if (compData.instantWinsConfig?.enabled === true) {
      const newTokens = [];
      const earnedAt = new Date();
      for (let i = 0; i < ticketsBought; i++) {
        newTokens.push({
          tokenId: crypto.randomBytes(16).toString("hex"),
          compId: compId,
          compTitle: compData.title,
          earnedAt: earnedAt,
        });
      }
      transaction.update(userRef, {spinTokens: FieldValue.arrayUnion(...newTokens)});
      awardedTokens = newTokens;
    }

    return {success: true, ticketStart: ticketStartNumber, ticketsBought, awardedTokens};
  });
});

// getRevenueAnalytics (unchanged)
exports.getRevenueAnalytics = onCall(functionOptions, async (request) => {
  await assertIsAdmin(request);

  const competitionsSnapshot = await db.collection("competitions").get();
  let totalRevenue = 0;

  for (const doc of competitionsSnapshot.docs) {
    const compId = doc.id;
    const entriesRef = db.collection("competitions").doc(compId).collection("entries");
    const entriesSnapshot = await entriesRef.where("entryType", "==", "paid").get();

    let competitionRevenue = 0;
    entriesSnapshot.forEach((entryDoc) => {
      const entryData = entryDoc.data();
      const competitionData = doc.data();
      const tier = competitionData.ticketTiers.find((t) => t.amount === entryData.ticketsBought);
      if (tier) {
        competitionRevenue += tier.price;
      }
    });
    totalRevenue += competitionRevenue;
  }

  const spinWinsSnapshot = await db.collection("spin_wins").where("prizeType", "==", "cash").get();
  let totalCost = 0;
  spinWinsSnapshot.forEach((doc) => {
    totalCost += doc.data().prizeValue;
  });

  const netProfit = totalRevenue - totalCost;

  const creditAwardedSnapshot = await db.collection("spin_wins").where("prizeType", "==", "credit").get();
  let totalSiteCreditAwarded = 0;
  creditAwardedSnapshot.forEach((doc) => {
    totalSiteCreditAwarded += doc.data().prizeValue;
  });

  const creditSpentSnapshot = await db.collectionGroup("entries").where("entryType", "==", "credit").get();
  let totalSiteCreditSpent = 0;
  for (const doc of creditSpentSnapshot.docs) {
    const entryData = doc.data();
    const compDoc = await db.collection("competitions").doc(doc.ref.parent.parent.id).get();
    const competitionData = compDoc.data();
    const tier = competitionData.ticketTiers.find((t) => t.amount === entryData.ticketsBought);
    if (tier) {
      totalSiteCreditSpent += tier.price;
    }
  }

  return {success: true, totalRevenue, totalCost, netProfit, totalSiteCreditAwarded, totalSiteCreditSpent};
});

// spendSpinToken (unchanged)
exports.spendSpinToken = onCall(functionOptions, async (request) => {
  const schema = z.object({tokenId: z.string().min(1)});
  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", "A valid tokenId is required.");
  }
  const {tokenId} = validation.data;
  assertIsAuthenticated(request);
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
    const userData = userDoc.data();
    const userTokens = userData.spinTokens || [];
    const tokenIndex = userTokens.findIndex((t) => t.tokenId === tokenId);
    if (tokenIndex === -1) {
      throw new HttpsError("not-found", "Spin token not found or already spent.");
    }
    const updatedTokens = userTokens.filter((t) => t.tokenId !== tokenId);
    transaction.update(userRef, {spinTokens: updatedTokens});
    const settingsRef = db.collection("admin_settings").doc("spinnerPrizes");
    const settingsDoc = await settingsRef.get();
    if (!settingsDoc.exists) {
      throw new HttpsError("internal", "Spinner prize configuration is not available.");
    }
    const prizes = settingsDoc.data().prizes;
    const cumulativeProbabilities = [];
    let cumulative = 0;
    for (const prize of prizes) {
      cumulative += (1 / prize.odds);
      cumulativeProbabilities.push({...prize, cumulativeProb: cumulative});
    }
    const random = Math.random();
    let finalPrize = {won: false, prizeType: "none", value: 0};
    for (const prize of cumulativeProbabilities) {
      if (random < prize.cumulativeProb) {
        finalPrize = {won: true, prizeType: prize.type, value: prize.value};
        break;
      }
    }
    if (finalPrize.won) {
      const winLogRef = db.collection("spin_wins").doc();
      transaction.set(winLogRef, {
        userId: uid,
        prizeType: finalPrize.prizeType,
        prizeValue: finalPrize.value,
        wonAt: FieldValue.serverTimestamp(),
        tokenIdUsed: tokenId,
      });
      if (finalPrize.prizeType === "credit") {
        transaction.update(userRef, {creditBalance: FieldValue.increment(finalPrize.value)});
      } else if (finalPrize.prizeType === "cash") {
        transaction.update(userRef, {cashBalance: FieldValue.increment(finalPrize.value)});
      }
    }
    return finalPrize;
  });
});

// transferCashToCredit (unchanged)
exports.transferCashToCredit = onCall(functionOptions, async (request) => {
  const schema = z.object({
    amount: z.number().positive("Amount must be a positive number."),
  });

  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", validation.error.errors[0].message);
  }
  const {amount} = validation.data;

  assertIsAuthenticated(request);
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "User profile not found.");
    }

    const userData = userDoc.data();
    const userCashBalance = userData.cashBalance || 0;

    if (userCashBalance < amount) {
      throw new HttpsError("failed-precondition", "Insufficient cash balance.");
    }

    const creditToAdd = amount * 1.5;

    transaction.update(userRef, {
      cashBalance: FieldValue.increment(-amount),
      creditBalance: FieldValue.increment(creditToAdd),
    });

    return {success: true, newCreditBalance: (userData.creditBalance || 0) + creditToAdd};
  });
});

// requestCashPayout (unchanged)
exports.requestCashPayout = onCall(functionOptions, async (request) => {
  const schema = z.object({
    amount: z.number().positive("Amount must be a positive number."),
  });

  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", validation.error.errors[0].message);
  }
  const {amount} = validation.data;

  assertIsAuthenticated(request);
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "User profile not found.");
    }

    const userData = userDoc.data();
    const userCashBalance = userData.cashBalance || 0;

    if (userCashBalance < amount) {
      throw new HttpsError("failed-precondition", "Insufficient cash balance.");
    }

    transaction.update(userRef, {
      cashBalance: FieldValue.increment(-amount),
    });

    const payoutRequestRef = db.collection("payoutRequests").doc();
    transaction.set(payoutRequestRef, {
      userId: uid,
      amount: amount,
      status: "pending",
      requestedAt: FieldValue.serverTimestamp(),
      userDisplayName: userData.displayName || "N/A",
      userEmail: userData.email || "N/A",
    });

    return {success: true, message: "Payout request submitted successfully."};
  });
});

// playPlinko (unchanged)
exports.playPlinko = onCall(functionOptions, async (request) => {
  const schema = z.object({tokenId: z.string().min(1)});
  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", "A valid tokenId is required.");
  }
  const {tokenId} = validation.data;
  assertIsAuthenticated(request);
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const settingsRef = db.collection("admin_settings").doc("plinkoPrizes");
    const [userDoc, settingsDoc] = await Promise.all([transaction.get(userRef), transaction.get(settingsRef)]);

    if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
    if (!settingsDoc.exists) throw new HttpsError("internal", "Plinko prize configuration is not available.");

    const userData = userDoc.data();
    const settings = settingsDoc.data();
    const PLINKO_ROWS = settings.rows || 12;
    const payouts = settings.payouts || [];
    const mode = settings.mode || "server";

    const userTokens = userData.plinkoTokens || [];
    const tokenIndex = userTokens.findIndex((t) => t.tokenId === tokenId);
    if (tokenIndex === -1) {
      throw new HttpsError("not-found", "Plinko token not found or already spent.");
    }
    const updatedTokens = userTokens.filter((t) => t.tokenId !== tokenId);
    transaction.update(userRef, {plinkoTokens: updatedTokens});

    let rights = 0;
    const steps = [];
    for (let i = 0; i < PLINKO_ROWS; i++) {
      let step;
      if (mode === "weighted") {
        step = Math.random() < 0.55 ? 1 : -1;
      } else {
        step = Math.random() < 0.5 ? -1 : 1;
      }
      steps.push(step);
      if (step === 1) rights++;
    }
    const finalSlotIndex = rights;

    const prize = payouts[finalSlotIndex] || {type: "credit", value: 0};
    const finalPrize = {
      won: prize.value > 0,
      type: prize.type || "credit",
      value: prize.value || 0,
    };

    if (finalPrize.won) {
      const winLogRef = db.collection("plinko_wins").doc();
      transaction.set(winLogRef, {
        userId: uid,
        prizeType: finalPrize.type,
        prizeValue: finalPrize.value,
        slotIndex: finalSlotIndex,
        wonAt: FieldValue.serverTimestamp(),
        tokenIdUsed: tokenId,
      });
      if (finalPrize.type === "credit") {
        transaction.update(userRef, {creditBalance: FieldValue.increment(finalPrize.value)});
      }
    }

    return {prize: finalPrize, path: {steps, slotIndex: finalSlotIndex}};
  });
});

// drawWinner (unchanged)
exports.drawWinner = onCall(functionOptions, async (request) => {
  const schema = z.object({compId: z.string().min(1)});
  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", "Competition ID is required.");
  }
  const {compId} = validation.data;

  await assertIsAdmin(request);

  const compRef = db.collection("competitions").doc(compId);
  const compDoc = await compRef.get();
  if (!compDoc.exists || compDoc.data().status !== "ended") {
    throw new HttpsError("failed-precondition", "Competition must be in \"ended\" status to be drawn manually.");
  }

  try {
    const result = await performDraw(compId);
    return {success: true, ...result};
  } catch (error) {
    logger.error(`Manual draw failed for compId: ${compId}`, error);
    throw new HttpsError("internal", error.message || "An internal error occurred during the draw.");
  }
});

// weeklyTokenCompMaintenance (FIXED: admin SDK query chaining)
exports.weeklyTokenCompMaintenance = onSchedule({
  schedule: "every monday 12:00",
  timeZone: "Europe/London",
}, async () => {
  logger.log("Starting weekly token competition maintenance...");

  const compsRef = db.collection("competitions");
  const oneWeekAgo = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const snapshot = await compsRef
      .where("competitionType", "==", "token")
      .where("status", "==", "live")
      .where("createdAt", "<=", oneWeekAgo)
      .get();

  if (snapshot.empty) {
    logger.log("No old token competitions found needing cleanup. Exiting.");
  } else {
    logger.log(`Found ${snapshot.docs.length} old token competitions to process.`);
  }

  for (const doc of snapshot.docs) {
    const compId = doc.id;
    logger.log(`Processing competition ${compId}...`);
    try {
      await doc.ref.update({status: "ended"});
      logger.log(`Competition ${compId} status set to 'ended'.`);
      const drawResult = await performDraw(compId);
      logger.log(`Successfully drew winner for ${compId}: ${drawResult.winnerDisplayName}`);
    } catch (error) {
      logger.error(`Failed to process and draw winner for ${compId}`, error);
    }
  }

  const liveTokenSnapshot = await compsRef
      .where("competitionType", "==", "token")
      .where("status", "==", "live")
      .get();

  if (liveTokenSnapshot.size < 3) {
    logger.warn(`CRITICAL: The pool of live token competitions is low (${liveTokenSnapshot.size}). Admin should create more.`);
  }

  return null;
});

// Retry any 'paid' orders that haven't been fulfilled (safety net)
exports.retryUnfulfilledPaidOrders = onSchedule({
  schedule: "every 10 minutes",
  timeZone: "Europe/London",
}, async () => {
  const snap = await db.collection("orders")
    .where("status", "==", "paid")
    .where("fulfilled", "==", false)
    .limit(25)
    .get();
  if (snap.empty) return null;
  for (const doc of snap.docs) {
    try {
      await fulfilOrderTickets(doc.id);
    } catch (e) {
      logger.error("retryUnfulfilledPaidOrders error", { orderId: doc.id, err: e?.message || e });
    }
  }
  return null;
});
