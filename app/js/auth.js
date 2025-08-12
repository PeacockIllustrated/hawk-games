// This is the functional `retrocomps/js/auth.js` file, adapted for The Hawk Games.
// The core logic is the same, but `renderHeader` and `renderFooter` are new.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCHnYCOB-Y4tA1_ikShsBZJVD0KJfJJMdU",
  authDomain: "the-hawk-games-64239.firebaseapp.com",
  projectId: "the-hawk-games-64239",
  storageBucket: "the-hawk-games-64239.firebasestorage.app",
  messagingSenderId: "391161456812",
  appId: "1:391161456812:web:48f7264720dff9a70dd709",
  measurementId: "G-DGLYCBJLWF"
};


// --- NEW: Header Renderer for The Hawk Games ---
function renderHeader(isLoggedIn) {
    const headerEl = document.querySelector('.main-header');
    if (!headerEl) return;

    let navLinks;
    if (isLoggedIn) {
        navLinks = `
            <a href="index.html">Competitions</a>
            <a href="winners.html">Winners</a>
            <a href="charity.html">Charity</a>
            <a href="account.html" class="btn">My Account</a>
        `;
    } else {
        navLinks = `
            <a href="index.html">Competitions</a>
            <a href="winners.html">Winners</a>
            <a href="charity.html">Charity</a>
            <a href="login.html" class="btn">Login / Sign Up</a>
        `;
    }

    const headerHTML = `
        <div class="container">
            <a href="index.html" class="logo">THE <span class="logo-highlight">HAWK</span> GAMES</a>
            <nav class="main-nav">
                ${navLinks}
            </nav>
        </div>
    `;

    headerEl.innerHTML = headerHTML;
}

// --- NEW: Footer Renderer for The Hawk Games ---
function renderFooter() {
    const footerEl = document.querySelector('.main-footer');
    if (!footerEl) return;

    footerEl.innerHTML = `
        <div class="container">
            <div class="copyright">
                <p>© ${new Date().getFullYear()} Hawk Games Ltd. All rights reserved.</p>
                <p>No gambling licence required. Skill-based competition.</p>
            </div>
            <div class="footer-links">
                <a href="terms-and-conditions.html">T&Cs</a>
                <a href="privacy-policy.html">Privacy</a>
                <a href="free-entry-route.html">Free Entry Route</a>
                <a href="faq.html">FAQ</a>
            </div>
        </div>
    `;
}

// --- CORE AUTH LOGIC (Unchanged from retrocomps) ---
onAuthStateChanged(auth, user => {
    if (user) {
        createUserProfileIfNotExists(user);
    }
    // Render shell regardless of auth state
    renderHeader(!!user);
    renderFooter();
});

const createUserProfileIfNotExists = async (user) => {
    const userRef = doc(db, 'users', user.uid);
    const docSnap = await getDoc(userRef);

    if (!docSnap.exists()) {
        const userData = {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            photoURL: user.photoURL,
            createdAt: serverTimestamp(),
            isAdmin: false,
            myEntries: [], // Legacy field from retrocomps, can be deprecated later.
            entryCount: {}, // New, more efficient model
            marketingConsent: false // NEW COMPLIANCE FIELD
        };
        try {
            await setDoc(userRef, userData);
        } catch (error) {
            console.error("Error creating new user profile:", error);
        }
    }
};


// Event listeners for auth pages
// Handles email/password and Google flows for login and registration
// Redirects to account.html after successful authentication

document.addEventListener('DOMContentLoaded', () => {
    const googleLoginBtn = document.getElementById('google-login-btn');
    const googleRegisterBtn = document.getElementById('google-register-btn');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', async () => {
            const provider = new GoogleAuthProvider();
            try {
                await signInWithPopup(auth, provider);
                window.location.href = 'account.html';
            } catch (error) {
                console.error('Google Sign-In Error:', error);
            }
        });
    }

    if (googleRegisterBtn) {
        googleRegisterBtn.addEventListener('click', async () => {
            const provider = new GoogleAuthProvider();
            try {
                await signInWithPopup(auth, provider);
                window.location.href = 'account.html';
            } catch (error) {
                console.error('Google Sign-Up Error:', error);
            }
        });
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value;
            const password = document.getElementById('login-password').value;
            try {
                await signInWithEmailAndPassword(auth, email, password);
                window.location.href = 'account.html';
            } catch (error) {
                console.error('Email/Password Sign-In Error:', error);
            }
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('register-email').value;
            const password = document.getElementById('register-password').value;
            try {
                await createUserWithEmailAndPassword(auth, email, password);
                window.location.href = 'account.html';
            } catch (error) {
                console.error('Email/Password Sign-Up Error:', error);
            }
        });
    }
});
