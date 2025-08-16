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
let userCreditBalance = 0;
let spinnerPrizes = [];
let isSpinning = false;
let userProfileUnsubscribe = null;
let currentCompetitionData = null; // FIX: Added missing state variable

// ===================================================================
// == CONFIGURATION: PRIZE ANGLES ALIGNED WITH YOUR WHEEL IMAGE     ==
// ===================================================================
const PRIZE_ANGLES = {
    'cash-1000': 150,
    'cash-500': 210,
    'cash-250': 300,
    'cash-100': 0,
    'cash-50': 60,
    'credit-20': 30,
    'credit-10': 270,
    'credit-5': 120,
    'no-win': [90, 180, 240, 330] 
};
// ===================================================================

const tokenCountElement = document.getElementById('token-count');
const tokenAccordionContainer = document.getElementById('token-accordion-container');
const wheel = document.getElementById('wheel');
const spinButton = document.getElementById('spin-button');
const spinResultContainer = document.getElementById('spin-result');
const buyMoreBtn = document.getElementById('buy-more-tokens-btn');
const purchaseModal = document.getElementById('purchase-modal');
const prizesModal = document.getElementById('prizes-modal');
const showPrizesBtn = document.getElementById('show-prizes-btn');
const prizesTableContainer = document.getElementById('prizes-table-container');

onAuthStateChanged(auth, (user) => {
    if (user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe();
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                const tokens = data.spinTokens || [];
                userCreditBalance = data.creditBalance || 0;
                userTokens = tokens.sort((a, b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000));
                updateUI();
            }
        });
        loadPrizeSettings();
    } else {
        window.location.replace('login.html');
    }
});

function updateUI() {
    const tokenCount = userTokens.length;
    tokenCountElement.textContent = tokenCount;
    spinButton.disabled = tokenCount === 0 || isSpinning;

    if (tokenCount === 0) {
        spinButton.textContent = "NO SPINS AVAILABLE";
        tokenAccordionContainer.innerHTML = `<div class="placeholder">You have no Spin Tokens. Enter a competition to earn them!</div>`;
    } else {
        if (!isSpinning) {
            spinButton.textContent = "SPIN THE WHEEL";
        }
        renderTokenAccordion();
    }
}

async function loadPrizeSettings() {
    try {
        const settingsRef = doc(db, 'admin_settings', 'spinnerPrizes');
        const docSnap = await getDoc(settingsRef);
        if (docSnap.exists() && docSnap.data().prizes) {
            spinnerPrizes = docSnap.data().prizes;
            renderPrizesTable(spinnerPrizes);
        } else {
            console.error("Spinner settings not found in Firestore.");
        }
    } catch (error) {
        console.error("Error fetching spinner prizes:", error);
    }
}

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

function renderPrizesTable(prizes) {
    let tableHTML = `
        <table class="prizes-table">
            <thead><tr><th>Prize</th><th>Odds</th></tr></thead>
            <tbody>`;
    prizes.forEach(prize => {
        const prizeText = prize.type === 'credit' ? `£${prize.value} Site Credit` : `£${prize.value} Cash`;
        tableHTML += `<tr><td>${prizeText}</td><td>1 in ${prize.odds.toLocaleString()}</td></tr>`;
    });
    tableHTML += `</tbody></table>`;
    prizesTableContainer.innerHTML = tableHTML;
}

async function handleSpin() {
    if (userTokens.length === 0 || isSpinning) return;

    isSpinning = true;
    spinButton.textContent = 'SPINNING...';
    updateUI();
    spinResultContainer.innerHTML = '';
    
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    void wheel.offsetWidth;

    const tokenToSpend = userTokens[0];
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');

    try {
        const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
        const { won, prizeType, value } = result.data;

        let targetAngle;
        if (won) {
            const prizeKey = `${prizeType}-${value}`;
            targetAngle = PRIZE_ANGLES[prizeKey];
        }
        
        if (targetAngle === undefined) {
            const noWinAngles = PRIZE_ANGLES['no-win'];
            targetAngle = noWinAngles[Math.floor(Math.random() * noWinAngles.length)];
        }
        
        const baseSpins = 360 * 8;
        const randomOffsetInSegment = (Math.random() - 0.5) * 20;
        const finalAngle = baseSpins + (360 - targetAngle) + randomOffsetInSegment;
        
        wheel.style.transition = 'transform 8s cubic-bezier(0.25, 0.1, 0.25, 1)';
        wheel.style.transform = `rotate(${finalAngle}deg)`;

        setTimeout(() => {
            if (won) {
                const prizeValue = (typeof value === 'number') ? value.toFixed(2) : '0.00';
                const prizeText = prizeType === 'credit' ? `£${prizeValue} SITE CREDIT` : `£${prizeValue} CASH`;
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
}

// --- Event Handlers ---
spinButton.addEventListener('click', handleSpin);

buyMoreBtn.addEventListener('click', async () => {
    const modalContent = document.getElementById('purchase-modal-content');
    modalContent.innerHTML = `<h2>Get More Spins</h2><p class="placeholder">Loading competition...</p>`;
    purchaseModal.classList.add('show');
    
    try {
        const compRef = doc(db, 'spinner_competitions', 'active');
        const docSnap = await getDoc(compRef);
        if (!docSnap.exists()) throw new Error('No active spinner competition found.');
        
        currentCompetitionData = docSnap.data(); // FIX: Populate the missing variable
        const answersHTML = Object.entries(currentCompetitionData.skillQuestion.answers)
            .map(([key, value]) => `<button class="answer-btn" data-answer="${key}">${value}</button>`).join('');

        const bundles = [
            { amount: 5, price: 4.50 },
            { amount: 10, price: 8.00 },
            { amount: 25, price: 15.00 },
        ];
        const bundlesHTML = bundles.map(b => `<button class="ticket-option" data-amount="${b.amount}" data-price="${b.price}">${b.amount} Entries for £${b.price.toFixed(2)}</button>`).join('');

        modalContent.innerHTML = `
            <h2>${currentCompetitionData.title}</h2>
            <p>Enter our weekly draw for a chance to win <strong>${currentCompetitionData.prize}</strong> and get bonus spin tokens instantly!</p>
            <form id="spinner-entry-form" class="modal-form">
                <div class="skill-question-box" style="padding: 1rem 0;">
                    <p class="question-text">${currentCompetitionData.skillQuestion.text}</p>
                    <div class="answer-options">${answersHTML}</div>
                </div>
                <div class="ticket-selector-box" style="padding: 1rem 0;">
                     <div class="ticket-options">${bundlesHTML}</div>
                </div>
                <div id="credit-payment-option" style="display:none; margin-top: 1rem;"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-close-modal>Cancel</button>
                    <button type="submit" class="btn">Confirm & Pay</button>
                </div>
            </form>
        `;

        const form = document.getElementById('spinner-entry-form');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            handleSpinnerCompEntry(form, currentCompetitionData.skillQuestion.correctAnswer);
        });

    } catch (error) {
        console.error(error);
        modalContent.innerHTML = `<h2>Error</h2><p>${error.message}</p><button class="btn" data-close-modal>Close</button>`;
    }
});

async function handleSpinnerCompEntry(form, correctAnswer, paymentMethod = 'card') {
    const selectedAnswer = form.querySelector('.answer-btn.selected');
    const selectedBundle = form.querySelector('.ticket-option.selected');

    if (!selectedAnswer) { alert('Please answer the question.'); return; }
    if (selectedAnswer.dataset.answer !== correctAnswer) { alert('Incorrect answer. Please try again.'); return; }
    if (!selectedBundle) { alert('Please select a bundle.'); return; }

    const submitBtn = form.querySelector('button[type="submit"]');
    const creditBtn = form.querySelector('#pay-with-credit-btn');
    if(submitBtn) submitBtn.disabled = true;
    if(creditBtn) creditBtn.disabled = true;
    
    const originalText = paymentMethod === 'credit' ? creditBtn.textContent : submitBtn.textContent;
    const targetBtn = paymentMethod === 'credit' ? creditBtn : submitBtn;
    if(targetBtn) targetBtn.textContent = 'Processing...';

    try {
        const enterSpinnerCompetition = httpsCallable(functions, 'enterSpinnerCompetition');
        await enterSpinnerCompetition({
            compId: 'active',
            bundle: {
                amount: parseInt(selectedBundle.dataset.amount),
                price: parseFloat(selectedBundle.dataset.price)
            },
            paymentMethod: paymentMethod
        });
        purchaseModal.classList.remove('show');
    } catch (error) {
        console.error("Spinner comp entry failed:", error);
        alert(`Entry failed: ${error.message}`);
    } finally {
        if(submitBtn) submitBtn.disabled = false;
        if(creditBtn) creditBtn.disabled = false;
        if(targetBtn) targetBtn.textContent = originalText;
    }
}

document.getElementById('purchase-modal').addEventListener('click', (e) => {
    const target = e.target;
    if (target.closest('.answer-btn')) {
        target.closest('.answer-options').querySelectorAll('.answer-btn').forEach(btn => btn.classList.remove('selected'));
        target.closest('.answer-btn').classList.add('selected');
    }
    if (target.closest('.ticket-option')) {
        const bundle = target.closest('.ticket-option');
        const price = parseFloat(bundle.dataset.price);
        target.closest('.ticket-options').querySelectorAll('.ticket-option').forEach(opt => opt.classList.remove('selected'));
        bundle.classList.add('selected');

        const creditOptionDiv = document.getElementById('credit-payment-option');
        if (userCreditBalance >= price) {
            creditOptionDiv.innerHTML = `<button type="button" id="pay-with-credit-btn" class="btn btn-credit">Pay with £${price.toFixed(2)} Credit</button>`;
            creditOptionDiv.style.display = 'block';
            document.getElementById('pay-with-credit-btn').onclick = () => {
                 handleSpinnerCompEntry(target.closest('form'), currentCompetitionData.skillQuestion.correctAnswer, 'credit');
            };
        } else {
            creditOptionDiv.style.display = 'none';
        }
    }
});

showPrizesBtn.addEventListener('click', () => prizesModal.classList.add('show'));
const closeModalHandler = (e) => {
    if (e.target.matches('.modal-container') || e.target.closest('[data-close-modal]')) {
        e.target.closest('.modal-container').classList.remove('show');
    }
};
purchaseModal.addEventListener('click', closeModalHandler);
prizesModal.addEventListener('click', closeModalHandler);
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
