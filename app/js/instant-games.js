'use strict';

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, onSnapshot, getDoc } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

// --- Singletons & State ---
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
let userTokens = [];
let spinnerPrizes = [];
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
const prizesModal = document.getElementById('prizes-modal');
const showPrizesBtn = document.getElementById('show-prizes-btn');
const prizesTableContainer = document.getElementById('prizes-table-container');


// --- Auth Gate & Data Listener ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe();
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const tokens = docSnap.data().spinTokens || [];
                userTokens = tokens.sort((a, b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000));
                updateUI();
            }
        });
        loadAndRenderWheel(); // Fetch prizes and render the wheel
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
        tokenAccordionContainer.innerHTML = `<div class="placeholder">You have no Spin Tokens. Enter a Main Comp to earn them!</div>`;
    } else {
        spinButton.textContent = "SPIN THE WHEEL";
        renderTokenAccordion();
    }
}

// --- NEW: Load Prizes and Build Wheel/Table ---
async function loadAndRenderWheel() {
    try {
        const settingsRef = doc(db, 'admin_settings', 'spinnerPrizes');
        const docSnap = await getDoc(settingsRef);
        if (docSnap.exists() && docSnap.data().prizes) {
            spinnerPrizes = docSnap.data().prizes;
            renderWheel(spinnerPrizes);
            renderPrizesTable(spinnerPrizes);
        } else {
            console.error("Spinner settings not found in Firestore.");
            // Render a default wheel so the page doesn't look broken
            renderWheel([]);
        }
    } catch (error) {
        console.error("Error fetching spinner prizes:", error);
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

function renderWheel(prizes) {
    if (!wheel) return;
    wheel.innerHTML = '';
    
    // Create a visually appealing set of 12 segments for the wheel
    let wheelSegments = [...prizes];
    // Pad with "No Win" if there are fewer than 12 prizes
    while (wheelSegments.length < 12) {
        wheelSegments.push({ value: 0, type: 'none' });
    }
    // Shuffle for visual randomness
    wheelSegments.sort(() => Math.random() - 0.5);

    const segmentAngle = 360 / wheelSegments.length;

    wheelSegments.forEach((prize, i) => {
        const labelRotation = (i * segmentAngle) + (segmentAngle / 2);
        let labelText = 'No Win';
        if (prize.value > 0) {
            labelText = prize.type === 'credit' ? `£${prize.value} Credit` : `£${prize.value} Cash`;
        }
        
        const label = document.createElement('div');
        label.className = `segment-label ${prize.type}`;
        label.textContent = labelText;
        label.style.transform = `rotate(${labelRotation}deg) translate(0, -110px)`;
        wheel.appendChild(label);
    });
}

function renderPrizesTable(prizes) {
    let tableHTML = `
        <table class="prizes-table">
            <thead><tr><th>Prize</th><th>Odds</th></tr></thead>
            <tbody>`;
    prizes.forEach(prize => {
        const prizeText = prize.type === 'credit' ? `£${prize.value} Store Credit` : `£${prize.value} Cash`;
        tableHTML += `<tr><td>${prizeText}</td><td>1 in ${prize.odds.toLocaleString()}</td></tr>`;
    });
    tableHTML += `</tbody></table>`;
    prizesTableContainer.innerHTML = tableHTML;
}

function renderPurchaseBundles() {
    // We can always allow purchase now, tokens are not tied to comps
    const bundles = [
        { amount: 5, price: 4.50 },
        { amount: 10, price: 8.00 },
        { amount: 25, price: 15.00 },
    ];
    bundlesContainer.innerHTML = bundles.map(b => `
        <button class="btn bundle-btn" data-amount="${b.amount}" data-price="${b.price}">
            <span class="bundle-amount">${b.amount} Tokens</span>
            <span class="bundle-price">£${b.price.toFixed(2)}</span>
        </button>
    `).join('');
}


// --- Event Handlers ---
spinButton.addEventListener('click', async () => {
    if (userTokens.length === 0 || isSpinning) return;

    isSpinning = true;
    updateUI();
    spinButton.textContent = 'SPINNING...';
    spinResultContainer.innerHTML = '';

    const tokenToSpend = userTokens[0];

    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    void wheel.offsetWidth; 
    wheel.style.transition = 'transform 8s cubic-bezier(0.25, 0.1, 0.25, 1)';
    
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');

    try {
        const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
        const { won, prizeType, value } = result.data;

        const baseRotation = 360 * 8; 
        const randomOffset = Math.random() * 360;
        const finalAngle = baseRotation + randomOffset;

        wheel.style.transform = `rotate(${finalAngle}deg)`;

        setTimeout(() => {
            if (won) {
                const prizeText = prizeType === 'credit' ? `£${value.toFixed(2)} STORE CREDIT` : `£${value.toFixed(2)} CASH`;
                spinResultContainer.innerHTML = `<p class="spin-win">🎉 YOU WON ${prizeText}! 🎉</p>`;
            } else {
                spinResultContainer.innerHTML = `<p>Better luck next time!</p>`;
            }
            isSpinning = false;
            updateUI(); 
        }, 8500);

    } catch (error) {
        console.error("Error spending token:", error);
        spinResultContainer.innerHTML = `<p class="spin-error">Error: ${error.message}</p>`;
        isSpinning = false;
        updateUI();
    }
});

buyMoreBtn.addEventListener('click', () => {
    renderPurchaseBundles();
    purchaseModal.classList.add('show');
});

showPrizesBtn.addEventListener('click', () => {
    prizesModal.classList.add('show');
});

const closeModalHandler = (e) => {
    if (e.target.matches('.modal-container') || e.target.closest('[data-close-modal]')) {
        e.target.closest('.modal-container').classList.remove('show');
    }
};

purchaseModal.addEventListener('click', closeModalHandler);
prizesModal.addEventListener('click', closeModalHandler);

bundlesContainer.addEventListener('click', async (e) => {
    const button = e.target.closest('.bundle-btn');
    if (!button) return;

    const originalText = button.innerHTML;
    button.disabled = true;
    button.innerHTML = 'Processing...';

    const purchaseTokenFunc = httpsCallable(functions, 'purchaseSpinTokens');
    try {
        await purchaseTokenFunc({
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
