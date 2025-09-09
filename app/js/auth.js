// /app/js/auth.js

// Use consistent, modern Firebase CDN versions
import {
  initializeApp,
  getApps,
  getApp,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// App Check (Enterprise)
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app-check.js";

// --- Firebase config (unchanged) ---
const firebaseConfig = {
  apiKey: "AIzaSyCHnYCOB-Y4tA1_ikShsBZJVD0KJfJJMdU",
  authDomain: "the-hawk-games-64239.firebaseapp.com",
  projectId: "the-hawk-games-64239",
  storageBucket: "the-hawk-games-64239.firebasestorage.app",
  messagingSenderId: "391161456812",
  appId: "1:391161456812:web:48f7264720dff9a70dd709",
  measurementId: "G-DGLYCBJLWF",
};

// --- Initialize Firebase exactly once & export app/auth/db ---
export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// --- App Check (Enterprise) ---
// Make sure the key is enabled in Cloud Console (reCAPTCHA Enterprise).
// Optional: set window.FIREBASE_APPCHECK_DEBUG_TOKEN = true; for local dev.
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider("6LdkDqgrAAAAAAuWtoK941myjHGZd8vka_Q3JhKg"),
    isTokenAutoRefreshEnabled: true,
  });
} catch (e) {
  // If App Check is already initialized or key is misconfigured, don't block UX.
  console.warn("[AppCheck] init warning:", e?.message || e);
}

// -------------------- Auth-driven UI wiring --------------------
let userProfileUnsubscribe = null;

onAuthStateChanged(auth, (user) => {
  renderHeader(user);

  if (user) {
    createUserProfileIfNotExists(user).catch((e) =>
      console.error("Error creating profile:", e)
    );

    // Re-subscribe to the profile doc each auth change
    try {
      userProfileUnsubscribe?.();
    } catch {}
    const userDocRef = doc(db, "users", user.uid);
    userProfileUnsubscribe = onSnapshot(
      userDocRef,
      (docSnap) => {
        const data = docSnap.exists() ? docSnap.data() : {};
        // Example values if you want to surface them in header later:
        // const tokenCount = data.spinTokens?.length || 0;
        // const creditBalance = data.creditBalance || 0;
      },
      (err) => console.warn("[auth] user profile onSnapshot error:", err)
    );
  } else {
    try {
      userProfileUnsubscribe?.();
      userProfileUnsubscribe = null;
    } catch {}
  }

  renderFooter();
});

// Keep header highlighting in sync with hash changes
window.addEventListener("hashchange", () => {
  renderHeader(auth.currentUser);
});

// -------------------- Profile bootstrap --------------------
async function createUserProfileIfNotExists(user) {
  const userRef = doc(db, "users", user.uid);
  const docSnap = await getDoc(userRef);
  if (!docSnap.exists()) {
    const userData = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      createdAt: serverTimestamp(),
      isAdmin: false,
      entryCount: {},
      marketingConsent: false,
      spinTokens: [],
      creditBalance: 0,
    };
    await setDoc(userRef, userData);
  }
}

// -------------------- DOM helpers --------------------
function createElement(tag, options = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (key === "class") {
      const classes = Array.isArray(value) ? value : String(value).split(" ");
      classes.forEach((c) => c && el.classList.add(c));
    } else if (key === "textContent") {
      el.textContent = value;
    } else {
      el.setAttribute(key, value);
    }
  });
  (Array.isArray(children) ? children : [children]).forEach((child) => child && el.append(child));
  return el;
}

// -------------------- Header --------------------
function renderHeader(user) {
  const headerEl = document.querySelector(".main-header");
  if (!headerEl) return;
  headerEl.innerHTML = "";

  // Remove previous overlay to prevent duplicates
  document.getElementById("mobile-nav-overlay")?.remove();

  const devBanner = createElement("div", {
    class: "dev-banner",
    textContent:
      "Currently under development. Any tickets acquired or prizes won will not be valid or redeemable, even after full launch.",
  });
  headerEl.append(devBanner);

  let currentPage = document.body.dataset.page || "";
  if (window.location.pathname.endsWith("index.html") && window.location.hash === "#past-winners-section") {
    currentPage = "winners";
  }

  const createNavLinks = () => {
    const navItems = [
      { href: "index.html", page: "competitions", text: "Competitions" },
      { href: "showcase.html", page: "showcase", text: "Showcase" },
      { href: "index.html#past-winners-section", page: "winners", text: "Winners" },
      { href: "terms-and-conditions.html", page: "terms", text: "Terms" },
    ];

    const links = navItems.map((item) =>
      createElement("a", { href: item.href, class: currentPage === item.page ? "active" : "" }, [item.text])
    );

    if (user) {
      links.push(
        createElement("a", { href: "account.html", class: currentPage === "account" ? "active" : "" }, ["Account"])
      );
    } else {
      links.push(
        createElement("a", { href: "login.html", class: currentPage === "login" ? "active" : "" }, ["Login"])
      );
    }

    const instantWinLink = createElement(
      "a",
      { href: "instant-games.html", class: `btn ${currentPage === "instant-wins" ? "active" : ""}` },
      ["Instant Wins"]
    );
    links.push(instantWinLink);
    return links;
  };

  const logoLink = createElement("a", { href: "index.html", class: "logo" }, [
    createElement("img", { src: "assets/logo-icon.png", alt: "The Hawk Games" }),
  ]);
  const desktopNav = createElement("nav", { class: "main-nav-desktop" }, createNavLinks());
  const hamburgerBtn = createElement(
    "button",
    { id: "hamburger-btn", class: "hamburger-btn", "aria-label": "Open menu" },
    [createElement("span"), createElement("span"), createElement("span")]
  );

  const container = createElement("div", { class: "container" }, [logoLink, desktopNav, hamburgerBtn]);

  const mobileNav = createElement("nav", { class: "mobile-nav-links" }, createNavLinks());
  const mobileOverlay = createElement("div", { id: "mobile-nav-overlay", class: "mobile-nav-overlay" }, [mobileNav]);

  headerEl.append(container);
  document.body.append(mobileOverlay);

  hamburgerBtn.addEventListener("click", () => {
    const body = document.body;
    const isOpen = body.classList.contains("mobile-nav-open");
    if (isOpen) {
      body.classList.remove("mobile-nav-open");
      body.classList.remove("noscroll");
      const scrollY = body.style.top;
      body.style.top = "";
      window.scrollTo(0, parseInt(scrollY || "0") * -1);
    } else {
      const scrollY = window.scrollY;
      body.style.top = `-${scrollY}px`;
      body.classList.add("noscroll");
      body.classList.add("mobile-nav-open");
    }
  });

  mobileNav.addEventListener("click", (e) => {
    if (e.target.tagName === "A" || e.target.closest("a")) {
      document.body.classList.remove("mobile-nav-open");
    }
  });
}

// -------------------- Footer --------------------
function renderFooter() {
  const footerEl = document.querySelector(".main-footer");
  if (!footerEl) return;
  footerEl.innerHTML = "";

  // Column 1: Brand
  const brandColumn = createElement("div", { class: "footer-column footer-brand" }, [
    createElement("img", { src: "assets/logo.png", alt: "The Hawk Games Logo", class: "logo" }),
    createElement("p", {
      class: "tagline",
      textContent:
        "Your home for skill-based prize competitions. Enter today for a chance to win life-changing prizes.",
    }),
  ]);

  // Column 2: Legal
  const legalLinks = createElement("ul", {}, [
    createElement("li", {}, [createElement("a", { href: "terms-and-conditions.html", textContent: "Terms & Conditions" })]),
    createElement("li", {}, [createElement("a", { href: "privacy-policy.html", textContent: "Privacy Policy" })]),
    createElement("li", {}, [createElement("a", { href: "free-entry-route.html", textContent: "Free Entry Route" })]),
    createElement("li", {}, [createElement("a", { href: "faq.html", textContent: "FAQ" })]),
  ]);
  const linksColumn = createElement("div", { class: "footer-column footer-links" }, [
    createElement("h4", { textContent: "Legal" }),
    legalLinks,
  ]);

  // Column 3: Social
  const socialIcons = createElement("div", { class: "footer-social-icons" }, [
    createElement("a", { href: "#", "aria-label": "Facebook", target: "_blank", rel: "noopener noreferrer" }, [
      createElement("svg", { viewBox: "0 0 24 24" }, [
        createElement("path", {
          d: "M9 8h-3v4h3v12h5v-12h3.642l.358-4h-4v-1.667c0-.955.192-1.333 1.115-1.333h2.885v-5h-3.808c-3.596 0-5.192 1.583-5.192 4.615v3.385z",
        }),
      ]),
    ]),
    createElement("a", { href: "#", "aria-label": "Instagram", target: "_blank", rel: "noopener noreferrer" }, [
      createElement("svg", { viewBox: "0 0 24 24" }, [
        createElement("path", {
          d: "M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.85s-.012 3.584-.07 4.85c-.148 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07s-3.584-.012-4.85-.07c-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.85s.012-3.584.07-4.85c.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.85-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948s.014 3.667.072 4.947c.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072s3.667-.014 4.947-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.947s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.689-.073-4.948-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.162 6.162 6.162 6.162-2.759 6.162-6.162-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4s1.791-4 4-4 4 1.79 4 4-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.441 1.441 1.441 1.441-.645 1.441-1.441-.645-1.44-1.441-1.44z",
        }),
      ]),
    ]),
    createElement("a", { href: "#", "aria-label": "X Twitter", target: "_blank", rel: "noopener noreferrer" }, [
      createElement("svg", { viewBox: "0 0 24 24" }, [
        createElement("path", {
          d: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.617l-5.21-6.817-6.044 6.817h-3.308l7.73-8.805-7.994-10.69h6.77l4.613 6.162 5.432-6.162zm-1.146 17.52h1.839l-9.424-12.59h-1.99l9.575 12.59z",
        }),
      ]),
    ]),
  ]);
  const socialColumn = createElement("div", { class: "footer-column footer-social" }, [
    createElement("h4", { textContent: "Follow Us" }),
    socialIcons,
  ]);

  // Bottom bar
  const copyright =
    createElement("p", { class: "footer-copyright", textContent: `© ${new Date().getFullYear()} Hawk Games Ltd.` });
  const recaptchaNotice = createElement("p", { class: "recaptcha-notice" }, [
    "This site is protected by reCAPTCHA and the Google ",
    createElement("a", { href: "https://policies.google.com/privacy", target: "_blank", rel: "noopener noreferrer" }, [
      "Privacy Policy",
    ]),
    " and ",
    createElement("a", { href: "https://policies.google.com/terms", target: "_blank", rel: "noopener noreferrer" }, [
      "Terms of Service",
    ]),
    " apply.",
  ]);
  const bottomBarContainer = createElement("div", { class: "container" }, [copyright, recaptchaNotice]);
  const bottomBar = createElement("div", { class: "footer-bottom-bar" }, [bottomBarContainer]);

  const container = createElement("div", { class: "container" }, [brandColumn, linksColumn, socialColumn]);
  footerEl.append(container, bottomBar);
}

// -------------------- Login button (Google) wiring --------------------
document.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("google-login-btn");
  const termsCheckbox = document.getElementById("terms-agree-checkbox");

  if (loginBtn && termsCheckbox) {
    termsCheckbox.addEventListener("change", () => {
      loginBtn.disabled = !termsCheckbox.checked;
    });

    loginBtn.addEventListener("click", async () => {
      if (!termsCheckbox.checked) {
        alert("Please agree to the terms and confirm your age before proceeding.");
        return;
      }
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
        window.location.href = "account.html";
      } catch (error) {
        console.error("Google Sign-In Error:", error);
      }
    });
  }
});
