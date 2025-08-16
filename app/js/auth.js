// /app/js/auth.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { 
    getAuth, 
    onAuthStateChanged, 
    GoogleAuthProvider, 
    signInWithPopup, 
    signOut
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    serverTimestamp,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
// --- SECURITY: Import App Check modules ---
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app-check.js";


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

// --- SECURITY: Initialize App Check ---
// IMPORTANT: Replace 'YOUR_RECAPTCHA_V3_SITE_KEY' with your actual key from Google Cloud Console
// You must also enable the App Check service in your Firebase project settings.
const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider('YOUR_RECAPTCHA_V3_SITE_KEY'),
  isTokenAutoRefreshEnabled: true
});


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
            const data = docSnap.exists() ? docSnap.data() : {};
            
            const tokenCount = data.spinTokens?.length || 0;
            const creditBalance = data.creditBalance || 0;

            // Update Spin Token & Credit Indicators in both headers (desktop/mobile)
            updateIndicator('spin-token-indicator', tokenCount, (el, count) => el.querySelector('.token-count').textContent = count);
            updateIndicator('mobile-spin-token-indicator', tokenCount, (el, count) => el.querySelector('.token-count').textContent = count);
            updateIndicator('credit-balance-indicator', creditBalance, (el, val) => el.querySelector('.credit-amount').textContent = `£${val.toFixed(2)}`, val > 0);
            updateIndicator('mobile-credit-balance-indicator', creditBalance, (el, val) => el.querySelector('.credit-amount').textContent = `£${val.toFixed(2)}`, val > 0);
        });
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
        el.style.display = 'flex';
    } else {
        el.style.display = 'none';
    }
}


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
            spinTokens: [], creditBalance: 0
        };
        try {
            await setDoc(userRef, userData);
        } catch (error) {
            console.error("Error creating new user profile:", error);
        }
    }
};

// --- SECURITY: Helper function for safe element creation ---
function createElement(tag, options = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
        if (key === 'class') {
            if (Array.isArray(value)) el.classList.add(...value);
            else el.classList.add(value);
        } else if (key === 'textContent') {
            el.textContent = value;
        } else {
            el.setAttribute(key, value);
        }
    });
    children.forEach(child => el.append(child));
    return el;
}

// --- SECURITY: Refactored UI RENDERING FUNCTIONS (No innerHTML) ---
function renderHeader(user) {
    const headerEl = document.querySelector('.main-header');
    if (!headerEl) return;
    headerEl.innerHTML = ''; // Clear previous content

    let currentPage = document.body.dataset.page || '';
    if (window.location.pathname.endsWith('index.html') && window.location.hash === '#past-winners-section') {
        currentPage = 'winners';
    }

    const createNavLinks = (isMobile = false) => {
        const navItems = [
            { href: 'index.html', page: 'competitions', text: 'Competitions' },
            { href: 'index.html#past-winners-section', page: 'winners', text: 'Winners' },
            { href: 'terms-and-conditions.html', page: 'terms', text: 'Terms' }
        ];

        const links = navItems.map(item =>
            createElement('a', { href: item.href, class: currentPage === item.page ? 'active' : '' }, [item.text])
        );

        if (user) {
            links.push(createElement('a', { href: 'account.html', class: currentPage === 'account' ? 'active' : '' }, ['Account']));
            links.push(
                createElement('div', { id: `${isMobile ? 'mobile-' : ''}credit-balance-indicator`, class: 'credit-balance', style: 'display: none;' }, [
                    createElement('span', { class: 'credit-amount' }, ['£0.00'])
                ])
            );
        } else {
            links.push(createElement('a', { href: 'login.html', class: currentPage === 'login' ? 'active' : '' }, ['Login']));
        }
        
        const instantWinLink = createElement('a', { href: 'instant-games.html', class: `btn ${currentPage === 'instant-wins' ? 'active' : ''}` }, ['Instant Wins']);
        const tokenIndicator = createElement('div', { id: `${isMobile ? 'mobile-' : ''}spin-token-indicator`, class: 'token-indicator', style: 'display: none;' }, [
            createElement('span', { class: 'token-icon' }),
            createElement('span', { class: 'token-count' }, ['0'])
        ]);
        const instantWinNavItem = createElement('div', { class: 'instant-win-nav-item' }, [instantWinLink, tokenIndicator]);
        
        links.push(instantWinNavItem);
        return links;
    };

    const logoLink = createElement('a', { href: 'index.html', class: 'logo' }, [
        createElement('img', { src: 'assets/logo-icon.png', alt: 'The Hawk Games' })
    ]);
    const desktopNav = createElement('nav', { class: 'main-nav-desktop' }, createNavLinks(false));
    const hamburgerBtn = createElement('button', { id: 'hamburger-btn', class: 'hamburger-btn', 'aria-label': 'Open menu' }, [
        createElement('span'), createElement('span'), createElement('span')
    ]);
    const container = createElement('div', { class: 'container' }, [logoLink, desktopNav, hamburgerBtn]);
    
    const mobileNav = createElement('nav', { class: 'mobile-nav-links' }, createNavLinks(true));
    const mobileOverlay = createElement('div', { id: 'mobile-nav-overlay', class: 'mobile-nav-overlay' }, [mobileNav]);

    headerEl.append(container, mobileOverlay);

    hamburgerBtn.addEventListener('click', () => {
        document.body.classList.toggle('mobile-nav-open');
    });

    mobileNav.addEventListener('click', (e) => {
        if (e.target.tagName === 'A' || e.target.closest('a')) {
            document.body.classList.remove('mobile-nav-open');
        }
    });
}

function renderFooter() {
    const footerEl = document.querySelector('.main-footer');
    if (!footerEl) return;
    footerEl.innerHTML = ''; // Clear previous

    const copyright = createElement('div', { class: 'copyright' }, [
        createElement('p', {}, [`© ${new Date().getFullYear()} Hawk Games Ltd.`])
    ]);
    const footerLinks = createElement('div', { class: 'footer-links' }, [
        createElement('a', { href: 'terms-and-conditions.html' }, ['T&Cs']),
        createElement('a', { href: 'privacy-policy.html' }, ['Privacy']),
        createElement('a', { href: 'free-entry-route.html' }, ['Free Entry'])
    ]);
    const container = createElement('div', { class: 'container' }, [copyright, footerLinks]);
    
    footerEl.append(container);
}

// --- Event listeners for auth pages ---
document.addEventListener('DOMContentLoaded', () => {
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
});
