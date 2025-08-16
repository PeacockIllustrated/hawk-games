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
let userProfileUnsubscribe = null; 

onAuthStateChanged(auth, (user) => {
    renderHeader(user); 
    
    if (user) {
        createUserProfileIfNotExists(user);
        if (userProfileUnsubscribe) {
            userProfileUnsubscribe();
        }
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            const tokenIndicator = document.getElementById('spin-token-indicator');
            const mobileTokenIndicator = document.getElementById('mobile-spin-token-indicator');
            const elements = [tokenIndicator, mobileTokenIndicator];

            elements.forEach(el => {
                if (el) {
                    if (docSnap.exists() && docSnap.data().spinTokens && docSnap.data().spinTokens.length > 0) {
                        const tokenCount = docSnap.data().spinTokens.length;
                        el.querySelector('.token-count').textContent = tokenCount;
                        el.style.display = 'flex'; // Show the indicator
                    } else {
                        el.style.display = 'none'; // Hide if no tokens
                    }
                }
            });
        });
    } else {
        if (userProfileUnsubscribe) {
            userProfileUnsubscribe();
            userProfileUnsubscribe = null;
        }
    }
    renderFooter();
});

// Re-render header on hash change to update active link for "Winners"
window.addEventListener('hashchange', () => {
    renderHeader(auth.currentUser);
});

const createUserProfileIfNotExists = async (user) => {
    const userRef = doc(db, 'users', user.uid);
    const docSnap = await getDoc(userRef);

    if (!docSnap.exists()) {
        const userData = {
            uid: user.uid, email: user.email, displayName: user.displayName,
            photoURL: user.photoURL, createdAt: serverTimestamp(),
            isAdmin: false, entryCount: {}, marketingConsent: false,
            spinTokens: []
        };
        try {
            await setDoc(userRef, userData);
        } catch (error) {
            console.error("Error creating new user profile:", error);
        }
    }
};

// --- UI RENDERING FUNCTIONS (REVISED) ---
function renderHeader(user) {
    const headerEl = document.querySelector('.main-header');
    if (!headerEl) return;

    let currentPage = document.body.dataset.page || '';
    // Special case for the "Winners" anchor on the homepage
    if (window.location.pathname.endsWith('index.html') && window.location.hash === '#past-winners-section') {
        currentPage = 'winners';
    }

    const createNavLinks = (isMobile = false) => {
        // Define navigation items
        const navItems = [
            { href: 'index.html', page: 'competitions', text: 'Competitions' },
            { href: 'index.html#past-winners-section', page: 'winners', text: 'Winners' },
            { href: 'terms-and-conditions.html', page: 'terms', text: 'Terms' }
        ];

        let linksHTML = navItems.map(item => `
            <a href="${item.href}" class="${currentPage === item.page ? 'active' : ''}">${item.text}</a>
        `).join('');

        // Add Account or Login link
        if (user) {
            linksHTML += `<a href="account.html" class="${currentPage === 'account' ? 'active' : ''}">Account</a>`;
        } else {
            linksHTML += `<a href="login.html" class="${currentPage === 'login' ? 'active' : ''}">Login</a>`;
        }
        
        // Add the Instant Wins CTA and Token Indicator
        linksHTML += `
            <div class="instant-win-nav-item">
                <a href="instant-games.html" class="btn ${currentPage === 'instant-wins' ? 'active' : ''}">Instant Wins</a>
                <div id="${isMobile ? 'mobile-' : ''}spin-token-indicator" class="token-indicator" style="display: none;">
                    <span class="token-icon"></span>
                    <span class="token-count">0</span>
                </div>
            </div>
        `;
        return linksHTML;
    };

    const headerHTML = `
        <div class="container">
            <a href="index.html" class="logo">
                <img src="assets/logo-icon.png" alt="The Hawk Games">
            </a>
            <nav class="main-nav-desktop">${createNavLinks(false)}</nav>
            <button id="hamburger-btn" class="hamburger-btn" aria-label="Open menu">
                <span></span>
                <span></span>
                <span></span>
            </button>
        </div>
        <div id="mobile-nav-overlay" class="mobile-nav-overlay">
             <nav class="mobile-nav-links">${createNavLinks(true)}</nav>
        </div>
    `;
    headerEl.innerHTML = headerHTML;

    // Attach event listeners for the new mobile navigation
    const hamburgerBtn = document.getElementById('hamburger-btn');
    if (hamburgerBtn) {
        hamburgerBtn.addEventListener('click', () => {
            document.body.classList.toggle('mobile-nav-open');
        });
    }

    const mobileNavLinks = document.querySelector('.mobile-nav-links');
    if (mobileNavLinks) {
        mobileNavLinks.addEventListener('click', (e) => {
            if (e.target.tagName === 'A') {
                document.body.classList.remove('mobile-nav-open');
            }
        });
    }
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
    // This logic is specifically for the login.html and register.html pages
    const loginBtn = document.getElementById('google-login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', async () => {
            try {
                await signInWithPopup(auth, new GoogleAuthProvider());
                window.location.href = 'account.html';
            } catch (error) {
                console.error('Google Sign-In Error:', error);
            }
        });
    }

    const registerBtn = document.getElementById('google-register-btn');
    if(registerBtn) {
         registerBtn.addEventListener('click', async () => {
            try {
                await signInWithPopup(auth, new GoogleAuthProvider());
                window.location.href = 'account.html';
            } catch (error) { 
                console.error('Google Sign-Up Error:', error); 
            }
        });
    }
});
