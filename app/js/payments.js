// payments.js
// Unified payment helpers for Hawk Games.
// Handles Trust Payments HPP (card) flow and site-credit checkout flow.

// --- Firebase Imports ---
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

const functions = getFunctions(app);

// --- HPP Helpers (Trust Payments) ---

/**
 * Create and submit a hidden POST form to the Trust Payments HPP endpoint.
 * @param {string} endpoint - Trust Payments HPP endpoint
 * @param {Record<string,string>} fields - field map returned by server
 */
function postToHPP(endpoint, fields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = endpoint;

  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = String(value ?? "");
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
}

/**
 * Start a card checkout using Trust Payments Hosted Payment Page (HPP).
 * The server validates pricing and returns endpoint+fields.
 * @param {Object} intent - purchase intent (e.g. {type:'tickets', compId, ticketsBought})
 */
export async function payByCard(intent) {
  const createTrustOrder = httpsCallable(functions, "createTrustOrder");
  const { data } = await createTrustOrder({ intent });

  if (!data || !data.endpoint || !data.fields) {
    throw new Error("Unable to start payment: invalid response from server.");
  }
  postToHPP(data.endpoint, data.fields);
}

// --- Site Credit Helpers ---

/**
 * Checkout using site credit balance.
 * Calls allocateTicketsAndAwardTokens (or other relevant credit flow).
 * @param {Object} intent - purchase intent, e.g. {compId, ticketsBought}
 */
export async function payByCredit(intent) {
  const allocateTicketsAndAwardTokens = httpsCallable(functions, "allocateTicketsAndAwardTokens");

  // Construct payload for credit path
  const payload = {
    compId: intent.compId,
    ticketsBought: intent.ticketsBought,
    paymentMethod: 'credit'
  };

  const result = await allocateTicketsAndAwardTokens(payload);
  return result.data; // caller handles success UI
}
