// /app/js/instant-games.js

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
let selectedTokenId = null;
let selectedCompId = null;
let isSpinning = false;
let userProfileUnsubscribe = null;

// --- DOM Elements ---
const tokenListContainer = document.getElementById('token-list-container');
const gamePlaceholder = document.getElementById('game-placeholder');
const spinGameContainer = document.getElementById('spin-game-container');
const wheel = document.getElementById('wheel');
const spinButton = document.getElementById('spin-button');
const spinResultContainer = document.getElementById('spin-result');
const purchaseSection = document.getElementById('purchase-tokens-section');
const bundlesContainer = document.getElementById('token-bundles-container');


// --- Auth Gate ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe();
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                userTokens = docSnap.data().spinTokens || [];
                renderTokenList();
            }
        });
    } else {
        window.location.replace('login.html');
    }
});

// --- Rendering Functions ---
function renderTokenList() {
    if (!tokenListContainer) return;
    if (userTokens.length === 0) {
        tokenListContainer.innerHTML = `<div class="placeholder">You have no Spin Tokens. Enter Instant Win competitions to earn them!</div>`;
        return;
    }
    const groupedTokens = userTokens.reduce((acc, token) => {
        (acc[token.compId] = acc[token.compId] || []).push(token);
        return acc;
    }, {});
    let html = '';
    for (const compId in groupedTokens) {
        const tokens = groupedTokens[compId];
        const compTitle = tokens[0].compTitle;
        html += `<div class="token-group">
                    <p class="group-title">${compTitle} (${tokens.length})</p>
                    ${tokens.map(token => `<button class="btn token-btn" data-token-id="${token.tokenId}" data-comp-id="${token.compId}">Token ID: ...${token.tokenId.slice(-6)}</button>`).join('')}
                 </div>`;
    }
    tokenListContainer.innerHTML = html;
}

function renderWheel(prizes) {
    if (!wheel) return;
    wheel.innerHTML = ''; // Clear old segments
    const prizeSegments = prizes.length > 0 ? prizes : Array(12).fill({ prizeValue: 0 }); // Use real prizes or fall back to "Try Again"
    while (prizeSegments.length < 12) { prizeSegments.push({ prizeValue: 0 }); } // Pad for visuals
    prizeSegments.sort(() => Math.random() - 0.5); // Shuffle

    const segmentAngle = 360 / prizeSegments.length;
    prizeSegments.forEach((prize, i) => {
        const labelRotation = (i * segmentAngle) + (segmentAngle / 2);
        const labelText = prize.prizeValue > 0 ? `£${prize.prizeValue}` : 'Try Again';
        const label = document.createElement('div');
        label.className = 'segment-label';
        label.textContent = labelText;
        label.style.transform = `rotate(${labelRotation}deg) translate(0, -110px)`;
        wheel.appendChild(label);
    });

    gamePlaceholder.style.display = 'none';
    spinGameContainer.style.display = 'block';
    spinButton.disabled = false;
    spinButton.textContent = 'SPIN THE WHEEL';
    spinResultContainer.innerHTML = '';
}

function renderPurchaseBundles(compId) {
    purchaseSection.style.display = 'block';
    // Dummy bundles. In a real app, this would come from the competition config.
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
tokenListContainer.addEventListener('click', async (e) => {
    const button = e.target.closest('.token-btn');
    if (!button || isSpinning) return;

    document.querySelectorAll('.token-btn.selected').forEach(btn => btn.classList.remove('selected'));
    button.classList.add('selected');
    
    selectedTokenId = button.dataset.tokenId;
    selectedCompId = button.dataset.compId;

    spinButton.disabled = true;
    spinButton.textContent = 'Loading Game...';
    
    // In this new model, we just need to confirm the game can be played.
    // The prize pool is handled entirely on the server.
    const prizes = [{ prizeValue: 100 }, { prizeValue: 50 }, { prizeValue: 10 }]; // Dummy for visual
    renderWheel(prizes);
    renderPurchaseBundles(selectedCompId);
});

// NEW: Handle token purchase clicks
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
        // Success! The onSnapshot listener will update the token list automatically.
    } catch (error) {
        console.error("Token purchase failed:", error);
        alert(`Purchase failed: ${error.message}`);
    } finally {
        button.innerHTML = originalText;
        button.disabled = false;
    }
});

spinButton.addEventListener('click', async () => {
    if (!selectedTokenId || isSpinning) return;

    isSpinning = true;
    spinButton.disabled = true;
    spinButton.textContent = 'SPINNING...';
    spinResultContainer.innerHTML = '';

    // Reset animation properties for a fresh spin
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    
    // Force browser to repaint before starting animation
    void wheel.offsetWidth; 

    wheel.style.transition = 'transform 8s cubic-bezier(0.25, 0.1, 0.25, 1)';
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');

    try {
        const result = await spendTokenFunc({ tokenId: selectedTokenId });
        const { won, prizeValue } = result.data;

        // More satisfying spin calculation
        const baseRotation = 360 * 8; 
        const segmentCount = 12;
        const segmentAngle = 360 / segmentCount;
        let targetSegmentIndex = Math.floor(Math.random() * segmentCount); // Pick a random segment to land on

        const targetAngle = (targetSegmentIndex * segmentAngle) + (segmentAngle / 2);
        const randomOffset = (Math.random() - 0.5) * (segmentAngle * 0.8);
        const finalAngle = baseRotation - targetAngle - randomOffset;

        wheel.style.transform = `rotate(${finalAngle}deg)`;

        setTimeout(() => {
            if (won) {
                spinResultContainer.innerHTML = `<p style="color:var(--primary-gold)">🎉 YOU WON £${prizeValue.toFixed(2)}! 🎉</p>`;
            } else {
                spinResultContainer.innerHTML = `<p>Better luck next time!</p>`;
            }
             // Let user spin again
            spinButton.disabled = false;
            spinButton.textContent = 'SPIN THE WHEEL';
            isSpinning = false;
        }, 8500); // Match timeout to animation duration

    } catch (error) {
        console.error("Error spending token:", error);
        spinResultContainer.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        spinButton.disabled = false;
        spinButton.textContent = 'SPIN THE WHEEL';
        isSpinning = false;
    }
});
