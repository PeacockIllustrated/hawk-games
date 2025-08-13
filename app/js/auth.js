// This is the functional `retrocomps/js/auth.js` file, adapted for The Hawk Games.
// The core logic is the same, but `renderHeader` and `renderFooter` are new.

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
    onSnapshot // Import onSnapshot for real-time updates
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

// Your web app's CORRECT Firebase configuration
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

let userProfileUnsubscribe = null; // To hold our listener function

// --- NEW: Header Renderer for The Hawk Games ---
function renderHeader(isLoggedIn) {
    const headerEl = document.querySelector('.main-header');
    if (!headerEl) return;

    let navLinks;
    if (isLoggedIn) {
        navLinks = `
            <a href="index.html">Competitions</a>
            <a href="instant-games.html" id="spin-token-balance" class="spin-token-balance" style="display: none;" title="Your Spin Tokens">
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

// --- CORE AUTH LOGIC ---
onAuthStateChanged(auth, (user) => {
    // Clean up any previous listener to prevent memory leaks
    if (userProfileUnsubscribe) {
        userProfileUnsubscribe();
    }

    if (user) {
        createUserProfileIfNotExists(user);
        
        // --- NEW: Set up a real-time listener for the user's document ---
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            const tokenBalanceEl = document.getElementById('spin-token-balance');
            if (tokenBalanceEl) {
                // Check if the document and the spinTokens field exist
                if (docSnap.exists() && docSnap.data().spinTokens && docSnap.data().spinTokens.length > 0) {
                    const tokenCount = docSnap.data().spinTokens.length;
                    tokenBalanceEl.querySelector('.token-count').textContent = tokenCount;
                    tokenBalanceEl.style.display = 'flex';
                } else {
                    tokenBalanceEl.style.display = 'none';
                }
            }
        });
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
            displayName: user.displayName || 'New Player',
            photoURL: user.photoURL || `https://i.pravatar.cc/150?u=${user.uid}`,
            createdAt: serverTimestamp(),
            isAdmin: false,
            entryCount: {},
            marketingConsent: false,
            spinTokens: [] // Initialize the spinTokens array for new users
        };
        try {
            await setDoc(userRef, userData);
        } catch (error) {
            console.error("Error creating new user profile:", error);
        }
    }
};


// --- Event listeners for auth pages ---
document.addEventListener('DOMContentLoaded', () => {
    const googleLoginBtn = document.getElementById('google-login-btn');
    const googleRegisterBtn = document.getElementById('google-register-btn');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    const handleAuthSuccess = () => { window.location.href = 'account.html'; };
    const handleAuthError = (error) => { console.error('Authentication Error:', error); alert(error.message); };

    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', () => {
            signInWithPopup(auth, new GoogleAuthProvider()).then(handleAuthSuccess).catch(handleAuthError);
        });
    }

    if (googleRegisterBtn) {
        googleRegisterBtn.addEventListener('click', () => {
            signInWithPopup(auth, new GoogleAuthProvider()).then(handleAuthSuccess).catch(handleAuthError);
        });
    }

    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = loginForm.querySelector('#login-email').value;
            const password = loginForm.querySelector('#login-password').value;
            signInWithEmailAndPassword(auth, email, password).then(handleAuthSuccess).catch(handleAuthError);
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = registerForm.querySelector('#register-email').value;
            const password = registerForm.querySelector('#register-password').value;
            createUserWithEmailAndPassword(auth, email, password).then(handleAuthSuccess).catch(handleAuthError);
        });
    }
});
