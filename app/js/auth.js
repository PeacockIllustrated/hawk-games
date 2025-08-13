import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { 
    getAuth, 
    onAuthStateChanged, 
    GoogleAuthProvider, 
    signInWithPopup, 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword 
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    serverTimestamp 
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

// --- CORE INITIALIZATION ---
// Initialize Firebase and export the app instance for other modules
export const app = initializeApp(firebaseConfig);
// Get instances of the services you need
const auth = getAuth(app);
const db = getFirestore(app);

// --- GLOBAL AUTH STATE LISTENER ---
// This single listener will manage the user's session and render UI updates.
onAuthStateChanged(auth, (user) => {
    if (user) {
        // If the user exists, ensure their profile is in Firestore.
        createUserProfileIfNotExists(user);
    }
    // Render the header and footer on EVERY auth state change (login or logout)
    renderHeader(!!user);
    renderFooter();
});

const createUserProfileIfNotExists = async (user) => {
    const userRef = doc(db, 'users', user.uid);
    try {
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
                marketingConsent: false
            };
            await setDoc(userRef, userData);
        }
    } catch (error) {
        console.error("Error creating user profile:", error);
    }
};


// --- UI RENDERING FUNCTIONS ---
function renderHeader(isLoggedIn) {
    const headerEl = document.querySelector('.main-header');
    if (!headerEl) return;
    let navLinks;
    if (isLoggedIn) {
        navLinks = `<a href="index.html">Competitions</a><a href="account.html" class="btn">My Account</a>`;
    } else {
        navLinks = `<a href="index.html">Competitions</a><a href="login.html" class="btn">Login / Sign Up</a>`;
    }
    headerEl.innerHTML = `
        <div class="container">
            <a href="index.html" class="logo">THE <span class="logo-highlight">HAWK</span> GAMES</a>
            <nav class="main-nav">${navLinks}</nav>
        </div>`;
}

function renderFooter() {
    const footerEl = document.querySelector('.main-footer');
    if (!footerEl) return;
    footerEl.innerHTML = `
        <div class="container">
            <div class="copyright"><p>© ${new Date().getFullYear()} Hawk Games Ltd. All rights reserved.</p></div>
            <div class="footer-links">
                <a href="terms-and-conditions.html">T&Cs</a>
                <a href="privacy-policy.html">Privacy</a>
                <a href="free-entry-route.html">Free Entry</a>
            </div>
        </div>`;
}

// --- PAGE-SPECIFIC EVENT LISTENERS ---
// This function will be called by pages that need auth forms (login.html, register.html)
function setupAuthForms() {
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
}

// Check which page we're on and run the necessary setup
if (document.getElementById('login-form') || document.getElementById('register-form')) {
    setupAuthForms();
}
