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
let currentCompPrizes = [];
let selectedTokenId = null;
let isSpinning = false;
let userProfileUnsubscribe = null;

// --- DOM Elements ---
const tokenListContainer = document.getElementById('token-list-container');
const gamePlaceholder = document.getElementById('game-placeholder');
const spinGameContainer = document.getElementById('spin-game-container');
const wheel = document.getElementById('wheel');
const spinButton = document.getElementById('spin-button');
const spinResultContainer = document.getElementById('spin-result');

// --- Auth Gate ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe(); // Unsubscribe from old listener if exists
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

async function renderWheel(prizes) {
    if (!wheel || prizes.length === 0) return;
    
    // Create a representative prize pool for the wheel visual
    const wheelSegments = [...prizes];
    while (wheelSegments.length < 12) { // Ensure a minimum number of segments for visual appeal
        wheelSegments.push({ prizeValue: 0 }); // Add "Better Luck" segments
    }
    wheelSegments.sort(() => Math.random() - 0.5); // Shuffle for display

    const segmentAngle = 360 / wheelSegments.length;
    const colors = ['#333', '#444'];
    wheel.innerHTML = wheelSegments.map((prize, i) => {
        const rotation = i * segmentAngle;
        const clipPath = `polygon(50% 50%, 50% 0, ${50 + 50 * Math.tan(segmentAngle * Math.PI / 180)}% 0, 50% 50%)`;
        const labelRotation = segmentAngle / 2;
        const labelText = prize.prizeValue > 0 ? `£${prize.prizeValue}` : 'Try Again';

        return `<div class="wheel-segment" style="transform: rotate(${rotation}deg); clip-path: ${clipPath}; background-color: ${colors[i % 2]};">
                    <div class="segment-label" style="transform: translateX(-50%) rotate(${labelRotation}deg);">${labelText}</div>
                </div>`;
    }).join('');

    gamePlaceholder.style.display = 'none';
    spinGameContainer.style.display = 'block';
    spinButton.disabled = false;
    spinButton.textContent = 'SPIN THE WHEEL';
    spinResultContainer.innerHTML = '';
}

// --- Data Fetching ---
async function getCompetitionPrizes(compId) {
    try {
        const compRef = doc(db, 'competitions', compId);
        const compSnap = await getDoc(compRef);
        if (compSnap.exists() && compSnap.data().instantWinsConfig?.prizes) {
            // Flatten the prize tiers into a simple list of values
            const prizes = compSnap.data().instantWinsConfig.prizes;
            return prizes.flatMap(tier => Array(tier.count).fill({ prizeValue: tier.value }));
        }
        return [];
    } catch (error) {
        console.error("Error fetching competition prizes:", error);
        return [];
    }
}

// --- Event Handlers ---
tokenListContainer.addEventListener('click', async (e) => {
    const button = e.target.closest('.token-btn');
    if (!button || isSpinning) return;

    // Deselect previous
    document.querySelectorAll('.token-btn.selected').forEach(btn => btn.classList.remove('selected'));
    // Select new
    button.classList.add('selected');
    
    selectedTokenId = button.dataset.tokenId;
    const compId = button.dataset.compId;

    spinButton.disabled = true;
    spinButton.textContent = 'Loading Prizes...';
    
    currentCompPrizes = await getCompetitionPrizes(compId);
    await renderWheel(currentCompPrizes);
});

spinButton.addEventListener('click', async () => {
    if (!selectedTokenId || isSpinning) return;

    isSpinning = true;
    spinButton.disabled = true;
    spinButton.textContent = 'SPINNING...';
    spinResultContainer.innerHTML = '';
    wheel.style.transition = 'transform 6s cubic-bezier(0.25, 0.1, 0.25, 1)';
    
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');
    try {
        const result = await spendTokenFunc({ tokenId: selectedTokenId });
        const { won, prizeValue } = result.data;

        // --- Calculate Spin Result ---
        const segmentCount = wheel.children.length;
        const segmentAngle = 360 / segmentCount;
        let targetSegmentIndex = -1;

        if (won) {
            // Find a segment on the wheel that matches the prize value
            const prizeSegments = Array.from(wheel.querySelectorAll('.segment-label')).map((el, i) => ({ text: el.textContent, index: i }));
            const matchingSegment = prizeSegments.find(s => s.text === `£${prizeValue}`);
            targetSegmentIndex = matchingSegment ? matchingSegment.index : 0;
        } else {
            // Find a "Try Again" segment
             const prizeSegments = Array.from(wheel.querySelectorAll('.segment-label')).map((el, i) => ({ text: el.textContent, index: i }));
            const matchingSegment = prizeSegments.find(s => s.text === 'Try Again');
            targetSegmentIndex = matchingSegment ? matchingSegment.index : 0;
        }
        
        // Complex rotation calculation for a realistic spin
        const baseRotation = 360 * 5; // 5 full spins
        const targetAngle = (targetSegmentIndex * segmentAngle) + (segmentAngle / 2); // Center of the segment
        const randomOffset = (Math.random() - 0.5) * (segmentAngle * 0.8);
        const finalAngle = baseRotation - targetAngle - randomOffset;

        wheel.style.transform = `rotate(${finalAngle}deg)`;

        // --- Handle Result After Animation ---
        setTimeout(() => {
            if (won) {
                spinResultContainer.innerHTML = `<p style="color:var(--primary-gold)">🎉 YOU WON £${prizeValue.toFixed(2)}! 🎉</p>`;
            } else {
                spinResultContainer.innerHTML = `<p>Better luck next time!</p>`;
            }
            isSpinning = false;
            // The onSnapshot listener will automatically remove the spent token from the UI.
            selectedTokenId = null; 
            document.querySelectorAll('.token-btn.selected').forEach(btn => btn.classList.remove('selected'));
        }, 6500); // A bit longer than the spin animation

    } catch (error) {
        console.error("Error spending token:", error);
        spinResultContainer.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        isSpinning = false;
        spinButton.disabled = false;
        spinButton.textContent = 'SPIN THE WHEEL';
    }
});
