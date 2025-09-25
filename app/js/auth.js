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
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

import { FEATURES } from "./features.js";

import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app-check.js";

// Your web app's Firebase configuration
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
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider("6LdkDqgrAAAAAAuWtoK941myjHGZd8vka_Q3JhKg"),
    isTokenAutoRefreshEnabled: true,
  });
} catch (e) {
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

    // Listen to user doc for UX indicators etc.
    if (userProfileUnsubscribe) userProfileUnsubscribe();
    const userDocRef = doc(db, "users", user.uid);
    userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
      const data = docSnap.exists() ? docSnap.data() : {};
      // Example UI updates here (token counts, credit, etc.) if needed
    });
  } else {
    if (userProfileUnsubscribe) {
      userProfileUnsubscribe();
      userProfileUnsubscribe = null;
    }
  }

  renderFooter();
});

export function requireVerifiedEmail() {
    return new Promise((resolve) => {
        const checkVerification = () => {
            const user = auth.currentUser;
            if (user && user.emailVerified) {
                resolve(true);
            } else if (user) {
                // User is logged in but email is not verified
                showVerificationGate();
                resolve(false);
            } else {
                // User is not logged in, redirect to login
                window.location.href = 'login.html';
                resolve(false);
            }
        };

        if (auth.currentUser) {
            checkVerification();
        } else {
            onAuthStateChanged(auth, (user) => {
                if (user) {
                    checkVerification();
                } else {
                    window.location.href = 'login.html';
                    resolve(false);
                }
            }, () => {
                window.location.href = 'login.html';
                resolve(false);
            });
        }
    });
}

function showVerificationGate() {
    const gate = document.createElement('div');
    gate.style.position = 'fixed';
    gate.style.top = '0';
    gate.style.left = '0';
    gate.style.width = '100%';
    gate.style.height = '100%';
    gate.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    gate.style.color = 'white';
    gate.style.display = 'flex';
    gate.style.justifyContent = 'center';
    gate.style.alignItems = 'center';
    gate.style.zIndex = '1000';
    gate.innerHTML = `
        <div style="text-align: center; padding: 2rem; background: var(--card-bg); border-radius: 5px;">
            <h2>Email Verification Required</h2>
            <p>You must verify your email address before you can perform this action.</p>
            <p>A verification email was sent to you. Please check your inbox.</p>
            <button id="gate-resend-btn" class="btn">Resend Verification</button>
            <a href="/login.html" style="display: block; margin-top: 1rem; color: var(--primary-gold);">Logout</a>
        </div>
    `;
    document.body.appendChild(gate);

    document.getElementById('gate-resend-btn').addEventListener('click', async () => {
        try {
            await sendEmailVerification(auth.currentUser);
            alert('A new verification email has been sent.');
        } catch (error) {
            alert('Error sending verification email. Please try again later.');
        }
    });
}

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
  children.forEach((child) => child && el.append(child));
  return el;
}

// -------------------- Header --------------------
export function renderHeader(user) {
  const headerEl = document.querySelector(".main-header");
  if (!headerEl) return;
  headerEl.innerHTML = "";

  // Clean previous overlay to prevent duplicates
  const existingOverlay = document.getElementById("mobile-nav-overlay");
  if (existingOverlay) existingOverlay.remove();

  let currentPage = document.body.dataset.page || "";
  if (
    window.location.pathname.endsWith("index.html") &&
    window.location.hash === "#past-winners-section"
  ) {
    currentPage = "winners";
  }

  const createNavLinks = () => {
    const navItems = [
      { href: "index.html", page: "competitions", text: "Competitions" },
     // { href: "showcase.html", page: "showcase", text: "Showcase" },
      { href: "index.html#past-winners-section", page: "winners", text: "Winners" },
      { href: "terms-and-conditions.html", page: "terms", text: "Terms" },
    ];

    const links = navItems.map((item) =>
      createElement("a", { href: item.href, class: currentPage === item.page ? "active" : "" }, [
        item.text,
      ])
    );

    if (user) {
      links.push(
        createElement("a", { href: "account.html", class: currentPage === "account" ? "active" : "" }, [
          "Account",
        ])
      );
    } else {
      links.push(
        createElement("a", { href: "login.html", class: currentPage === "login" ? "active" : "" }, [
          "Login",
        ])
      );
    }

    if (FEATURES.instantWins) {
      const instantWinLink = createElement("a", { href: "instant-games.html", class: `btn ${currentPage === "instant-wins" ? "active" : ""}` }, [
        "Instant Wins",
      ]);
      links.unshift(instantWinLink);
    }
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
  const mobileOverlay = createElement("div", { id: "mobile-nav-overlay", class: "mobile-nav-overlay" }, [
    mobileNav,
  ]);

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
export function renderFooter() {
  const footerEl = document.querySelector(".main-footer");
  if (!footerEl) return;
  footerEl.innerHTML = "";

  const brandColumn = createElement("div", { class: "footer-column footer-brand" }, [
    createElement("img", { src: "assets/logo.png", alt: "The Hawk Games Logo", class: "logo" }),
    createElement("p", {
      class: "tagline",
      textContent:
        "Your home for skill-based prize competitions. Enter today for a chance to win life-changing prizes.",
    }),
  ]);

  const legalLinks = createElement("ul", {}, [
    createElement("li", {}, [
      createElement("a", { href: "terms-and-conditions.html", textContent: "Terms & Conditions" }),
    ]),
    createElement("li", {}, [createElement("a", { href: "privacy-policy.html", textContent: "Privacy Policy" })]),
    createElement("li", {}, [createElement("a", { href: "free-entry-route.html", textContent: "Free Entry Route" })]),
    createElement("li", {}, [createElement("a", { href: "faq.html", textContent: "FAQ" })]),
  ]);
  const linksColumn = createElement("div", { class: "footer-column footer-links" }, [
    createElement("h4", { textContent: "Legal" }),
    legalLinks,
  ]);

  const socialIcons = createElement("div", { class: "footer-social-icons" }, [
    createElement(
      "a",
      {
        href: "https://www.facebook.com/profile.php?id=61580013034678",
        "aria-label": "Facebook",
        target: "_blank",
        rel: "noopener noreferrer",
      },
      [
        createElement("svg", { viewBox: "0 0 24 24" }, [
          createElement("path", {
            d: "M9 8h-3v4h3v12h5v-12h3.642l.358-4h-4v-1.667c0-.955.192-1.333 1.115-1.333h2.885v-5h-3.808c-3.596 0-5.192 1.583-5.192 4.615v3.385z",
          }),
        ]),
      ]
    ),
    createElement(
      "a",
      { href: "#", "aria-label": "Instagram", target: "_blank", rel: "noopener noreferrer" },
      [
        createElement("svg", { viewBox: "0 0 24 24" }, [
          createElement("path", {
            d: "M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.85s-.012 3.584-.07 4.85c-.148 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07s-3.584-.012-4.85-.07c-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.85s.012-3.584.07-4.85c.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.85-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948s.014 3.667.072 4.947c.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072s3.667-.014 4.947-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.947s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.689-.073-4.948-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.162 6.162 6.162 6.162-2.759 6.162-6.162-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4s1.791-4 4-4 4 1.79 4 4-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.441 1.441 1.441 1.441-.645 1.441-1.441-.645-1.44-1.441-1.44z",
          }),
        ]),
      ]
    ),
    createElement(
      "a",
      { href: "#", "aria-label": "TikTok", target: "_blank", rel: "noopener noreferrer" },
      [
        createElement("svg", { viewBox: "0 0 24 24" }, [
          createElement("path", {
            d: "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.01-3.48.01-6.95.01-10.42-2.52-.01-5.04-.02-7.57 0-.01 2.21-.01 4.41.01 6.62 1.78-.35 3.57-.64 5.35-.99v4.02c-1.87.31-3.74.63-5.61.97v3.83c-1.84-.3-3.68-.61-5.52-.92V1.99c1.83.29 3.67.61 5.51.92V.02h1.84z",
          }),
        ]),
      ]
    ),
  ]);
  const socialColumn = createElement("div", { class: "footer-column footer-social" }, [
    createElement("h4", { textContent: "Follow Us" }),
    socialIcons,
  ]);

  const copyrightNotice = createElement("p", {
    class: "footer-copyright",
    textContent: `© ${new Date().getFullYear()} Hawk Games Ltd.`,
  });
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

  const bottomBarContainer = createElement("div", { class: "container" }, [
    copyrightNotice,
    recaptchaNotice,
  ]);
  const bottomBar = createElement("div", { class: "footer-bottom-bar" }, [bottomBarContainer]);

  const container = createElement("div", { class: "container" }, [brandColumn, linksColumn, socialColumn]);
  footerEl.append(container, bottomBar);
}

// -------------------- Login wiring --------------------
document.addEventListener("DOMContentLoaded", () => {
    const page = document.body.dataset.page;

    if (page === 'login') {
        const googleLoginBtn = document.getElementById("google-login-btn");
        const termsCheckbox = document.getElementById("terms-agree-checkbox");
        const emailPasswordForm = document.getElementById('email-password-form');
        const authSubmitBtn = document.getElementById('auth-submit-btn');
        const authModeToggle = document.getElementById('auth-mode-toggle');
        const authTitle = document.getElementById('auth-title');
        const authSubtitle = document.getElementById('auth-subtitle');
        const nameGroup = document.getElementById('name-group');
        const passwordPolicy = document.getElementById('password-policy');
        const authModeText = document.getElementById('auth-mode-text');
        const forgotPasswordLink = document.getElementById('forgot-password-link');
        const authError = document.getElementById('auth-error');

        let isRegisterMode = false;
        let failedLoginAttempts = 0;
        let loginTimeout = null;

        const setAuthMode = (register) => {
            isRegisterMode = register;
            authTitle.textContent = register ? 'Register' : 'Sign In';
            authSubtitle.textContent = register ? 'Create a new account.' : 'Enter your details to access your account.';
            authSubmitBtn.textContent = register ? 'Register' : 'Sign In';
            nameGroup.style.display = register ? 'block' : 'none';
            passwordPolicy.style.display = register ? 'block' : 'none';
            authModeText.textContent = register ? 'Already have an account?' : "Don't have an account?";
            authModeToggle.textContent = register ? 'Sign In' : 'Register';
            forgotPasswordLink.style.display = register ? 'none' : 'block';
        };

        authModeToggle.addEventListener('click', () => setAuthMode(!isRegisterMode));

        termsCheckbox.addEventListener("change", () => {
            authSubmitBtn.disabled = !termsCheckbox.checked;
        });
        authSubmitBtn.disabled = !termsCheckbox.checked;


        const showError = (message) => {
            authError.textContent = message;
            authError.style.display = 'block';
        };

        const hideError = () => {
            authError.textContent = '';
            authError.style.display = 'none';
        };

        const validatePassword = (password) => {
            const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
            return regex.test(password);
        };

        emailPasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideError();

            if (!termsCheckbox.checked) {
                showError("Please agree to the terms and confirm your age before proceeding.");
                return;
            }

            const email = emailPasswordForm.email.value;
            const password = emailPasswordForm.password.value;
            const name = emailPasswordForm.name.value;

            try {
                if (isRegisterMode) {
                    // Register
                    if (!validatePassword(password)) {
                        showError("Password does not meet the policy requirements.");
                        return;
                    }
                    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                    await updateProfile(userCredential.user, { displayName: name });
                    await sendEmailVerification(userCredential.user);
                    window.location.href = "verify-email.html";
                } else {
                    // Login
                    if (loginTimeout) {
                        showError("Too many failed attempts. Please try again later.");
                        return;
                    }
                    await signInWithEmailAndPassword(auth, email, password);
                    failedLoginAttempts = 0; // reset on success
                    window.location.href = "account.html";
                }
            } catch (error) {
                if (error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found') {
                    failedLoginAttempts++;
                    if (failedLoginAttempts >= 3) {
                        showError("Too many failed attempts. Please wait 60 seconds.");
                        authSubmitBtn.disabled = true;
                        setTimeout(() => {
                            authSubmitBtn.disabled = false;
                            failedLoginAttempts = 0;
                            hideError();
                        }, 60000);
                    } else {
                        showError("Invalid email or password.");
                    }
                } else if (error.code === 'auth/email-already-in-use') {
                    showError("An account with this email already exists.");
                } else {
                    showError("An unexpected error occurred. Please try again.");
                }
                console.error("Auth Error:", error);
            }
        });

        googleLoginBtn.addEventListener("click", async () => {
            if (!termsCheckbox.checked) {
                showError("Please agree to the terms and confirm your age before proceeding.");
                return;
            }
            try {
                await signInWithPopup(auth, new GoogleAuthProvider());
                window.location.href = "account.html";
            } catch (error) {
                showError("Failed to sign in with Google. Please try again.");
                console.error("Google Sign-In Error:", error);
            }
        });

        forgotPasswordLink.addEventListener('click', async (e) => {
            e.preventDefault();
            const email = prompt("Please enter your email address to reset your password:");
            if (email) {
                try {
                    await sendPasswordResetEmail(auth, email);
                    alert("A password reset link has been sent to your email.");
                } catch (error) {
                    alert("Failed to send password reset email. Please check the email address and try again.");
                    console.error("Password Reset Error:", error);
                }
            }
        });

    }
});
