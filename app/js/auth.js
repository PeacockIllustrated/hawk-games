// This is the functional `retrocomps/js/auth.js` file, adapted for The Hawk Games.
// The core logic is the same, but `renderHeader` and `renderFooter` are new.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA5bxzllAaU66gyo1BLVghV40QWvWE4uGc",
  authDomain: "comps-2727d.firebaseapp.com",
  projectId: "comps-2727d",
  storageBucket: "comps-2727d.firebasestorage.app",
  messagingSenderId: "48429329122",
  appId: "1:48429329122:web:d1960978e465feec218cbb"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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
                <p>&copy; ${new Date().getFullYear()} Hawk Games Ltd. All rights reserved.</p>
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
            myEntries: [],
            marketingConsent: false // NEW COMPLIANCE FIELD
        };
        try {
            await setDoc(userRef, userData);
        } catch (error) {
            console.error("Error creating new user profile:", error);
        }
    }
};

// Event listener for login page (to be created)
document.addEventListener('DOMContentLoaded', () => {
    const googleLoginBtn = document.getElementById('google-login-btn');
    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', async () => {
            const provider = new GoogleAuthProvider();
            try {
                await signInWithPopup(auth, provider);
                window.location.href = 'account.html';
            } catch (error) {
                console.error("Google Sign-In Error:", error);
            }
        });
    }
});