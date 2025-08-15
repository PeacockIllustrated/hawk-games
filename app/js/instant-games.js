'use strict';

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

// --- Singletons & State ---
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
let userTokens = [];
let isSpinning = false;
let userProfileUnsubscribe = null;

// --- DOM Elements ---
const tokenCountElement = document.getElementById('token-count');
const tokenAccordionContainer = document.getElementById('token-accordion-container');
const wheel = document.getElementById('wheel');
const spinButton = document.getElementById('spin-button');
const spinResultContainer = document.getElementById('spin-result');
const buyMoreBtn = document.getElementById('buy-more-tokens-btn');
const purchaseModal = document.getElementById('purchase-modal');
const bundlesContainer = document.getElementById('token-bundles-container');

// --- Auth Gate & Data Listener ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe();
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                // Sort tokens by date to ensure we always use the oldest first
                const tokens = docSnap.data().spinTokens || [];
                userTokens = tokens.sort((a, b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000));
                updateUI();
            }
        });
        renderWheel(); // Render the wheel visuals immediately on load
    } else {
        window.location.replace('login.html');
    }
});

// --- Main UI Update Function ---
function updateUI() {
    const tokenCount = userTokens.length;
    tokenCountElement.textContent = tokenCount;
    spinButton.disabled = tokenCount === 0 || isSpinning;
    buyMoreBtn.disabled = tokenCount === 0;

    if (tokenCount === 0) {
        spinButton.textContent = "NO SPINS AVAILABLE";
        tokenAccordionContainer.innerHTML = `<div class="placeholder">You have no Spin Tokens. Enter Instant Win competitions to earn them!</div>`;
    } else {
        spinButton.textContent = "SPIN THE WHEEL";
        renderTokenAccordion();
    }
}

// --- Rendering Functions ---
function renderTokenAccordion() {
    if (!tokenAccordionContainer) return;
    
    const groupedTokens = userTokens.reduce((acc, token) => {
        const groupTitle = token.compTitle || "Purchased Tokens";
        (acc[groupTitle] = acc[groupTitle] || []).push(token);
        return acc;
    }, {});

    let html = '';
    for (const groupTitle in groupedTokens) {
        const tokens = groupedTokens[groupTitle];
        const date = new Date(tokens[0].earnedAt.seconds * 1000).toLocaleDateString();
        html += `
            <div class="accordion-item">
                <button class="accordion-header">
                    <span>${groupTitle}</span>
                    <span class="accordion-meta">${tokens.length} Token(s) - Earned ${date}</span>
                    <span class="accordion-arrow"></span>
                </button>
                <div class="accordion-content">
                    <ul>
                        ${tokens.map(t => `<li>Token ID: ...${t.tokenId.slice(-8)}</li>`).join('')}
                    </ul>
                </div>
            </div>`;
    }
    tokenAccordionContainer.innerHTML = html || `<div class="placeholder">No tokens found.</div>`;
}

function renderWheel() {
    if (!wheel) return;
    wheel.innerHTML = '';
    const dummyPrizes = [5, 50, 10, 100, 20, 5, 250, 10, 5, 20, 50, 5]; // For visual effect
    const segmentAngle = 360 / dummyPrizes.length;

    dummyPrizes.forEach((value, i) => {
        const labelRotation = (i * segmentAngle) + (segmentAngle / 2);
        const labelText = value > 0 ? `£${value}` : 'Try Again';
        const label = document.createElement('div');
        label.className = 'segment-label';
        label.textContent = labelText;
        label.style.transform = `rotate(${labelRotation}deg) translate(0, -110px)`;
        wheel.appendChild(label);
    });
}

function renderPurchaseBundles() {
    if (userTokens.length === 0) {
        bundlesContainer.innerHTML = `<p class="placeholder">You must first earn a token from a competition before you can purchase more.</p>`;
        return;
    }
    const latestToken = userTokens[userTokens.length-1];
    const compId = latestToken.compId;
    
    const bundles = [
        { amount: 5, price: 4.50 },
        { amount: 10, price: 8.00 },
        { amount: 25, price: 15.00 },
    ];
    bundlesContainer.innerHTML = bundles.map(b => `
        <button class="btn bundle-btn" data-comp-id="${compId}" data-amount="${b.amount}" data-price="${b.price}">
            <span class="bundle-amount">${b.amount} Tokens</span>
            <span class="bundle-price">£${b.price.toFixed(2)}</span>
        </button>
    `).join('');
}


// --- Event Handlers ---
spinButton.addEventListener('click', async () => {
    if (userTokens.length === 0 || isSpinning) return;

    isSpinning = true;
    updateUI(); // Disables button
    spinButton.textContent = 'SPINNING...';
    spinResultContainer.innerHTML = '';

    const tokenToSpend = userTokens[0]; // Always use the oldest token

    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    void wheel.offsetWidth; 
    wheel.style.transition = 'transform 8s cubic-bezier(0.25, 0.1, 0.25, 1)';
    
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');

    try {
        const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
        const { won, prizeValue } = result.data;

        const baseRotation = 360 * 8; 
        const randomOffset = Math.random() * 360;
        const finalAngle = baseRotation + randomOffset;

        wheel.style.transform = `rotate(${finalAngle}deg)`;

        setTimeout(() => {
            if (won) {
                spinResultContainer.innerHTML = `<p class="spin-win">🎉 YOU WON £${prizeValue.toFixed(2)}! 🎉</p>`;
            } else {
                spinResultContainer.innerHTML = `<p>Better luck next time!</p>`;
            }
            isSpinning = false;
            // The onSnapshot listener will automatically update the UI once the token is removed from DB
        }, 8500);

    } catch (error) {
        console.error("Error spending token:", error);
        spinResultContainer.innerHTML = `<p class="spin-error">Error: ${error.message}</p>`;
        isSpinning = false;
        updateUI(); // Re-enable button on error
    }
});

buyMoreBtn.addEventListener('click', () => {
    renderPurchaseBundles();
    purchaseModal.classList.add('show');
});

purchaseModal.addEventListener('click', (e) => {
    if (e.target.matches('.modal-container') || e.target.closest('[data-close-modal]')) {
        purchaseModal.classList.remove('show');
    }
});

bundlesContainer.addEventListener('click', async (e) => {
    const button = e.target.closest('.bundle-btn');
    if (!button) return;

    const originalText = button.innerHTML;
    button.disabled = true;
    button.innerHTML = 'Processing...';

    const purchaseTokenFunc = httpsCallable(functions, 'purchaseSpinTokens');
    try {
        await purchaseTokenFunc({
            compId: button.dataset.compId,
            amount: parseInt(button.dataset.amount),
            price: parseFloat(button.dataset.price)
        });
        purchaseModal.classList.remove('show');
    } catch (error) {
        console.error("Token purchase failed:", error);
        alert(`Purchase failed: ${error.message}`);
    } finally {
        button.innerHTML = originalText;
        button.disabled = false;
    }
});

tokenAccordionContainer.addEventListener('click', (e) => {
    const header = e.target.closest('.accordion-header');
    if (!header) return;
    const content = header.nextElementSibling;
    header.classList.toggle('active');
    if (content.style.maxHeight) {
        content.style.maxHeight = null;
    } else {
        content.style.maxHeight = content.scrollHeight + "px";
    }
});
