// /app/js/auth.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { 
    getAuth, 
    onAuthStateChanged, 
    GoogleAuthProvider, 
    signInWithPopup, 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    serverTimestamp,
    onSnapshot // For real-time updates
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCHnYCOB-Y4tA1_ikShsBZJVD0KJfJJMdU",
  authDomain: "the-hawk-games-64239.firebaseapp.com",
  projectId: "the-hawk-games-64239",
  storageBucket: "the-hawk-games-64239.firebasestorage.app",
  messagingSenderId: "391161456812",
  appId: "1:391161456812:web:48f7264720dff9a70dd709",
  measurementId: "G-DGLYCBJLWF"
};

// Initialize Firebase and EXPORT the app instance for other modules to use
export const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- Global Auth State Listener ---
let userProfileUnsubscribe = null; // To hold our real-time listener

onAuthStateChanged(auth, (user) => {
    renderHeader(!!user); // Render header immediately based on login state
    
    if (user) {
        createUserProfileIfNotExists(user);

        // If there's an old listener, unsubscribe from it first
        if (userProfileUnsubscribe) {
            userProfileUnsubscribe();
        }

        // Listen for real-time changes to the user's profile (like spinTokens)
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            const tokenBalanceEl = document.getElementById('spin-token-balance');
            if (tokenBalanceEl) {
                if (docSnap.exists() && docSnap.data().spinTokens && docSnap.data().spinTokens.length > 0) {
                    const tokenCount = docSnap.data().spinTokens.length;
                    tokenBalanceEl.querySelector('.token-count').textContent = tokenCount;
                    tokenBalanceEl.style.display = 'flex';
                } else {
                    tokenBalanceEl.style.display = 'none';
                }
            }
        });
    } else {
        // If the user logs out, stop listening for their profile changes
        if (userProfileUnsubscribe) {
            userProfileUnsubscribe();
            userProfileUnsubscribe = null;
        }
    }
    renderFooter();
});

const createUserProfileIfNotExists = async (user) => {
    const userRef = doc(db, 'users', user.uid);
    const docSnap = await getDoc(userRef);

    if (!docSnap.exists()) {
        const userData = {
            uid: user.uid, email: user.email, displayName: user.displayName,
            photoURL: user.photoURL, createdAt: serverTimestamp(),
            isAdmin: false, entryCount: {}, marketingConsent: false,
            spinTokens: [] // Initialize with an empty array for the new token economy
        };
        try {
            await setDoc(userRef, userData);
        } catch (error) {
            console.error("Error creating new user profile:", error);
        }
    }
};

// --- UI RENDERING FUNCTIONS ---
function renderHeader(isLoggedIn) {
    const headerEl = document.querySelector('.main-header');
    if (!headerEl) return;
    let navLinks;
    if (isLoggedIn) {
        navLinks = `
            <a href="index.html">Competitions</a>
            <a href="instant-games.html" id="spin-token-balance" class="spin-token-balance" style="display: none;">
                <span class="token-icon">🎟️</span>
                <span class="token-count">0</span>
            </a>
            <a href="account.html" class="btn">My Account</a>
        `;
    } else {
        navLinks = `
            <a href="index.html">Competitions</a>
            <a href="login.html" class="btn">Login / Sign Up</a>
        `;
    }
    const headerHTML = `
        <div class="container">
            <a href="index.html" class="logo">THE <span class="logo-highlight">HAWK</span> GAMES</a>
            <nav class="main-nav">${navLinks}</nav>
        </div>
    `;
    headerEl.innerHTML = headerHTML;
}

function renderFooter() {
    const footerEl = document.querySelector('.main-footer');
    if (!footerEl) return;
    footerEl.innerHTML = `
        <div class="container">
            <div class="copyright"><p>© ${new Date().getFullYear()} Hawk Games Ltd.</p></div>
            <div class="footer-links">
                <a href="terms-and-conditions.html">T&Cs</a>
                <a href="privacy-policy.html">Privacy</a>
                <a href="free-entry-route.html">Free Entry</a>
            </div>
        </div>`;
}

// --- Event listeners for auth pages ---
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('login-form') || document.getElementById('register-form')) {
        const googleLoginBtn = document.getElementById('google-login-btn');
        const googleRegisterBtn = document.getElementById('google-register-btn');
        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');

        if (googleLoginBtn) {
            googleLoginBtn.addEventListener('click', async () => {
                try {
                    await signInWithPopup(auth, new GoogleAuthProvider());
                    window.location.href = 'account.html';
                } catch (error) { console.error('Google Sign-In Error:', error); }
            });
        }
        if (googleRegisterBtn) {
            googleRegisterBtn.addEventListener('click', async () => {
                try {
                    await signInWithPopup(auth, new GoogleAuthProvider());
                    window.location.href = 'account.html';
                } catch (error) { console.error('Google Sign-Up Error:', error); }
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
                } catch (error) { console.error('Email/Password Sign-In Error:', error); }
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
                } catch (error) { console.error('Email/Password Sign-Up Error:', error); }
            });
        }
    }
});
