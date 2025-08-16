'use strict';

import { getAuth } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
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
let currentCompetitionData = null;

// --- REFACTOR: The PRIZE_ANGLES map is no longer needed as the wheel's visual stopping point is now random. ---

const tokenCountElement = document.getElementById('token-count');
const creditBalanceElement = document.getElementById('credit-balance-display');
const tokenAccordionContainer = document.getElementById('token-accordion-container');
const wheel = document.getElementById('wheel');
const spinButton = document.getElementById('spin-button');
const spinResultContainer = document.getElementById('spin-result');
const buyMoreBtn = document.getElementById('buy-more-tokens-btn');
const purchaseModal = document.getElementById('purchase-modal');
const prizesModal = document.getElementById('prizes-modal');
const showPrizesBtn = document.getElementById('show-prizes-btn');
const prizesTableContainer = document.getElementById('prizes-table-container');

function createElement(tag, options = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
        if (key === 'class') {
            const classes = Array.isArray(value) ? value : String(value).split(' ');
            classes.forEach(c => { if (c) el.classList.add(c); });
        } else if (key === 'textContent') { el.textContent = value;
        } else if (key === 'style') { Object.assign(el.style, value);
        } else { el.setAttribute(key, value); }
    });
    children.forEach(child => child && el.append(child));
    return el;
}

auth.onAuthStateChanged((user) => {
    if (user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe();
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                userCreditBalance = data.creditBalance || 0;
                userTokens = (data.spinTokens || []).sort((a, b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000));
                if (!isSpinning) {
                    updateUI();
                }
            }
        });
        loadPrizeSettings();
    } else {
        window.location.replace('login.html');
    }
});

function updateUI() {
    tokenCountElement.textContent = userTokens.length;
    creditBalanceElement.textContent = `£${userCreditBalance.toFixed(2)}`;
    spinButton.disabled = userTokens.length === 0 || isSpinning;
    renderTokenAccordion();
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
    tokenAccordionContainer.innerHTML = '';
    if (userTokens.length === 0) {
        tokenAccordionContainer.append(createElement('div', { class: 'placeholder', textContent: 'You have no Spin Tokens. Enter a competition to earn them!' }));
        return;
    }
    const groupedTokens = userTokens.reduce((acc, token) => {
        const groupTitle = token.compTitle || "Purchased Tokens";
        (acc[groupTitle] = acc[groupTitle] || []).push(token);
        return acc;
    }, {});

    const fragment = document.createDocumentFragment();
    for (const groupTitle in groupedTokens) {
        const tokens = groupedTokens[groupTitle];
        const date = new Date(tokens[0].earnedAt.seconds * 1000).toLocaleDateString();
        
        const content = createElement('div', { class: 'accordion-content' }, [
            createElement('ul', {}, tokens.map(t => createElement('li', { textContent: `Token ID: ...${t.tokenId.slice(-8)}` })))
        ]);

        const header = createElement('button', { class: 'accordion-header' }, [
            createElement('span', { textContent: groupTitle }),
            createElement('span', { class: 'accordion-meta', textContent: `${tokens.length} Token(s) - Earned ${date}` }),
            createElement('span', { class: 'accordion-arrow' })
        ]);
        
        fragment.append(createElement('div', { class: 'accordion-item' }, [header, content]));
    }
    tokenAccordionContainer.append(fragment);
}

function renderPrizesTable(prizes) {
    prizesTableContainer.innerHTML = '';
    const tableRows = prizes.map(prize => {
        const prizeText = prize.type === 'credit' ? `£${prize.value.toFixed(2)} Site Credit` : `£${prize.value.toFixed(2)} Cash`;
        return createElement('tr', {}, [
            createElement('td', { textContent: prizeText }),
            createElement('td', { textContent: `1 in ${prize.odds.toLocaleString()}` })
        ]);
    });
    
    const table = createElement('table', { class: 'prizes-table' }, [
        createElement('thead', {}, [createElement('tr', {}, [createElement('th', { textContent: 'Prize' }), createElement('th', { textContent: 'Odds' })])]),
        createElement('tbody', {}, tableRows)
    ]);
    prizesTableContainer.append(table);
}

async function handleSpin() {
    if (userTokens.length === 0 || isSpinning) return;

    isSpinning = true;
    spinButton.disabled = true;
    spinButton.textContent = '...';
    spinResultContainer.innerHTML = '';
    
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    void wheel.offsetWidth; 

    const tokenToSpend = userTokens[0];
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');

    try {
        const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
        
        userTokens.shift(); 
        updateUI(); 
        
        const { won, prizeType, value } = result.data;

        // --- REFACTOR: Simplified Random Spin Animation ---
        const baseSpins = 360 * 8; 
        const randomAdditionalRotation = Math.random() * 360;
        const finalAngle = baseSpins + randomAdditionalRotation;
        
        wheel.style.transition = 'transform 8s cubic-bezier(0.25, 0.1, 0.25, 1)';
        wheel.style.transform = `rotate(${finalAngle}deg)`;
        // --- END OF REFACTOR ---

        setTimeout(() => {
            spinResultContainer.innerHTML = '';
            if (won) {
                const prizeValue = (typeof value === 'number') ? value.toFixed(2) : '0.00';
                const prizeText = prizeType === 'credit' ? `£${prizeValue} SITE CREDIT` : `£${prizeValue} CASH`;
                spinResultContainer.append(createElement('p', { class: 'spin-win', textContent: `🎉 YOU WON ${prizeText}! 🎉` }));
            } else {
                spinResultContainer.append(createElement('p', { textContent: 'Better luck next time!' }));
            }
            isSpinning = false;
            spinButton.textContent = 'SPIN';
            updateUI(); 
        }, 8500);

    } catch (error) {
        console.error("Error spending token:", error);
        spinResultContainer.innerHTML = '';
        spinResultContainer.append(createElement('p', { class: 'spin-error', textContent: `Error: ${error.message}` }));
        isSpinning = false;
        spinButton.textContent = 'SPIN';
        updateUI();
    }
}

spinButton.addEventListener('click', handleSpin);

buyMoreBtn.addEventListener('click', async () => {
    const modalContent = document.getElementById('purchase-modal-content');
    modalContent.innerHTML = '';
    modalContent.append(createElement('h2', { textContent: 'Get More Spins' }), createElement('p', { class: 'placeholder', textContent: 'Loading competition...' }));
    purchaseModal.classList.add('show');
    
    try {
        const compRef = doc(db, 'spinner_competitions', 'active');
        const docSnap = await getDoc(compRef);
        if (!docSnap.exists()) throw new Error('No active spinner competition found.');
        
        currentCompetitionData = docSnap.data();
        const answers = Object.entries(currentCompetitionData.skillQuestion.answers)
            .map(([key, value]) => createElement('button', { type: 'button', class: 'answer-btn', 'data-answer': key, textContent: value }));

        const bundles = [ { amount: 5, price: 4.50 }, { amount: 10, price: 8.00 }, { amount: 25, price: 15.00 } ];
        const bundleButtons = bundles.map(b => createElement('button', { type: 'button', class: 'ticket-option', 'data-amount': b.amount, 'data-price': b.price, textContent: `${b.amount} Entries for £${b.price.toFixed(2)}` }));

        modalContent.innerHTML = '';
        const form = createElement('form', { id: 'spinner-entry-form', class: 'modal-form' }, [
            createElement('div', { class: 'skill-question-box', style: { padding: '1rem 0' } }, [
                createElement('p', { class: 'question-text', textContent: currentCompetitionData.skillQuestion.text }),
                createElement('div', { class: 'answer-options' }, answers)
            ]),
            createElement('div', { class: 'ticket-selector-box', style: { padding: '1rem 0' } }, [
                 createElement('div', { class: 'ticket-options' }, bundleButtons)
            ]),
            createElement('div', { id: 'credit-payment-option', style: { display: 'none', marginTop: '1rem' } }),
            createElement('div', { class: 'modal-actions' }, [
                createElement('button', { type: 'button', class: ['btn', 'btn-secondary'], 'data-close-modal': true }, ['Cancel']),
                createElement('button', { type: 'submit', class: 'btn' }, ['Confirm & Pay'])
            ])
        ]);
        
        modalContent.append(
            createElement('h2', { textContent: currentCompetitionData.title }),
            createElement('p', {}, ['Enter our weekly draw for a chance to win ', createElement('strong', { textContent: currentCompetitionData.prize }), ' and get bonus spin tokens instantly!']),
            form
        );

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            handleSpinnerCompEntry(form, currentCompetitionData.skillQuestion.correctAnswer, 'card');
        });

    } catch (error) {
        console.error(error);
        modalContent.innerHTML = '';
        modalContent.append(
            createElement('h2', { textContent: 'Error' }),
            createElement('p', { textContent: error.message }),
            createElement('button', { class: 'btn', 'data-close-modal': true }, ['Close'])
        );
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
    
    const targetBtn = paymentMethod === 'credit' ? creditBtn : submitBtn;
    const originalText = targetBtn ? targetBtn.textContent : '';
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
        creditOptionDiv.innerHTML = '';
        if (userCreditBalance >= price) {
            const creditButton = createElement('button', { type: 'button', id: 'pay-with-credit-btn', class: ['btn', 'btn-credit'], textContent: `Pay with £${price.toFixed(2)} Credit` });
            creditButton.onclick = () => {
                 handleSpinnerCompEntry(target.closest('form'), currentCompetitionData.skillQuestion.correctAnswer, 'credit');
            };
            creditOptionDiv.append(creditButton);
            creditOptionDiv.style.display = 'block';
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
    content.style.maxHeight = content.style.maxHeight ? null : `${content.scrollHeight}px`;
});
