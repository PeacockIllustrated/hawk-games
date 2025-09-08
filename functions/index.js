// functions/index.js
// ESM build. Ensure:  functions/package.json  has  "type": "module"

import * as admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";

// -------------------- Firebase Admin --------------------
if (!admin.apps.length) admin.initializeApp();
const db = getFirestore();

// -------------------- Global options --------------------
const functionOptions = {
  region: "us-central1",
  enforceAppCheck: true,
  cors: [
    "https://the-hawk-games-64239.web.app",
    "https://the-hawk-games.co.uk",
    "https://the-hawk-games-staging.netlify.app",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
  ],
};

// -------------------- Secrets --------------------
const TRUST_MODE = defineSecret("TRUST_MODE"); // "test" | "live" (defaults to live)
const TRUST_SITEREFERENCE = defineSecret("TRUST_SITEREFERENCE");
const TRUST_TEST_SITEREFERENCE = defineSecret("TRUST_TEST_SITEREFERENCE"); // optional
const RETURN_URL_SUCCESS = defineSecret("RETURN_URL_SUCCESS");
const RETURN_URL_CANCEL = defineSecret("RETURN_URL_CANCEL");
const NOTIFICATION_URL = defineSecret("NOTIFICATION_URL"); // HTTPS URL of trustWebhook
const TRUST_NOTIFY_PASSWORD = defineSecret("TRUST_NOTIFY_PASSWORD"); // Trust "Use site security details" password

// -------------------- Helpers --------------------
const readSecret = (secret, name, { allowEmpty = false } = {}) => {
  try {
    const v = secret.value();
    if (!allowEmpty && !v) throw new Error(`${name} empty`);
    return v || "";
  } catch (e) {
    logger.error(`Secret ${name} unavailable/undeclared`, e);
    throw new HttpsError("failed-precondition", `Missing or undeclared secret: ${name}`);
  }
};

const getMode = () => {
  const v = (readSecret(TRUST_MODE, "TRUST_MODE", { allowEmpty: true }) || "live").toLowerCase();
  return v === "test" ? "test" : "live";
};

const readUrlEncoded = (req) => {
  try {
    const raw = req.rawBody?.toString("utf8") || "";
    const params = new URLSearchParams(raw);
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  } catch {
    return {};
  }
};

const nowServer = () => FieldValue.serverTimestamp();

// -------------------- Fulfilment --------------------
const fulfilOrderTickets = async (orderId) => {
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    logger.error("fulfilOrderTickets: order not found", { orderId });
    return;
  }
  const order = orderSnap.data() || {};
  if (order.fulfilled === true) {
    logger.info("fulfilOrderTickets: already fulfilled", { orderId });
    return;
  }

  const items = Array.isArray(order.items) ? order.items : [];
  const userId = order.userId || null;

  await db.runTransaction(async (tx) => {
    for (const it of items) {
      if (it?.kind !== "tickets") continue;

      const compId = it.compId;
      const qty = Number(it.qty || 0);
      if (!compId || qty <= 0) continue;

      const compRef = db.collection("competitions").doc(compId);
      const compSnap = await tx.get(compRef);
      if (!compSnap.exists) {
        logger.warn("Competition missing during fulfil", { compId, orderId });
        continue;
      }
      const comp = compSnap.data() || {};
      const ticketsSold = Number(comp.ticketsSold || 0);

      // Simple contiguous allocation
      const allocated = [];
      for (let i = 1; i <= qty; i++) allocated.push(ticketsSold + i);

      const entryRef = db.collection("entries").doc();
      tx.set(entryRef, {
        orderId,
        userId,
        compId,
        qty,
        ticketNumbers: allocated,
        createdAt: nowServer(),
        source: "trust",
      });

      tx.update(compRef, {
        ticketsSold: FieldValue.increment(qty),
        updatedAt: nowServer(),
      });
    }

    tx.update(orderRef, {
      fulfilled: true,
      fulfilledAt: nowServer(),
      updatedAt: nowServer(),
    });
  });

  logger.info("fulfilOrderTickets: success", { orderId });
};

// -------------------- createTrustOrder --------------------
export const createTrustOrder = onCall(
  {
    region: "us-central1",
    enforceAppCheck: true,
    secrets: [
      TRUST_MODE,
      TRUST_SITEREFERENCE,
      TRUST_TEST_SITEREFERENCE,
      RETURN_URL_SUCCESS,
      RETURN_URL_CANCEL,
      NOTIFICATION_URL,
    ],
  },
  async (req) => {
    try {
      const { compId, qty = 1 } = req.data || {};
      if (!compId) throw new HttpsError("invalid-argument", "compId required");
      if (!Number.isFinite(qty) || qty <= 0) throw new HttpsError("invalid-argument", "qty invalid");

      const mode = getMode();
      const isTest = mode === "test";

      const siteRef = isTest
        ? (TRUST_TEST_SITEREFERENCE.value() || readSecret(TRUST_SITEREFERENCE, "TRUST_SITEREFERENCE"))
        : readSecret(TRUST_SITEREFERENCE, "TRUST_SITEREFERENCE");

      const successUrl = readSecret(RETURN_URL_SUCCESS, "RETURN_URL_SUCCESS");
      const cancelUrl = readSecret(RETURN_URL_CANCEL, "RETURN_URL_CANCEL");
      const notifyUrl = readSecret(NOTIFICATION_URL, "NOTIFICATION_URL");

      const compSnap = await db.collection("competitions").doc(compId).get();
      if (!compSnap.exists) throw new HttpsError("not-found", "Competition not found");
      const comp = compSnap.data();

      const unitPricePence =
        typeof comp?.ticketPricePence === "number"
          ? comp.ticketPricePence
          : typeof comp?.pricePence === "number"
          ? comp.pricePence
          : null;

      if (unitPricePence === null)
        throw new HttpsError("failed-precondition", "Competition missing ticket price (ticketPricePence/pricePence).");

      const amountPence = unitPricePence * qty;
      const mainamount = (amountPence / 100).toFixed(2);

      const orderRef = db.collection("orders").doc();
      await orderRef.set({
        userId: req.auth?.uid || null,
        userDisplayName: req.auth?.token?.name || null,
        type: "tickets",
        items: [{ kind: "tickets", compId, qty }],
        amountPence,
        currency: "GBP",
        status: "created",
        provider: "trust",
        isTest,
        createdAt: nowServer(),
        updatedAt: nowServer(),
      });

      const fields = {
        sitereference: siteRef,
        orderreference: orderRef.id,
        currencyiso3a: "GBP",
        mainamount, // "12.99"
        successfulurlredirect: `${successUrl}?orderId=${orderRef.id}`,
        declinedurlredirect: `${cancelUrl}?orderId=${orderRef.id}`,
        successfulurlredirectmethod: "GET",
        declinedurlredirectmethod: "GET",
        allurlnotification: notifyUrl,
        // Optional prefill
        billingemail: req.auth?.token?.email || "",
        billingfirstname: (req.auth?.token?.name || "").split(" ")[0] || "",
        billinglastname: (req.auth?.token?.name || "").split(" ").slice(1).join(" ") || "",
      };

      logger.info("createTrustOrder: HPP ready", {
        orderId: orderRef.id,
        siteRef,
        mainamount,
        isTest,
      });

      return {
        endpoint: "https://payments.securetrading.net/process/payments/details",
        fields,
      };
    } catch (err) {
      logger.error("createTrustOrder failed", { msg: err?.message || err, stack: err?.stack });
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "createTrustOrder: unexpected error");
    }
  }
);

// -------------------- trustWebhook --------------------
export const trustWebhook = onRequest(
  {
    ...functionOptions,
    enforceAppCheck: false, // Trust calls this server-to-server
    secrets: [TRUST_NOTIFY_PASSWORD],
  },
  async (req, res) => {
    try {
      const ct = (req.get("content-type") || "").toLowerCase();
      const body =
        ct.includes("application/x-www-form-urlencoded")
          ? readUrlEncoded(req)
          : (typeof req.body === "object" && req.body) || readUrlEncoded(req);

      const providedPwd = body.notification_password || body.password || "";
      const expectedPwd = readSecret(TRUST_NOTIFY_PASSWORD, "TRUST_NOTIFY_PASSWORD");
      if (!providedPwd || providedPwd !== expectedPwd) {
        logger.warn("Webhook rejected: bad password", { ip: req.ip });
        res.status(401).send("unauthorised");
        return;
      }

      const orderId = body.orderreference || body.order_reference || "";
      const errorcode = String(body.errorcode ?? "");
      const settlestatus = String(body.settlestatus ?? "");
      const paymenttypedescription = body.paymenttypedescription || "";
      const transactionreference = body.transactionreference || "";
      const sitereference = body.sitereference || "";

      if (!orderId) {
        logger.warn("Webhook missing orderreference", { body });
        res.status(400).send("bad request");
        return;
      }

      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        logger.warn("Webhook order not found", { orderId });
        res.status(200).send("ok"); // 200 so Trust doesn’t retry forever
        return;
      }

      const already = orderSnap.data() || {};
      if (already.status === "paid" || already.status === "failed" || already.status === "cancelled") {
        logger.info("Webhook idempotent short-circuit", { orderId, status: already.status });
        res.status(200).send("ok");
        return;
      }

      const success = errorcode === "0"; // Trust: 0 = authorised
      const baseUpdate = {
        updatedAt: nowServer(),
        provider: "trust",
        providerRef: transactionreference || null,
        sitereference: sitereference || null,
        settlestatus,
        errorcode,
        paymenttypedescription,
        webhookReceivedAt: nowServer(),
        trustPayload: {
          errorcode,
          settlestatus,
          paymenttypedescription,
          transactionreference,
        },
      };

      if (success) {
        await orderRef.update({ ...baseUpdate, status: "paid" });
        try {
          await fulfilOrderTickets(orderId);
        } catch (e) {
          logger.error("Fulfilment error after webhook", { orderId, err: e?.message || e });
        }
      } else {
        await orderRef.update({ ...baseUpdate, status: "failed", failureReason: `errorcode:${errorcode}` });
      }

      res.status(200).send("ok");
    } catch (err) {
      logger.error("trustWebhook error", { msg: err?.message || err, stack: err?.stack });
      res.status(200).send("ok"); // always 200 to avoid retry storms
    }
  }
);

// -------------------- Safety net: retry fulfilment --------------------
export const retryUnfulfilledPaidOrders = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "Europe/London",
    region: "us-central1",
  },
  async () => {
    const snap = await db
      .collection("orders")
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
  }
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
