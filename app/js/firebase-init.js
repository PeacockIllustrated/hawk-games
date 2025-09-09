// /app/js/firebase-init.js
// ESM + CDN; safe for static pages like success.html

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js";

// Use your real keys. Defaults are based on your project slug; fill the placeholders.
const DEFAULT_CONFIG = {
  apiKey: "AIzaSyCHnYCOB-Y4tA1_ikShsBZJVD0KJfJJMdU",
  authDomain: "the-hawk-games-64239.firebaseapp.com",
  projectId: "the-hawk-games-64239",
  storageBucket: "the-hawk-games-64239.firebasestorage.app",
  messagingSenderId: "391161456812",
  appId: "1:391161456812:web:48f7264720dff9a70dd709",
  measurementId: "G-DGLYCBJLWF"
};

function resolveConfig() {
  // Prefer a globally injected config on any page (no hardcoding in files)
  if (typeof window !== "undefined" && window.__FIREBASE_CONFIG__) return window.__FIREBASE_CONFIG__;
  // Or a <meta name="firebase-config" content='{"..."}'>
  const tag = typeof document !== "undefined" && document.querySelector('meta[name="firebase-config"]');
  if (tag) { try { return JSON.parse(tag.content); } catch {} }
  return DEFAULT_CONFIG;
}

const cfg = resolveConfig();
if (!cfg || !cfg.apiKey || !cfg.projectId) {
  throw new Error("[firebase-init] Missing Firebase config. Provide window.__FIREBASE_CONFIG__ or edit DEFAULT_CONFIG.");
}

const app = getApps().length ? getApps()[0] : initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "us-central1");

// Optional: App Check (recommended). Set window.__APP_CHECK_KEY__ on pages you want protected.
try {
  const siteKey = typeof window !== "undefined" ? window.__APP_CHECK_KEY__ : null;
  if (siteKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true
    });
  }
} catch (e) {
  console.info("[firebase-init] App Check not initialised:", e?.message || e);
}

export { app, auth, db, functions };
