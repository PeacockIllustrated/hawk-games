// /app/js/auth.js
// Firebase v9 (modular, CDN ESM) initialisation with App Check (STANDARD reCAPTCHA v3)
// Merged from your current file + fixes from my proposal.
// - Preserves header/footer rendering, user profile bootstrap, and indicators
// - Uses ReCaptchaV3Provider (NOT Enterprise)
// - Safe single initialisation via getApps()/getApp()
// - Exports app, auth, db, functions, analytics, FieldValue, and appCheck

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  onSnapshot,
  increment,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app-check.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-analytics.js";

// -------------------------------------------------------------------------------------
// Your Firebase configuration (unchanged)
const firebaseConfig = {
  apiKey: "AIzaSyCHnYCOB-Y4tA1_ikShsBZJVD0KJfJJMdU",
  authDomain: "the-hawk-games-64239.firebaseapp.com",
  projectId: "the-hawk-games-64239",
  storageBucket: "the-hawk-games-64239.firebasestorage.app",
  messagingSenderId: "391161456812",
  appId: "1:391161456812:web:48f7264720dff9a70dd709",
  measurementId: "G-DGLYCBJLWF",
};

// IMPORTANT: this must be a STANDARD reCAPTCHA v3 site key that you registered
// in Firebase App Check for THIS web app (not Enterprise).
const RECAPTCHA_V3_SITE_KEY = "6Lf1JqgrAAAAAEwhulQ8N2tGOr52j8SWvdyJeH7x";

// -------------------------------------------------------------------------------------
// Initialise (single instance safe)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// App Check (STANDARD reCAPTCHA v3). Set any debug token BEFORE init (dev only).
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  // One-off: uncomment to generate a token in console, then register it in App Check.
  // self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;

  // Or paste your registered debug token here for local builds:
  // self.FIREBASE_APPCHECK_DEBUG_TOKEN = "<PASTE_YOUR_DEBUG_TOKEN>";
}

const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});

// Core services
const auth = getAuth(app);
const db = getFirestore(app);
// If your functions are deployed to a specific region (e.g. "europe-west2"),
// set it like: getFunctions(app, "europe-west2")
const functions = getFunctions(app);

// Analytics (optional; safe-guarded for unsupported contexts)
let analytics = null;
try {
  analytics = getAnalytics(app);
} catch (_) {
  // Not available in this environment – ignore.
}

// FieldValue shim for legacy-style usage in other modules (if any)
export const FieldValue = {
  serverTimestamp,
  increment,
  Timestamp,
};

// -------------------------------------------------------------------------------------
// --- Global Auth State Listener ---
let userProfileUnsubscribe = null;

onAuthStateChanged(auth, (user) => {
  renderHeader(user);

  if (user) {
    createUserProfileIfNotExists(user);

    if (userProfileUnsubscribe) userProfileUnsubscribe();

    const userDocRef = doc(db, "users", user.uid);
    userProfileUnsubscribe = onSnapshot(
      userDocRef,
      (docSnap) => {
        const data = docSnap.exists() ? docSnap.data() : {};
        const tokenCount = Array.isArray(data.spinTokens) ? data.spinTokens.length : 0;
        const creditBalance = Number(data.creditBalance || 0);

        updateIndicator(
          "spin-token-indicator",
          tokenCount,
          (el, count) => (el.querySelector(".token-count").textContent = String(count))
        );
        updateIndicator(
          "mobile-spin-token-indicator",
          tokenCount,
          (el, count) => (el.querySelector(".token-count").textContent = String(count))
        );

        updateIndicator(
          "credit-balance-indicator",
          creditBalance,
          (el, val) => (el.querySelector(".credit-amount").textContent = `£${val.toFixed(2)}`),
          creditBalance > 0
        );
        updateIndicator(
          "mobile-credit-balance-indicator",
          creditBalance,
          (el, val) => (el.querySelector(".credit-amount").textContent = `£${val.toFixed(2)}`),
          creditBalance > 0
        );
      },
      (err) => {
        console.warn("[auth.js] user profile snapshot error:", err);
      }
    );
  } else {
    if (userProfileUnsubscribe) {
      userProfileUnsubscribe();
      userProfileUnsubscribe = null;
    }
  }

  renderFooter();
});

function updateIndicator(id, value, updateFn, condition = value > 0) {
  const el = document.getElementById(id);
  if (!el) return;
  if (condition) {
    updateFn(el, value);
    el.style.display = "flex";
  } else {
    el.style.display = "none";
  }
}

window.addEventListener("hashchange", () => {
  renderHeader(auth.currentUser);
});

const createUserProfileIfNotExists = async (user) => {
  const userRef = doc(db, "users", user.uid);
  const docSnap = await getDoc(userRef);
  if (!docSnap.exists()) {
    const userData = {
      uid: user.uid,
      email: user.email || null,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      createdAt: serverTimestamp(),
      isAdmin: false,
      entryCount: {},
      marketingConsent: false,
      spinTokens: [],
      creditBalance: 0,
    };
    try {
      await setDoc(userRef, userData, { merge: true });
    } catch (error) {
      console.error("Error creating new user profile:", error);
    }
  }
};

// --- SECURITY: safe element creation (no innerHTML templating) ---
function createElement(tag, options = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (key === "class") {
      const classes = Array.isArray(value) ? value : String(value).split(" ");
      classes.forEach((c) => {
        if (c) el.classList.add(c);
      });
    } else if (key === "textContent") {
      el.textContent = value;
    } else {
      el.setAttribute(key, value);
    }
  });
  children.forEach((child) => child && el.append(child));
  return el;
}

function renderHeader(user) {
  const headerEl = document.querySelector(".main-header");
  if (!headerEl) return;
  headerEl.innerHTML = "";

  let currentPage = document.body.dataset.page || "";
  if (window.location.pathname.endsWith("index.html") && window.location.hash === "#past-winners-section") {
    currentPage = "winners";
  }

  const createNavLinks = (isMobile = false) => {
    const navItems = [
      { href: "index.html", page: "competitions", text: "Competitions" },
      { href: "index.html#past-winners-section", page: "winners", text: "Winners" },
      { href: "terms-and-conditions.html", page: "terms", text: "Terms" },
    ];

    const links = navItems.map((item) =>
      createElement("a", { href: item.href, class: currentPage === item.page ? "active" : "" }, [item.text])
    );

    if (user) {
      links.push(createElement("a", { href: "account.html", class: currentPage === "account" ? "active" : "" }, ["Account"]));
      links.push(
        createElement(
          "div",
          { id: `${isMobile ? "mobile-" : ""}credit-balance-indicator`, class: "credit-balance", style: "display: none;" },
          [createElement("span", { class: "credit-amount" }, ["£0.00"])]
        )
      );
    } else {
      links.push(createElement("a", { href: "login.html", class: currentPage === "login" ? "active" : "" }, ["Login"]));
    }

    const instantWinLink = createElement("a", { href: "instant-games.html", class: `btn ${currentPage === "instant-wins" ? "active" : ""}` }, ["Instant Wins"]);
    const tokenIndicator = createElement(
      "div",
      { id: `${isMobile ? "mobile-" : ""}spin-token-indicator`, class: "token-indicator", style: "display: none;" },
      [createElement("span", { class: "token-icon" }), createElement("span", { class: "token-count" }, ["0"])]
    );
    const instantWinNavItem = createElement("div", { class: "instant-win-nav-item" }, [instantWinLink, tokenIndicator]);

    links.push(instantWinNavItem);
    return links;
  };

  const logoLink = createElement("a", { href: "index.html", class: "logo" }, [
    createElement("img", { src: "assets/logo-icon.png", alt: "The Hawk Games" }),
  ]);
  const desktopNav = createElement("nav", { class: "main-nav-desktop" }, createNavLinks(false));
  const hamburgerBtn = createElement("button", { id: "hamburger-btn", class: "hamburger-btn", "aria-label": "Open menu" }, [
    createElement("span"),
    createElement("span"),
    createElement("span"),
  ]);
  const container = createElement("div", { class: "container" }, [logoLink, desktopNav, hamburgerBtn]);

  const mobileNav = createElement("nav", { class: "mobile-nav-links" }, createNavLinks(true));
  const mobileOverlay = createElement("div", { id: "mobile-nav-overlay", class: "mobile-nav-overlay" }, [mobileNav]);

  headerEl.append(container, mobileOverlay);

  hamburgerBtn.addEventListener("click", () => {
    document.body.classList.toggle("mobile-nav-open");
  });

  mobileNav.addEventListener("click", (e) => {
    if (e.target.tagName === "A" || e.target.closest("a")) {
      document.body.classList.remove("mobile-nav-open");
    }
  });
}

function renderFooter() {
  const footerEl = document.querySelector(".main-footer");
  if (!footerEl) return;
  footerEl.innerHTML = "";

  const copyright = createElement("div", { class: "copyright" }, [
    createElement("p", { textContent: `© ${new Date().getFullYear()} Hawk Games Ltd.` }),
  ]);
  const footerLinks = createElement("div", { class: "footer-links" }, [
    createElement("a", { href: "terms-and-conditions.html" }, ["T&Cs"]),
    createElement("a", { href: "privacy-policy.html" }, ["Privacy"]),
    createElement("a", { href: "free-entry-route.html" }, ["Free Entry"]),
  ]);
  const container = createElement("div", { class: "container" }, [copyright, footerLinks]);

  footerEl.append(container);
}

document.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("google-login-btn");
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
        window.location.href = "account.html";
      } catch (error) {
        console.error("Google Sign-In Error:", error);
      }
    });
  }
});

// -------------------------------------------------------------------------------------
// Exports (so other modules can reuse initialised services if needed)
export { app, appCheck, auth, db, functions, analytics, GoogleAuthProvider, signInWithPopup, signOut };
