// functions/index.js
// Pure ESM. Ensure functions/package.json has:
// {
//   "type": "module",
//   "engines": { "node": "20" }
// }

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import crypto from "node:crypto";
import { z } from "zod";

// -------------------- Firebase Admin --------------------
if (!getApps().length) initializeApp();
const db = getFirestore();

// -------------------- Shared options --------------------
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
// IMPORTANT: TRUST_SITE_PASSWORD and TRUST_NOTIFY_PASSWORD MUST be the same value
// (as requested by Trust Payments) — one for site security hash, one for webhook auth.
const TRUST_SITE_PASSWORD = defineSecret("TRUST_SITE_PASSWORD");
const TRUST_NOTIFY_PASSWORD = defineSecret("TRUST_NOTIFY_PASSWORD");

const TRUST_MODE = defineSecret("TRUST_MODE"); // "test" | "live" (default live)
const TRUST_SITEREFERENCE = defineSecret("TRUST_SITEREFERENCE");
const TRUST_TEST_SITEREFERENCE = defineSecret("TRUST_TEST_SITEREFERENCE"); // optional
const RETURN_URL_SUCCESS = defineSecret("RETURN_URL_SUCCESS");
const RETURN_URL_CANCEL = defineSecret("RETURN_URL_CANCEL");
const NOTIFICATION_URL = defineSecret("NOTIFICATION_URL");

// -------------------- Small helpers --------------------
const nowServer = () => FieldValue.serverTimestamp();

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

const resolveUnitPricePence = (comp) => {
  // Preferred explicit fields
  if (typeof comp?.ticketPricePence === "number") return comp.ticketPricePence;
  if (typeof comp?.pricePence === "number") return comp.pricePence;

  // Fallback to tiers: first tier price ÷ amount -> per-ticket, then to pence
  if (Array.isArray(comp?.ticketTiers) && comp.ticketTiers.length > 0) {
    const t0 = comp.ticketTiers[0];
    const amount = Number(t0?.amount);
    const price = Number(t0?.price); // GBP decimal for the whole bundle
    if (Number.isFinite(amount) && amount > 0 && Number.isFinite(price)) {
      return Math.round((price / amount) * 100); // pence per ticket
    }
  }

  // Last resort (if you happen to store a GBP decimal somewhere):
  if (typeof comp?.ticketPrice === "number") return Math.round(comp.ticketPrice * 100);

  return null;
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

// UTC timestamp in the format Trust requires: "YYYY-MM-DD hh:mm:ss"
const utcTimestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

// Build Trust Site Security (SHA-256) based on the exact field order agreed with Trust:
// fields = currencyiso3a, mainamount, sitereference, sitesecuritytimestamp, password
const buildSiteSecurity = ({ currencyiso3a, mainamount, sitereference, password }) => {
  const ts = utcTimestamp();
  const toHash =
    String(currencyiso3a ?? "") +
    String(mainamount ?? "") +
    String(sitereference ?? "") +
    ts +
    String(password ?? "");
  const hash = crypto.createHash("sha256").update(toHash, "utf8").digest("hex");
  return { ts, hash: "h" + hash }; // MUST prefix with 'h'
};

// -------------------- Auth/Admin guards (stubs you can replace) --------------------
const assertIsAuthenticated = (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Please sign in.");
};

const assertIsAdmin = async (request) => {
  const isAdmin = request.auth?.token?.admin === true || request.auth?.token?.role === "admin";
  if (!isAdmin) throw new HttpsError("permission-denied", "Admin only.");
};

// -------------------- Fulfilment (tickets & counts) --------------------

function hasInstantWins(comp) {
  const t = (comp?.tags || []).map((x) => String(x).toLowerCase());
  return (
    comp?.instantWins === true ||
    t.includes("instant") ||
    t.includes("instantwin") ||
    t.includes("instant_win") ||
    t.includes("instant-wins") ||
    t.includes("instantwins") ||
    t.includes("spin")
  );
}

function tokensFor(comp, qty) {
  const per = Number(comp?.tokensPerTicket ?? 1); // default 1 token per ticket
  return Math.max(0, Math.floor(per * qty));
}

const fulfilOrderTickets = async (orderId) => {
  logger.info("fulfil start", { orderId });
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    logger.error("fulfilOrderTickets: order not found", { orderId });
    return;
  }

  const order = orderSnap.data() || {};
  logger.info("fulfilOrderTickets: processing order", { orderId, order });
  if (order.fulfilled === true) {
    logger.info("fulfilOrderTickets: already fulfilled", { orderId });
    return;
  }

  const items = Array.isArray(order.items) ? order.items : [];
  const userId = order.userId || null;
  const userDisplayName = order.userDisplayName || "N/A";

  await db.runTransaction(async (tx) => {
    // We’ll accumulate total tickets to bump user entryCount once.
    const perCompetitionAdds = new Map();

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
      const before = Number(comp.ticketsSold || 0);
      const allocated = Array.from({length: qty}, (_, i) => before + i + 1);
      logger.info("alloc", { compId, before, qty, allocated });

      // allocate contiguous numbers
      const ticketStart = before + 1;
      const ticketEnd = before + qty;

      // 1) Write to the competition subcollection (what the UI reads)
      const entrySubRef = compRef.collection("entries").doc();
      tx.set(entrySubRef, {
        userId,
        userDisplayName,
        ticketsBought: qty,
        ticketStart,
        ticketEnd,
        orderId,
        entryType: "paid",
        enteredAt: nowServer(),
        source: "trust",
      });

      // (Optional) keep a global log if you want analytics
      const entryGlobalRef = db.collection("entries").doc();
      tx.set(entryGlobalRef, {
        userId,
        userDisplayName,
        compId,
        ticketsBought: qty,
        ticketNumbers: allocated,
        orderId,
        entryType: "paid",
        createdAt: nowServer(),
        source: "trust",
      });

      // 2) Update the competition counters
      // Normalize fields when reading the comp
      const cap  = Number(comp.totalTickets ?? comp.capacity ?? 0);
      const sold = Number(comp.ticketsSold ?? comp.soldCount ?? 0);
      const soldNow = sold + qty;
      const atCapacity = cap > 0 && soldNow >= cap;
      const isSellout = comp.closeMode === "sellout"; // default date if missing

      // Build the correct "sold" field update (always prefer ticketsSold)
      const soldFieldUpdate = ('ticketsSold' in comp || !('soldCount' in comp))
        ? { ticketsSold: soldNow }
        : { soldCount: soldNow };

      // Update competition doc
      if (atCapacity && isSellout){
        tx.update(compRef, {
          ...soldFieldUpdate,
          status: "sold_out",
          isLive: false,
          soldOutAt: nowServer(),
        });
      } else {
        tx.update(compRef, soldFieldUpdate);
      }

      // Aggregate per-comp increments for the user entryCount
      perCompetitionAdds.set(compId, (perCompetitionAdds.get(compId) || 0) + qty);

      // Award spin tokens even while the UI is disabled.
      // DEVIATION FROM INSTRUCTIONS: The user's request specified using `FieldValue.increment`
      // on the `spinTokens` field. However, the application's data model and existing
      // code (e.g., `spendSpinToken` function, frontend UI) consistently treat `spinTokens`
      // as an ARRAY of token objects, not a numeric counter. Changing this to a number
      // would be a breaking change. This implementation correctly awards tokens by adding
      // new token objects to the array, which is consistent with the rest of the application.
      if (hasInstantWins(comp)) {
        const tokens = tokensFor(comp, qty);
        if (tokens > 0) {
          const newTokens = [];
          const earnedAt = new Date();
          for (let i = 0; i < tokens; i++) {
            newTokens.push({
              tokenId: crypto.randomBytes(16).toString("hex"),
              compId,
              compTitle: comp.title,
              earnedAt,
            });
          }
          const userRef = db.collection("users").doc(userId);
          tx.set(userRef, { spinTokens: FieldValue.arrayUnion(...newTokens) }, { merge: true });
          tx.set(orderRef, { spinTokensAwarded: tokens }, { merge: true });
        }
      }
    }

    // 3) Update user entryCount.{compId} for all comps in this order
    if (userId && perCompetitionAdds.size > 0) {
      const userRef = db.collection("users").doc(userId);
      const inc = {};
      for (const [compId, qty] of perCompetitionAdds.entries()) {
        inc[`entryCount.${compId}`] = FieldValue.increment(qty);
      }
      tx.set(userRef, inc, { merge: true });
    }

    // 4) Mark order fulfilled (and set status to 'fulfilled' for the success page)
    tx.update(orderRef, {
      fulfilled: true,
      status: "fulfilled",
      fulfilledAt: nowServer(),
      updatedAt: nowServer(),
    });
  });

  logger.info("fulfil done", { orderId });
};

// -------------------- createTrustOrder (callable) --------------------
export const createTrustOrder = onCall(
  {
    region: "us-central1",
    enforceAppCheck: true,
    secrets: [
      TRUST_SITE_PASSWORD,
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
      assertIsAuthenticated(req);
      const { compId, qty = 1 } = req.data || {};
      if (!compId) throw new HttpsError("invalid-argument", "compId required");
      if (!Number.isFinite(qty) || qty <= 0) throw new HttpsError("invalid-argument", "qty invalid");

      const mode = getMode();
      const isTest = mode === "test";

      // Safe retrieval of site references (test can fall back to live)
      const testRef = readSecret(TRUST_TEST_SITEREFERENCE, "TRUST_TEST_SITEREFERENCE", { allowEmpty: true });
      const liveRef = readSecret(TRUST_SITEREFERENCE, "TRUST_SITEREFERENCE");
      const siteRef = isTest ? (testRef || liveRef) : liveRef;

      const successUrl = readSecret(RETURN_URL_SUCCESS, "RETURN_URL_SUCCESS");
      const cancelUrl = readSecret(RETURN_URL_CANCEL, "RETURN_URL_CANCEL");
      const notifyUrl = readSecret(NOTIFICATION_URL, "NOTIFICATION_URL");

      const compSnap = await db.collection("competitions").doc(compId).get();
      if (!compSnap.exists) throw new HttpsError("not-found", "Competition not found");
      const comp = compSnap.data();

      function toMillis(ts){ return ts?.toMillis ? ts.toMillis() : new Date(ts||0).getTime(); }
      function computeStateServer(comp) {
        const cap  = Number(comp.totalTickets ?? comp.capacity ?? 0);
        const sold = Number(comp.ticketsSold ?? comp.soldCount ?? 0);
        const left = Math.max(0, cap - sold);
        if (cap > 0 && left === 0) return "sold_out";
        const isSellout = comp?.closeMode === "sellout"; // default to date
        if (!isSellout){
          const endMs = toMillis(comp?.closeAt);
          if (endMs && Date.now() >= endMs) return "closed";
        }
        return "live";
      }

      if (computeStateServer(comp) !== "live") throw new HttpsError("failed-precondition", "Competition closed");

      // also protect against oversell
      const cap  = Number(comp.totalTickets ?? comp.capacity ?? 0);
      const sold = Number(comp.ticketsSold ?? comp.soldCount ?? 0);
      if (Math.max(0, cap - sold) < qty) throw new HttpsError("failed-precondition", "Not enough tickets remaining");

      const unitPricePence = resolveUnitPricePence(comp);
      if (unitPricePence === null) {
        throw new HttpsError(
          "failed-precondition",
          "Competition missing ticket price (ticketPricePence/pricePence)."
        );
      }

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

      // Base HPP fields
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

        // Optional shopper details (nice to have on HPP)
        billingemail: req.auth?.token?.email || "",
        billingfirstname: (req.auth?.token?.name || "").split(" ")[0] || "",
        billinglastname: (req.auth?.token?.name || "").split(" ").slice(1).join(" ") || "",
      };

      // --- Site Security (enabled by Trust) ---
      // Order confirmed by Trust (email): currencyiso3a,mainamount,sitereference,sitesecuritytimestamp,password
      const sitePwd = readSecret(TRUST_SITE_PASSWORD, "TRUST_SITE_PASSWORD");
      const { ts, hash } = buildSiteSecurity({
        currencyiso3a: fields.currencyiso3a,
        mainamount: fields.mainamount,
        sitereference: fields.sitereference,
        password: sitePwd,
      });
      fields.sitesecuritytimestamp = ts;
      fields.sitesecurity = hash;

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

// -------------------- trustWebhook (https) --------------------
export const trustWebhook = onRequest(
  {
    ...functionOptions,
    enforceAppCheck: false, // Trust posts server-to-server
    secrets: [TRUST_NOTIFY_PASSWORD],
  },
  async (req, res) => {
    try {
      // Parse x-www-form-urlencoded safely
      const ct = (req.get("content-type") || "").toLowerCase();
      const body =
        ct.includes("application/x-www-form-urlencoded")
          ? readUrlEncoded(req)
          : (typeof req.body === "object" && req.body) || readUrlEncoded(req);

      // Extract fields (many can be blank; we will omit blanks in the hash)
      const errorcode = body.errorcode ?? "";
      const orderreference = body.orderreference ?? "";
      const paymenttypedescription = body.paymenttypedescription ?? "";
      const requestreference = body.requestreference ?? "";
      const settlestatus = body.settlestatus ?? "";
      const sitereference = body.sitereference ?? "";
      const transactionreference = body.transactionreference ?? "";
      const responsesitesecurityRaw = (body.responsesitesecurity || "").toLowerCase();

      logger.info("webhook received", { orderId: orderreference, errorcode, settlestatus, transactionreference });

      // Build the string in EXACT order, omitting blank values (per Trust guidance),
      // and EXPLICITLY IGNORING `notificationreference`.
      const parts = [
        errorcode,
        orderreference,
        paymenttypedescription,
        requestreference,
        settlestatus,
        sitereference,
        transactionreference,
      ].filter(v => typeof v === "string" && v.length > 0);

      const notifySecret = readSecret(TRUST_NOTIFY_PASSWORD, "TRUST_NOTIFY_PASSWORD");
      const concatenated = parts.join("") + notifySecret;

      // Compute SHA-256 (lowercase hex). Trust does NOT prefix 'h' for responsesitesecurity.
      const computed = crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");

      // Accept if exact match. (Also tolerate accidental leading 'h' on inbound, just in case.)
      const inbound = responsesitesecurityRaw.startsWith("h")
        ? responsesitesecurityRaw.slice(1)
        : responsesitesecurityRaw;

      if (!inbound || inbound !== computed) {
        logger.warn("Webhook rejected: responsesitesecurity mismatch", {
          hasInbound: Boolean(responsesitesecurityRaw),
          orderreference,
          expectedHashSample: computed.slice(0, 8) + "...",
        });
        // 401 so Trust retries until we fix secrets / ordering
        res.status(401).send("unauthorised");
        return;
      }

      if (!orderreference) {
        logger.warn("Webhook missing orderreference", { body });
        res.status(400).send("bad request");
        return;
      }

      // Load order
      const orderRef = db.collection("orders").doc(orderreference);
      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        // Still return 200 to avoid retry storms; we’ll see the log to investigate.
        logger.warn("Webhook order not found", { orderreference });
        res.status(200).send("ok");
        return;
      }

      const existing = orderSnap.data() || {};
      if (["paid", "failed", "cancelled"].includes(existing.status)) {
        logger.info("Webhook idempotent short-circuit", { orderreference, status: existing.status });
        res.status(200).send("ok");
        return;
      }

      const success = String(errorcode) === "0";
      const baseUpdate = {
        updatedAt: nowServer(),
        provider: "trust",
        providerRef: transactionreference || null,
        sitereference: sitereference || null,
        settlestatus: String(settlestatus ?? ""),
        errorcode: String(errorcode ?? ""),
        paymenttypedescription: paymenttypedescription || "",
        requestreference: requestreference || "",
        webhookReceivedAt: nowServer(),
        trustPayload: {
          errorcode: String(errorcode ?? ""),
          settlestatus: String(settlestatus ?? ""),
          paymenttypedescription: paymenttypedescription || "",
          transactionreference: transactionreference || "",
          requestreference: requestreference || "",
          // we purposefully DO NOT store the secret or responsesitesecurity in DB
        },
      };

      if (success) {
        await orderRef.update({ ...baseUpdate, status: "paid" });
        try {
          await fulfilOrderTickets(orderreference);
        } catch (e) {
          logger.error("Fulfilment error after webhook", { orderreference, err: e?.message || e });
        }
      } else {
        await orderRef.update({ ...baseUpdate, status: "failed", failureReason: `errorcode:${errorcode}` });
      }

      res.status(200).send("ok");
    } catch (err) {
      logger.error("trustWebhook error", { msg: err?.message || err, stack: err?.stack });
      // Return 200 to prevent retry storms on unexpected errors; we have logs.
      res.status(200).send("ok");
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

// allocateTicketsAndAwardTokens (credit path only)
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
    transaction.update(userRef, { creditBalance: FieldValue.increment(-priceToCharge) });

    if (compData.status !== "live") throw new HttpsError("failed-precondition", "Competition is not live.");
    const userEntryCount = (userData.entryCount && userData.entryCount[compId]) ? userData.entryCount[compId] : 0;
    const limit = compData.userEntryLimit || 75;
    if (userEntryCount + ticketsBought > limit) throw new HttpsError("failed-precondition", `Entry limit exceeded.`);
    const ticketsSoldBefore = compData.ticketsSold || 0;
    if (ticketsSoldBefore + ticketsBought > compData.totalTickets) throw new HttpsError("failed-precondition", `Not enough tickets available.`);
    const ticketStartNumber = ticketsSoldBefore;

    transaction.update(compRef, { ticketsSold: FieldValue.increment(ticketsBought) });
    transaction.update(userRef, { [`entryCount.${compId}`]: FieldValue.increment(ticketsBought) });

    const entryRef = db.collection("competitions").doc(compId).collection("entries").doc();
    transaction.set(entryRef, {
      userId: uid,
      userDisplayName: userData.displayName || "N/A",
      ticketsBought,
      ticketStart: ticketStartNumber,
      ticketEnd: ticketStartNumber + ticketsBought - 1,
      enteredAt: nowServer(),
      entryType,
    });

    let awardedTokens = [];
    if (compData.instantWinsConfig?.enabled === true) {
      const newTokens = [];
      const earnedAt = new Date();
      for (let i = 0; i < ticketsBought; i++) {
        newTokens.push({
          tokenId: crypto.randomBytes(16).toString("hex"),
          compId,
          compTitle: compData.title,
          earnedAt,
        });
      }
      transaction.update(userRef, { spinTokens: FieldValue.arrayUnion(...newTokens) });
      awardedTokens = newTokens;
    }

    return { success: true, ticketStart: ticketStartNumber, ticketsBought, awardedTokens };
  });
});

// getRevenueAnalytics
export const getRevenueAnalytics = onCall(functionOptions, async (request) => {
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
      const tier = competitionData.ticketTiers?.find((t) => t.amount === entryData.ticketsBought);
      if (tier) {
        competitionRevenue += tier.price;
      }
    });
    totalRevenue += competitionRevenue;
  }

  const spinWinsSnapshot = await db.collection("spin_wins").where("prizeType", "==", "cash").get();
  let totalCost = 0;
  spinWinsSnapshot.forEach((w) => {
    totalCost += w.data().prizeValue;
  });

  const netProfit = totalRevenue - totalCost;

  const creditAwardedSnapshot = await db.collection("spin_wins").where("prizeType", "==", "credit").get();
  let totalSiteCreditAwarded = 0;
  creditAwardedSnapshot.forEach((w) => {
    totalSiteCreditAwarded += w.data().prizeValue;
  });

  const creditSpentSnapshot = await db.collectionGroup("entries").where("entryType", "==", "credit").get();
  let totalSiteCreditSpent = 0;
  for (const doc of creditSpentSnapshot.docs) {
    const entryData = doc.data();
    const compDoc = await db.collection("competitions").doc(doc.ref.parent.parent.id).get();
    const competitionData = compDoc.data();
    const tier = competitionData.ticketTiers?.find((t) => t.amount === entryData.ticketsBought);
    if (tier) {
      totalSiteCreditSpent += tier.price;
    }
  }

  const ticketsAwardedSnapshot = await db.collection("spin_wins").where("prizeType", "==", "ticket").get();
  let totalTicketsAwarded = 0;
  ticketsAwardedSnapshot.forEach((w) => {
    totalTicketsAwarded += w.data().prizeValue;
  });

  return { success: true, totalRevenue, totalCost, netProfit, totalSiteCreditAwarded, totalSiteCreditSpent, totalTicketsAwarded };
});

// spendSpinToken
export const spendSpinToken = onCall(functionOptions, async (request) => {
  const schema = z.object({ tokenId: z.string().min(1) });
  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", "A valid tokenId is required.");
  }
  const { tokenId } = validation.data;
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
    transaction.update(userRef, { spinTokens: updatedTokens });
    const settingsRef = db.collection("admin_settings").doc("spinnerPrizes");
    const settingsDoc = await settingsRef.get();
    if (!settingsDoc.exists) {
      throw new HttpsError("internal", "Spinner prize configuration is not available.");
    }
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
        finalPrize = { won: true, prizeType: prize.type, value: prize.value, competitionId: prize.competitionId || null };
        break;
      }
    }
    if (finalPrize.won) {
      const winLogRef = db.collection("spin_wins").doc();
      const winPayload = {
        userId: uid,
        prizeType: finalPrize.prizeType,
        prizeValue: finalPrize.value,
        wonAt: nowServer(),
        tokenIdUsed: tokenId,
      };

      if (finalPrize.prizeType === "ticket" && finalPrize.competitionId) {
        winPayload.competitionId = finalPrize.competitionId;

        const compRef = db.collection("competitions").doc(finalPrize.competitionId);
        const compDoc = await transaction.get(compRef);
        if (!compDoc.exists || compDoc.data().status !== 'live') {
            logger.warn(`User ${uid} won tickets for an invalid/ended competition ${finalPrize.competitionId}. Prize not awarded.`);
        } else {
            const compData = compDoc.data();
            const ticketsToAward = finalPrize.value;
            const ticketsSoldBefore = compData.ticketsSold || 0;

            if (ticketsSoldBefore + ticketsToAward > compData.totalTickets) {
                 logger.warn(`Not enough tickets available in competition ${finalPrize.competitionId} to award prize to user ${uid}.`);
            } else {
                transaction.update(compRef, { ticketsSold: FieldValue.increment(ticketsToAward) });
                transaction.update(userRef, { [`entryCount.${finalPrize.competitionId}`]: FieldValue.increment(ticketsToAward) });

                const entryRef = compRef.collection("entries").doc();
                transaction.set(entryRef, {
                    userId: uid,
                    userDisplayName: userData.displayName || "N/A",
                    ticketsBought: ticketsToAward,
                    ticketStart: ticketsSoldBefore,
                    ticketEnd: ticketsSoldBefore + ticketsToAward - 1,
                    enteredAt: nowServer(),
                    entryType: 'spinner_win'
                });
            }
        }
      }

      transaction.set(winLogRef, winPayload);

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
  const schema = z.object({
    amount: z.number().positive("Amount must be a positive number."),
  });

  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", validation.error.errors[0].message);
  }
  const { amount } = validation.data;

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

    return { success: true, newCreditBalance: (userData.creditBalance || 0) + creditToAdd };
  });
});

// requestCashPayout
export const requestCashPayout = onCall(functionOptions, async (request) => {
  const schema = z.object({
    amount: z.number().positive("Amount must be a positive number."),
  });

  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", validation.error.errors[0].message);
  }
  const { amount } = validation.data;

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
  if (!validation.success) {
    throw new HttpsError("invalid-argument", "A valid tokenId is required.");
  }
  const { tokenId } = validation.data;
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
    transaction.update(userRef, { plinkoTokens: updatedTokens });

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

    const prize = payouts[finalSlotIndex] || { type: "credit", value: 0 };
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

// drawWinner (manual)
export const drawWinner = onCall(functionOptions, async (request) => {
  const schema = z.object({ compId: z.string().min(1) });
  const validation = schema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError("invalid-argument", "Competition ID is required.");
  }
  const { compId } = validation.data;

  await assertIsAdmin(request);

  const compRef = db.collection("competitions").doc(compId);
  const compDoc = await compRef.get();
  if (!compDoc.exists || compDoc.data().status !== "ended") {
    throw new HttpsError("failed-precondition", 'Competition must be in "ended" status to be drawn manually.');
  }

  try {
    // NOTE: plug in your real draw implementation here
    const result = { winnerDisplayName: "TBD" };
    return { success: true, ...result };
  } catch (error) {
    logger.error(`Manual draw failed for compId: ${compId}`, error);
    throw new HttpsError("internal", error.message || "An internal error occurred during the draw.");
  }
});

// weeklyTokenCompMaintenance
export const weeklyTokenCompMaintenance = onSchedule(
  {
    schedule: "every monday 12:00",
    timeZone: "Europe/London",
    region: "us-central1",
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
        // plug in draw if available
        // const drawResult = await performDraw(compId);
        // logger.log(`Successfully drew winner for ${compId}: ${drawResult.winnerDisplayName}`);
      } catch (error) {
        logger.error(`Failed to process and draw winner for ${compId}`, error);
      }
    }

    const liveTokenSnapshot = await compsRef.where("competitionType", "==", "token").where("status", "==", "live").get();

    if (liveTokenSnapshot.size < 3) {
      logger.warn(
        `CRITICAL: The pool of live token competitions is low (${liveTokenSnapshot.size}). Admin should create more.`
      );
    }

    return null;
  }
);
