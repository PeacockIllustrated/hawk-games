// functions/index.js
// ESM build — ensure functions/package.json has: { "type": "module" }

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import crypto from "crypto";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Admin init (idempotent) + DB
// -----------------------------------------------------------------------------
if (!getApps().length) initializeApp();
const db = getFirestore();

// -----------------------------------------------------------------------------
// Global options
// -----------------------------------------------------------------------------
const REGION = "us-central1";
const functionOptions = {
  region: REGION,
  enforceAppCheck: true,
};

// -----------------------------------------------------------------------------
// Secrets (declare once here; add to each function's `secrets:[…]` when used)
// -----------------------------------------------------------------------------
const TRUST_MODE = defineSecret("TRUST_MODE"); // "test" | "live" (defaults to live)
const TRUST_SITEREFERENCE = defineSecret("TRUST_SITEREFERENCE"); // required
const TRUST_TEST_SITEREFERENCE = defineSecret("TRUST_TEST_SITEREFERENCE"); // optional
const RETURN_URL_SUCCESS = defineSecret("RETURN_URL_SUCCESS"); // required
const RETURN_URL_CANCEL = defineSecret("RETURN_URL_CANCEL"); // required
const NOTIFICATION_URL = defineSecret("NOTIFICATION_URL"); // required
const TRUST_NOTIFY_PASSWORD = defineSecret("TRUST_NOTIFY_PASSWORD"); // required (we send + verify)
const TRUST_SITE_SECURITY_PASSWORD = defineSecret("TRUST_SITE_SECURITY_PASSWORD"); // required for site security hash

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const nowServer = () => FieldValue.serverTimestamp();

const readSecret = (secret, name, { allowEmpty = false } = {}) => {
  try {
    const v = secret.value();
    if (!allowEmpty && !v) throw new Error(`${name} empty`);
    return v || "";
  } catch (e) {
    logger.error(`Secret ${name} unavailable/undeclared`, { err: e?.message || e });
    throw new HttpsError("failed-precondition", `Missing or undeclared secret: ${name}`);
  }
};

// Safely read optional secret without throwing if undeclared
const trySecret = (secret) => {
  try {
    return secret.value() || "";
  } catch {
    return "";
  }
};

const getMode = () => {
  const raw = trySecret(TRUST_MODE);
  const v = (raw || "live").toLowerCase();
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

/**
 * Get a UTC timestamp in "YYYY-MM-DD HH:mm:ss" format for Trust Payments hashing.
 * @returns {string}
 */
const getUtcTimestamp = () => {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
};

// Auth helpers used by business functions
const assertIsAuthenticated = (request) => {
  const uid = request?.auth?.uid || null;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
  return uid;
};

const assertIsAdmin = async (request) => {
  const uid = assertIsAuthenticated(request);
  // Accept either a custom claim or users/{uid}.isAdmin flag
  const fromClaims = request.auth?.token?.admin === true || request.auth?.token?.isAdmin === true;
  if (fromClaims) return true;

  try {
    const snap = await db.collection("users").doc(uid).get();
    if (snap.exists && snap.data()?.isAdmin === true) return true;
  } catch (e) {
    // fall through
  }
  throw new HttpsError("permission-denied", "Admin privileges required.");
};

// -----------------------------------------------------------------------------
// Ticket fulfilment (idempotent). Writes to both global & per-competition entries.
// -----------------------------------------------------------------------------
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
  const userDisplayName = order.userDisplayName || "N/A";

  await db.runTransaction(async (tx) => {
    for (const it of items) {
      if (!it || it.kind !== "tickets") continue;

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

      // Global entries collection (kept for analytics)
      const entryRefGlobal = db.collection("entries").doc();
      tx.set(entryRefGlobal, {
        orderId,
        userId,
        userDisplayName,
        compId,
        qty,
        ticketNumbers: allocated,
        createdAt: nowServer(),
        source: "trust",
        entryType: "paid",
      });

      // Legacy per-competition subcollection (kept for compatibility)
      const entryRefLegacy = compRef.collection("entries").doc();
      tx.set(entryRefLegacy, {
        userId,
        userDisplayName,
        ticketsBought: qty,
        ticketStart: ticketsSold,
        ticketEnd: ticketsSold + qty - 1,
        enteredAt: nowServer(),
        entryType: "paid",
        orderId,
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

// -----------------------------------------------------------------------------
// Trust Payments — createTrustOrder (Callable)
// -----------------------------------------------------------------------------
export const createTrustOrder = onCall(
  {
    region: REGION,
    enforceAppCheck: true,
    secrets: [
      TRUST_MODE,
      TRUST_SITEREFERENCE,
      TRUST_TEST_SITEREFERENCE,
      RETURN_URL_SUCCESS,
      RETURN_URL_CANCEL,
      NOTIFICATION_URL,
      TRUST_NOTIFY_PASSWORD,
      TRUST_SITE_SECURITY_PASSWORD,
    ],
  },
  async (req) => {
    try {
      const data = req?.data || {};

      // Accept both shapes: { compId, qty } or { intent: { type:'tickets', compId, ticketsBought } }
      const rawCompId =
        data.compId ||
        data.competitionId ||
        data.cid ||
        data.id ||
        data?.intent?.compId ||
        data?.intent?.competitionId ||
        data?.intent?.cid ||
        data?.intent?.id ||
        "";
      const compId = String(rawCompId || "").trim();
      const qty = Number(
        data.qty ?? data.ticketsBought ?? data?.intent?.ticketsBought ?? 1
      );

      if (!compId) throw new HttpsError("invalid-argument", "compId required");
      if (!Number.isFinite(qty) || qty <= 0)
        throw new HttpsError("invalid-argument", "qty invalid");

      const mode = getMode();
      const isTest = mode === "test";
      const testSiteRef = trySecret(TRUST_TEST_SITEREFERENCE);
      const siteRef = isTest
        ? (testSiteRef || readSecret(TRUST_SITEREFERENCE, "TRUST_SITEREFERENCE"))
        : readSecret(TRUST_SITEREFERENCE, "TRUST_SITEREFERENCE");

      const successUrl = readSecret(RETURN_URL_SUCCESS, "RETURN_URL_SUCCESS");
      const cancelUrl = readSecret(RETURN_URL_CANCEL, "RETURN_URL_CANCEL");
      const notifyUrl = readSecret(NOTIFICATION_URL, "NOTIFICATION_URL");
      const notifyPwd = readSecret(
        TRUST_NOTIFY_PASSWORD,
        "TRUST_NOTIFY_PASSWORD"
      ).trim();
      const siteSecurityPwd = readSecret(
        TRUST_SITE_SECURITY_PASSWORD,
        "TRUST_SITE_SECURITY_PASSWORD"
      ).trim();

      // --- Price discovery ---
      const compSnap = await db.collection("competitions").doc(compId).get();
      if (!compSnap.exists) throw new HttpsError("not-found", "Competition not found");
      const comp = compSnap.data();

      let unitPricePence = null;
      if (typeof comp?.ticketPricePence === "number") unitPricePence = comp.ticketPricePence;
      else if (typeof comp?.pricePence === "number") unitPricePence = comp.pricePence;
      else if (Array.isArray(comp?.ticketTiers) && comp.ticketTiers.length) {
        const t0 = comp.ticketTiers[0];
        if (t0?.price && t0?.amount) unitPricePence = Math.round((Number(t0.price) / Number(t0.amount)) * 100);
      }

      if (unitPricePence == null)
        throw new HttpsError("failed-precondition", "Competition missing price (ticketPricePence/pricePence).");

      const amountPence = unitPricePence * qty;
      const mainamount = (amountPence / 100).toFixed(2); // "12.99"
      const currencyiso3a = "GBP";

      // --- Create order doc ---
      const orderRef = db.collection("orders").doc();
      await orderRef.set({
        userId: req.auth?.uid || null,
        userDisplayName: req.auth?.token?.name || null,
        type: "tickets",
        items: [{ kind: "tickets", compId, qty }],
        amountPence,
        currency: currencyiso3a,
        status: "created",
        provider: "trust",
        isTest,
        createdAt: nowServer(),
        updatedAt: nowServer(),
      });

      // --- Site Security Hashing ---
      const sitesecuritytimestamp = getUtcTimestamp();
      const hashString = [
        currencyiso3a,
        mainamount,
        siteRef,
        orderRef.id,
        sitesecuritytimestamp,
        siteSecurityPwd,
      ].join("");

      const sitesecurity =
        "h" + crypto.createHash("sha256").update(hashString).digest("hex");

      // --- HPP fields ---
      const fields = {
        sitereference: siteRef,
        orderreference: orderRef.id,
        currencyiso3a,
        mainamount, // decimal string
        sitesecurity,
        sitesecuritytimestamp,
        // Advanced Redirects (force GET so querystring is preserved)
        successfulurlredirect: `${successUrl}?orderId=${orderRef.id}`,
        declinedurlredirect: `${cancelUrl}?orderId=${orderRef.id}`,
        successfulurlredirectmethod: "GET",
        declinedurlredirectmethod: "GET",
        // URL Advanced Notification target
        allurlnotification: notifyUrl,
        // Explicit notification password so Trust echoes it back
        notificationpassword: notifyPwd,
        // Prefill (optional)
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

// -----------------------------------------------------------------------------
// Trust Payments — webhook (URL Advanced Notification)
// -----------------------------------------------------------------------------
export const trustWebhook = onRequest(
  {
    region: REGION,
    enforceAppCheck: false, // server-to-server from Trust
    secrets: [
      TRUST_NOTIFY_PASSWORD,
      TRUST_SITEREFERENCE,
      TRUST_TEST_SITEREFERENCE,
      TRUST_SITE_SECURITY_PASSWORD,
    ],
  },
  async (req, res) => {
    try {
      const ct = (req.get("content-type") || "").toLowerCase();
      const body =
        ct.includes("application/x-www-form-urlencoded")
          ? readUrlEncoded(req)
          : (typeof req.body === "object" && req.body) || readUrlEncoded(req);

      // --- Auth check 1: Notification Password ---
      const providedPwd = (
        body.notification_password ||
        body.notificationpassword ||
        req.query?.t ||
        ""
      ).toString().trim();
      const expectedPwd = readSecret(TRUST_NOTIFY_PASSWORD, "TRUST_NOTIFY_PASSWORD").trim();
      if (!providedPwd || providedPwd !== expectedPwd) {
        logger.warn("Webhook rejected: bad password", { ip: req.ip, havePwd: !!providedPwd });
        res.status(401).send("unauthorised");
        return;
      }

      // --- Auth check 2: Site Reference ---
      const postSiteRef = String(body.sitereference || "");
      if (!postSiteRef) {
        logger.warn("Webhook rejected: missing sitereference");
        res.status(401).send("unauthorised");
        return;
      }
      const allowedSites = new Set(
        [readSecret(TRUST_SITEREFERENCE, "TRUST_SITEREFERENCE"), trySecret(TRUST_TEST_SITEREFERENCE)]
          .filter(Boolean)
          .map((s) => s.trim())
      );
      if (!allowedSites.has(postSiteRef)) {
        logger.warn("Webhook rejected: unknown sitereference", { postSiteRef });
        res.status(401).send("unauthorised");
        return;
      }

      // --- Auth check 3: Site Security Hash ---
      const siteSecurityPwd = readSecret(
        TRUST_SITE_SECURITY_PASSWORD,
        "TRUST_SITE_SECURITY_PASSWORD"
      ).trim();

      const responseSiteSecurity = String(body.responsesitesecurity || "");
      const responseSiteSecurityTimestamp = String(
        body.responsesitesecuritytimestamp || ""
      );

      // Only perform hash check if a hash is provided.
      // This maintains backward compatibility if Site Security is not enabled on all orders.
      if (responseSiteSecurity && responseSiteSecurityTimestamp) {
        const orderIdForHash = body.orderreference || body.order_reference || "";
        const orderSnapForHash = await db.collection("orders").doc(orderIdForHash).get();

        if (orderSnapForHash.exists) {
          const orderData = orderSnapForHash.data() || {};
          const currencyiso3a = String(orderData.currency || "GBP");
          const mainamount = (Number(orderData.amountPence || 0) / 100).toFixed(2);

          const hashString = [
            currencyiso3a,
            mainamount,
            postSiteRef,
            orderIdForHash,
            responseSiteSecurityTimestamp,
            siteSecurityPwd,
          ].join("");

          const expectedHash =
            "h" + crypto.createHash("sha256").update(hashString).digest("hex");

          if (responseSiteSecurity !== expectedHash) {
            logger.warn("Webhook rejected: bad response hash", {
              orderId: orderIdForHash,
              have: responseSiteSecurity,
              want: expectedHash,
            });
            res.status(401).send("unauthorised");
            return;
          }
        } else {
          logger.warn("Webhook rejected: cannot verify hash for unknown order", { orderId: orderIdForHash });
          res.status(401).send("unauthorised");
          return;
        }
      }

      // --- Process request ---
      const orderId = body.orderreference || body.order_reference || "";
      if (!orderId) {
        logger.warn("Webhook missing orderreference", { bodyKeys: Object.keys(body || {}) });
        res.status(400).send("bad request");
        return;
      }

      const errorcode = String(body.errorcode ?? "");
      const settlestatus = String(body.settlestatus ?? "");
      const paymenttypedescription = body.paymenttypedescription || "";
      const transactionreference = body.transactionreference || "";

      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        // Return 200 to stop Trust retries; we’ll never see this order
        logger.warn("Webhook order not found", { orderId });
        res.status(200).send("ok");
        return;
      }

      const already = orderSnap.data() || {};
      if (["paid", "failed", "cancelled"].includes(already.status)) {
        logger.info("Webhook idempotent short-circuit", { orderId, status: already.status });
        res.status(200).send("ok");
        return;
      }

      const success = errorcode === "0"; // Trust: errorcode 0 = authorised
      const baseUpdate = {
        updatedAt: nowServer(),
        provider: "trust",
        providerRef: transactionreference || null,
        sitereference: postSiteRef || null,
        settlestatus,
        errorcode,
        paymenttypedescription,
        webhookReceivedAt: nowServer(),
        trustPayload: {
          errorcode,
          settlestatus,
          paymenttypedescription,
          transactionreference,
          responsesitesecurity, // store for auditing
          responsesitesecuritytimestamp, // store for auditing
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
      // Always 200 to avoid retry storms; log details for triage
      logger.error("trustWebhook error", { msg: err?.message || err, stack: err?.stack });
      res.status(200).send("ok");
    }
  }
);

// -----------------------------------------------------------------------------
// Safety net: retry any 'paid' orders that haven't been fulfilled
// -----------------------------------------------------------------------------
export const retryUnfulfilledPaidOrders = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "Europe/London",
    region: REGION,
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

// ============================================================================
// Existing business functions (ESM-converted, minor fixes only)
// ============================================================================

// allocateTicketsAndAwardTokens
// UPDATED: expectedPrice optional; for 'credit' we price server-side.
// For 'card' we reject (card is now via Trust HPP).
export const allocateTicketsAndAwardTokens = onCall(functionOptions, async (request) => {
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
  const { compId, ticketsBought, expectedPrice, paymentMethod } = validation.data;

  const uid = assertIsAuthenticated(request);
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

    const compData = compDoc.data() || {};
    const userData = userDoc.data() || {};

    // Calculate price based on base price per ticket
    if (!Array.isArray(compData.ticketTiers) || compData.ticketTiers.length === 0) {
      throw new HttpsError("failed-precondition", "Pricing not configured for this competition.");
    }
    const basePricePerTicket = compData.ticketTiers[0].price / compData.ticketTiers[0].amount;
    const priceToCharge = ticketsBought * basePricePerTicket;

    // Back-compat: if expectedPrice provided and mismatched, reject
    if (typeof expectedPrice === "number" && expectedPrice !== priceToCharge) {
      throw new HttpsError("invalid-argument", "Price mismatch. Please refresh and try again.");
    }

    // CREDIT flow
    const userCredit = Number(userData.creditBalance || 0);
    if (userCredit < priceToCharge) {
      throw new HttpsError("failed-precondition", "Insufficient credit balance.");
    }
    transaction.update(userRef, { creditBalance: FieldValue.increment(-priceToCharge) });

    if (compData.status !== "live") throw new HttpsError("failed-precondition", "Competition is not live.");
    const userEntryCount = (userData.entryCount && userData.entryCount[compId]) ? userData.entryCount[compId] : 0;
    const limit = compData.userEntryLimit || 75;
    if (userEntryCount + ticketsBought > limit) throw new HttpsError("failed-precondition", "Entry limit exceeded.");
    const ticketsSoldBefore = compData.ticketsSold || 0;
    if (ticketsSoldBefore + ticketsBought > compData.totalTickets) {
      throw new HttpsError("failed-precondition", "Not enough tickets available.");
    }
    const ticketStartNumber = ticketsSoldBefore;

    transaction.update(compRef, { ticketsSold: FieldValue.increment(ticketsBought) });
    transaction.update(userRef, { [`entryCount.${compId}`]: FieldValue.increment(ticketsBought) });

    // Legacy per-competition subcollection (credit entry)
    const entryRef = compRef.collection("entries").doc();
    transaction.set(entryRef, {
      userId: uid,
      userDisplayName: userData.displayName || "N/A",
      ticketsBought,
      ticketStart: ticketStartNumber,
      ticketEnd: ticketStartNumber + ticketsBought - 1,
      enteredAt: nowServer(),
      entryType: "credit",
    });

    // Optional: also mirror to global entries for consistency
    const entryGlobal = db.collection("entries").doc();
    transaction.set(entryGlobal, {
      orderId: null,
      userId: uid,
      userDisplayName: userData.displayName || "N/A",
      compId,
      qty: ticketsBought,
      ticketNumbers: Array.from({ length: ticketsBought }, (_, i) => ticketStartNumber + i + 1),
      createdAt: nowServer(),
      source: "credit",
      entryType: "credit",
    });

    // Award tokens if configured
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
      transaction.update(userRef, { spinTokens: FieldValue.arrayUnion(...newTokens) });
      awardedTokens = newTokens;
    }

    return { success: true, ticketStart: ticketStartNumber, ticketsBought, awardedTokens };
  });
});

// getRevenueAnalytics (unchanged logic; ESM)
export const getRevenueAnalytics = onCall(functionOptions, async (request) => {
  await assertIsAdmin(request);

  const competitionsSnapshot = await db.collection("competitions").get();
  let totalRevenue = 0;

  for (const docSnap of competitionsSnapshot.docs) {
    const compId = docSnap.id;
    const entriesRef = db.collection("competitions").doc(compId).collection("entries");
    const entriesSnapshot = await entriesRef.where("entryType", "==", "paid").get();

    let competitionRevenue = 0;
    entriesSnapshot.forEach((entryDoc) => {
      const entryData = entryDoc.data();
      const competitionData = docSnap.data();
      const tier = (competitionData.ticketTiers || []).find((t) => t.amount === entryData.ticketsBought);
      if (tier) competitionRevenue += tier.price;
    });
    totalRevenue += competitionRevenue;
  }

  const spinWinsSnapshot = await db.collection("spin_wins").where("prizeType", "==", "cash").get();
  let totalCost = 0;
  spinWinsSnapshot.forEach((doc) => { totalCost += doc.data().prizeValue; });

  const netProfit = totalRevenue - totalCost;

  const creditAwardedSnapshot = await db.collection("spin_wins").where("prizeType", "==", "credit").get();
  let totalSiteCreditAwarded = 0;
  creditAwardedSnapshot.forEach((doc) => { totalSiteCreditAwarded += doc.data().prizeValue; });

  const creditSpentSnapshot = await db.collectionGroup("entries").where("entryType", "==", "credit").get();
  let totalSiteCreditSpent = 0;
  for (const doc of creditSpentSnapshot.docs) {
    const entryData = doc.data();
    const compDoc = await db.collection("competitions").doc(doc.ref.parent.parent.id).get();
    const competitionData = compDoc.data();
    const tier = (competitionData.ticketTiers || []).find((t) => t.amount === entryData.ticketsBought);
    if (tier) totalSiteCreditSpent += tier.price;
  }

  return { success: true, totalRevenue, totalCost, netProfit, totalSiteCreditAwarded, totalSiteCreditSpent };
});

// spendSpinToken
export const spendSpinToken = onCall(functionOptions, async (request) => {
  const schema = z.object({ tokenId: z.string().min(1) });
  const validation = schema.safeParse(request.data);
  if (!validation.success) throw new HttpsError("invalid-argument", "A valid tokenId is required.");

  const { tokenId } = validation.data;
  const uid = assertIsAuthenticated(request);
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");

    const userData = userDoc.data();
    const userTokens = userData.spinTokens || [];
    const tokenIndex = userTokens.findIndex((t) => t.tokenId === tokenId);
    if (tokenIndex === -1) throw new HttpsError("not-found", "Spin token not found or already spent.");
    const updatedTokens = userTokens.filter((t) => t.tokenId !== tokenId);
    transaction.update(userRef, { spinTokens: updatedTokens });

    const settingsRef = db.collection("admin_settings").doc("spinnerPrizes");
    const settingsDoc = await settingsRef.get();
    if (!settingsDoc.exists) throw new HttpsError("internal", "Spinner prize configuration is not available.");

    const prizes = settingsDoc.data().prizes || [];
    const cumulativeProbabilities = [];
    let cumulative = 0;
    for (const prize of prizes) {
      cumulative += 1 / prize.odds;
      cumulativeProbabilities.push({ ...prize, cumulativeProb: cumulative });
    }
    const random = Math.random();
    let finalPrize = { won: false, prizeType: "none", value: 0 };
    for (const prize of cumulativeProbabilities) {
      if (random < prize.cumulativeProb) {
        finalPrize = { won: true, prizeType: prize.type, value: prize.value };
        break;
      }
    }

    if (finalPrize.won) {
      const winLogRef = db.collection("spin_wins").doc();
      transaction.set(winLogRef, {
        userId: uid,
        prizeType: finalPrize.prizeType,
        prizeValue: finalPrize.value,
        wonAt: nowServer(),
        tokenIdUsed: tokenId,
      });
      if (finalPrize.prizeType === "credit") {
        transaction.update(userRef, { creditBalance: FieldValue.increment(finalPrize.value) });
      } else if (finalPrize.prizeType === "cash") {
        transaction.update(userRef, { cashBalance: FieldValue.increment(finalPrize.value) });
      }
    }

    return finalPrize;
  });
});

// transferCashToCredit
export const transferCashToCredit = onCall(functionOptions, async (request) => {
  const schema = z.object({ amount: z.number().positive("Amount must be a positive number.") });
  const validation = schema.safeParse(request.data);
  if (!validation.success) throw new HttpsError("invalid-argument", validation.error.errors[0].message);

  const { amount } = validation.data;
  const uid = assertIsAuthenticated(request);
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");

    const userData = userDoc.data();
    const userCashBalance = userData.cashBalance || 0;
    if (userCashBalance < amount) throw new HttpsError("failed-precondition", "Insufficient cash balance.");

    const creditToAdd = amount * 1.5;
    transaction.update(userRef, {
      cashBalance: FieldValue.increment(-amount),
      creditBalance: FieldValue.increment(creditToAdd),
    });

    return { success: true, newCreditBalance: (userData.creditBalance || 0) + creditToAdd };
  });
});

// requestCashPayout
export const requestCashPayout = onCall(functionOptions, async (request) => {
  const schema = z.object({ amount: z.number().positive("Amount must be a positive number.") });
  const validation = schema.safeParse(request.data);
  if (!validation.success) throw new HttpsError("invalid-argument", validation.error.errors[0].message);

  const { amount } = validation.data;
  const uid = assertIsAuthenticated(request);
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");

    const userData = userDoc.data();
    const userCashBalance = userData.cashBalance || 0;
    if (userCashBalance < amount) throw new HttpsError("failed-precondition", "Insufficient cash balance.");

    transaction.update(userRef, { cashBalance: FieldValue.increment(-amount) });

    const payoutRequestRef = db.collection("payoutRequests").doc();
    transaction.set(payoutRequestRef, {
      userId: uid,
      amount,
      status: "pending",
      requestedAt: nowServer(),
      userDisplayName: userData.displayName || "N/A",
      userEmail: userData.email || "N/A",
    });

    return { success: true, message: "Payout request submitted successfully." };
  });
});

// playPlinko
export const playPlinko = onCall(functionOptions, async (request) => {
  const schema = z.object({ tokenId: z.string().min(1) });
  const validation = schema.safeParse(request.data);
  if (!validation.success) throw new HttpsError("invalid-argument", "A valid tokenId is required.");

  const { tokenId } = validation.data;
  const uid = assertIsAuthenticated(request);
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
    if (tokenIndex === -1) throw new HttpsError("not-found", "Plinko token not found or already spent.");
    const updatedTokens = userTokens.filter((t) => t.tokenId !== tokenId);
    transaction.update(userRef, { plinkoTokens: updatedTokens });

    let rights = 0;
    const steps = [];
    for (let i = 0; i < PLINKO_ROWS; i++) {
      const step = mode === "weighted" ? (Math.random() < 0.55 ? 1 : -1) : (Math.random() < 0.5 ? -1 : 1);
      steps.push(step);
      if (step === 1) rights++;
    }
    const finalSlotIndex = rights;

    const prize = payouts[finalSlotIndex] || { type: "credit", value: 0 };
    const finalPrize = { won: prize.value > 0, type: prize.type || "credit", value: prize.value || 0 };

    if (finalPrize.won) {
      const winLogRef = db.collection("plinko_wins").doc();
      transaction.set(winLogRef, {
        userId: uid,
        prizeType: finalPrize.type,
        prizeValue: finalPrize.value,
        slotIndex: finalSlotIndex,
        wonAt: nowServer(),
        tokenIdUsed: tokenId,
      });
      if (finalPrize.type === "credit") {
        transaction.update(userRef, { creditBalance: FieldValue.increment(finalPrize.value) });
      }
    }

    return { prize: finalPrize, path: { steps, slotIndex: finalSlotIndex } };
  });
});

// ----------------------------------------------------------------------------
// Simple draw helper (kept minimal and defensive)
// ----------------------------------------------------------------------------
const performDraw = async (compId) => {
  // Prefer per-competition subcollection
  const compRef = db.collection("competitions").doc(compId);
  const subSnap = await compRef.collection("entries").get();

  let entries = [];
  if (!subSnap.empty) {
    entries = subSnap.docs.map((d) => ({ uid: d.data().userId, displayName: d.data().userDisplayName || "N/A" }));
  } else {
    // Fallback: global entries with compId
    const globalSnap = await db.collection("entries").where("compId", "==", compId).get();
    entries = globalSnap.docs.map((d) => ({ uid: d.data().userId, displayName: d.data().userDisplayName || "N/A" }));
  }

  if (!entries.length) throw new Error("No entries to draw.");

  const idx = Math.floor(Math.random() * entries.length);
  const winner = entries[idx];

  await compRef.update({
    winnerUserId: winner.uid || null,
    winnerDisplayName: winner.displayName || "N/A",
    drawnAt: nowServer(),
  });

  return { winnerUserId: winner.uid, winnerDisplayName: winner.displayName };
};

// drawWinner (manual)
export const drawWinner = onCall(functionOptions, async (request) => {
  const schema = z.object({ compId: z.string().min(1) });
  const validation = schema.safeParse(request.data);
  if (!validation.success) throw new HttpsError("invalid-argument", "Competition ID is required.");
  const { compId } = validation.data;

  await assertIsAdmin(request);

  const compRef = db.collection("competitions").doc(compId);
  const compDoc = await compRef.get();
  if (!compDoc.exists || compDoc.data().status !== "ended") {
    throw new HttpsError("failed-precondition", 'Competition must be in "ended" status to be drawn manually.');
  }

  try {
    const result = await performDraw(compId);
    return { success: true, ...result };
  } catch (error) {
    logger.error(`Manual draw failed for compId: ${compId}`, error);
    throw new HttpsError("internal", error.message || "An internal error occurred during the draw.");
  }
});

// weeklyTokenCompMaintenance (fix: use admin Timestamp + query chaining)
export const weeklyTokenCompMaintenance = onSchedule(
  {
    schedule: "every monday 12:00",
    timeZone: "Europe/London",
    region: REGION,
  },
  async () => {
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
        await doc.ref.update({ status: "ended" });
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
  }
);
