// payments.js
// Unified payment helpers for Hawk Games.
// Handles Trust Payments HPP (card) flow and site-credit checkout flow.

// --- Firebase Imports ---
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from "./auth.js";

// Explicit region to match Functions v2 deployment ("us-central1")
const functions = getFunctions(app, "us-central1");

// --- HPP Helpers (Trust Payments) ---

/**
 * Create and submit a hidden POST form to the Trust Payments HPP endpoint.
 * @param {string} endpoint - Trust Payments HPP endpoint
 * @param {Record<string,string|number|boolean|null|undefined>} fields - field map returned by server
 */
function postToHPP(endpoint, fields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = String(endpoint);

  for (const [name, value] of Object.entries(fields || {})) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    // Trust expects string values; coerce safely
    input.value = value == null ? "" : String(value);
    form.appendChild(input);
  }

  // Submit
  document.body.appendChild(form);
  form.submit();

  // Best-effort cleanup
  setTimeout(() => form.remove(), 10_000);
}

/**
 * Start a card checkout using Trust Payments Hosted Payment Page (HPP).
 * The server validates pricing and returns endpoint+fields.
 * @param {object} params
 * @param {string} params.compId - Competition ID
 * @param {number} params.qty - Number of tickets (>= 1)
 */
export async function payByCard({ compId, qty }) {
  // Basic client-side guards (server will re-validate)
  if (!compId || typeof compId !== "string") {
    throw new Error("compId missing on client");
  }
  const nQty = Number.isFinite(Number(qty)) ? Math.max(1, Number(qty)) : 1;

  const createTrustOrder = httpsCallable(functions, "createTrustOrder");
  const { data } = await createTrustOrder({ compId, qty: nQty });

  if (!data || typeof data !== "object") {
    throw new Error("Unable to start payment: empty server response.");
  }
  const { endpoint, fields } = data;
  if (!endpoint || !fields || typeof fields !== "object") {
    throw new Error("Unable to start payment: invalid response from server.");
  }

  // fields includes notificationpassword, sitereference, orderreference, etc.
  postToHPP(endpoint, fields);
}

// --- Site Credit Helpers ---

/**
 * Checkout using site credit balance.
 * Calls allocateTicketsAndAwardTokens (credit flow).
 * @param {Object} intent - purchase intent, e.g. { compId, ticketsBought }
 */
export async function payByCredit(intent) {
  const allocateTicketsAndAwardTokens = httpsCallable(
    functions,
    "allocateTicketsAndAwardTokens"
  );

  const payload = {
    compId: String(intent.compId || ""),
    ticketsBought: Math.max(1, Number(intent.ticketsBought || 1)),
    paymentMethod: "credit",
  };

  const result = await allocateTicketsAndAwardTokens(payload);
  return result?.data;
}
