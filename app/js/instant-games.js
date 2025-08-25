'use strict';

import { getAuth } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, onSnapshot, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

// --- Singletons & State ---
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
let userTokens = []; // Spinner tokens
// let userPlinkoTokens = []; // Plinko tokens
let userProfile = {};
let userCreditBalance = 0;
let spinnerPrizes = [];
// let plinkoConfig = {};
let isSpinning = false;
let userProfileUnsubscribe = null;
let activeTokenCompetition = null;

// --- DOM Elements ---
const tokenCountElement = document.getElementById('token-count');
// const plinkoTokenCountElement = document.getElementById('plinko-token-count');
const creditBalanceElement = document.getElementById('credit-balance-display');
const tokenAccordionContainer = document.getElementById('token-accordion-container');
const buySpinnerBtn = document.getElementById('buy-spinner-tokens-btn');
// const buyPlinkoBtn = document.getElementById('buy-plinko-tokens-btn');
// const buyPlinkoBtn2 = document.getElementById('buy-plinko-tokens-btn-2');
const purchaseModal = document.getElementById('purchase-modal');
const winCelebrationModal = document.getElementById('win-celebration-modal');

// Spinner Elements
const wheel = document.getElementById('wheel');
const spinButton = document.getElementById('spin-button');
const spinX3Button = document.getElementById('spin-x3-button');
const spinX5Button = document.getElementById('spin-x5-button');
const spinPrizeReveal = document.getElementById('spin-prize-reveal');
const spinResultContainer = document.getElementById('spin-result');
const showPrizesBtn = document.getElementById('show-prizes-btn');
const prizesModal = document.getElementById('prizes-modal');
const prizesTableContainer = document.getElementById('prizes-table-container');

// Plinko Elements
// const plinkoSvg = document.getElementById('plinko-svg');
// const plinkoBoard = document.getElementById('plinko-board');
// const plinkoDrop1Btn = document.getElementById('plinko-drop-1');
// const plinkoDrop3Btn = document.getElementById('plinko-drop-3');
// const plinkoBalanceDisplay = document.getElementById('plinko-balance-display');
// let plinkoActiveBalls = 0;
// const MAX_PLINKO_BALLS = 12;

// --- Utility Functions ---
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

// --- Initialization ---
auth.onAuthStateChanged((user) => {
    if (user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe();
        const userDocRef = doc(db, 'users', user.uid);
        userProfileUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists()) {
                userProfile = docSnap.data();
                userCreditBalance = userProfile.creditBalance || 0;
                userTokens = (userProfile.spinTokens || []).sort((a, b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000));
                // userPlinkoTokens = (userProfile.plinkoTokens || []);
                if (!isSpinning) {
                    updateUI();
                }
            }
        });
        loadAllGameSettings();
    } else {
        window.location.replace('login.html');
    }
});

async function loadAllGameSettings() {
    try {
        const settingsRef = doc(db, 'admin_settings', 'spinnerPrizes');
        const docSnap = await getDoc(settingsRef);
        if (docSnap.exists() && docSnap.data().prizes) {
            spinnerPrizes = docSnap.data().prizes;
            renderPrizesTable(spinnerPrizes);
        } else { console.error("Spinner settings not found."); }
    } catch (error) { console.error("Error fetching spinner prizes:", error); }

    /*
    try {
        const plinkoSettingsRef = doc(db, 'admin_settings', 'plinkoPrizes');
        const docSnap = await getDoc(plinkoSettingsRef);
        if (docSnap.exists()) {
            plinkoConfig = docSnap.data();
        } else {
            plinkoConfig = { rows: 12, gravity: 1.0, payouts: [
                {type: 'credit', value: 0}, {type: 'credit', value: 0.2}, {type: 'credit', value: 0.5},
                {type: 'credit', value: 1}, {type: 'credit', value: 2}, {type: 'credit', value: 5},
                {type: 'credit', value: 10}, {type: 'credit', value: 5}, {type: 'credit', value: 2},
                {type: 'credit', value: 1}, {type: 'credit', value: 0.5}, {type: 'credit', value: 0.2},
                {type: 'credit', value: 0}
            ] };
        }
        initializePlinkoBoard();
    } catch (error) { console.error("Error fetching plinko prizes:", error); }
    */
}


function updateUI() {
    tokenCountElement.textContent = userTokens.length;
    creditBalanceElement.textContent = `£${userCreditBalance.toFixed(2)}`;

    const tokensAvailable = userTokens.length;
    spinButton.disabled = tokensAvailable < 1 || isSpinning;
    spinX3Button.disabled = tokensAvailable < 3 || isSpinning;
    spinX5Button.disabled = tokensAvailable < 5 || isSpinning;

    renderTokenAccordion();
}

function initializeHub() {
    const tabButtons = document.querySelectorAll('.game-tab-btn');
    const gamePanels = document.querySelectorAll('.game-panel');
    const controlsPanels = document.querySelectorAll('.game-controls-panel');
    const layoutContainer = document.getElementById('game-hub-layout');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.dataset.gametab;

            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            gamePanels.forEach(panel => {
                panel.classList.toggle('active', panel.id === `${targetTab}-game-container`);
            });
            
            controlsPanels.forEach(panel => {
                panel.classList.toggle('active', panel.id === `${targetTab}-controls`);
            });
            
            layoutContainer.className = `instant-win-layout ${targetTab}-active`;
        });
    });
}
initializeHub();


// --- Spinner Logic ---
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

function showWinCelebrationModal(prizeType, value, game = 'spinner') {
    const prizeValueText = `£${value.toFixed(2)}`;
    const prizeTypeText = prizeType === 'credit' ? "SITE CREDIT" : "CASH";

    const closeBtn = createElement('button', { class: 'btn', textContent: 'Close' });
    closeBtn.addEventListener('click', closeWinCelebrationModal, { once: true });

    const modalContent = createElement('div', { class: 'modal-content' }, [
        createElement('div', { class: 'win-modal-icon', textContent: '🏆' }),
        createElement('p', { class: 'win-modal-heading', textContent: 'YOU WON!' }),
        createElement('h2', { class: 'win-modal-prize-value', textContent: prizeValueText }),
        createElement('p', { class: 'win-modal-prize-type', textContent: prizeTypeText }),
        createElement('div', { class: 'win-modal-actions' }, [closeBtn])
    ]);
    
    const confettiContainer = createElement('div', { class: 'confetti-container' });
    for (let i = 0; i < 100; i++) {
        confettiContainer.appendChild(createElement('div', { class: 'confetti', style: { left: `${Math.random() * 100}%`, animationDelay: `${Math.random() * 4}s`, animationDuration: `${2 + Math.random() * 2}s` } }));
    }
    modalContent.prepend(confettiContainer);

    winCelebrationModal.innerHTML = '';
    winCelebrationModal.append(modalContent);
    winCelebrationModal.classList.add('show');
}

function closeWinCelebrationModal() {
    winCelebrationModal.classList.add('closing');
    setTimeout(() => {
        winCelebrationModal.classList.remove('show', 'closing');
        winCelebrationModal.innerHTML = '';
    }, 300);
}

async function handleMultiSpin(spinCount) {
    if (userTokens.length < spinCount || isSpinning) return;

    isSpinning = true;
    updateUI();
    spinPrizeReveal.classList.remove('revealed');
    spinPrizeReveal.classList.add('is-spinning');
    spinResultContainer.innerHTML = '';

    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    void wheel.offsetWidth;

    const spinResults = [];
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');

    // --- BUG FIX ---
    // Create a static copy of the tokens to be spent. This prevents a race condition
    // where the onSnapshot listener modifies the userTokens array while this loop is running.
    const tokensToSpend = userTokens.slice(0, spinCount);

    for (const tokenToSpend of tokensToSpend) {
        try {
            // Pass the tokenId from our static 'tokensToSpend' array
            const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
            spinResults.push(result.data);
        } catch (error) {
            console.error(`Error on spin for token ${tokenToSpend.tokenId}:`, error);
            // If a spin fails, we push a non-winning result. The user's token is not
            // consumed by the backend in this case, so it will reappear on the next UI update.
            spinResults.push({ won: false, error: error.message });
        }
    }

    const baseSpins = 360 * (2 + spinCount); // Longer spin for more items
    const randomAdditionalRotation = Math.random() * 360;
    const finalAngle = baseSpins + randomAdditionalRotation;
    const spinDuration = 2 + spinCount * 0.5; // Longer duration

    // This optimistic update is removed. The UI will now only update when the
    // onSnapshot listener receives the new token count from the server,
    // which is the source of truth. This prevents visual glitches.

    wheel.style.transition = `transform ${spinDuration}s cubic-bezier(0.25, 0.1, 0.25, 1)`;
    wheel.style.transform = `rotate(${finalAngle}deg)`;

    setTimeout(() => {
        const wins = spinResults.filter(r => r.won);
        if (wins.length > 1) {
            showMultiWinModal(wins);
        } else if (wins.length === 1) {
            showWinCelebrationModal(wins[0].prizeType, wins[0].value, 'spinner');
        } else {
            spinResultContainer.innerHTML = '';
            spinResultContainer.append(createElement('p', { textContent: 'Better luck next time!' }));
        }

        isSpinning = false;
        spinPrizeReveal.classList.remove('is-spinning');
        updateUI();
    }, spinDuration * 1000 + 500);
}

function showMultiWinModal(wins) {
    const totalCredit = wins.filter(w => w.prizeType === 'credit').reduce((acc, w) => acc + w.value, 0);
    const totalCash = wins.filter(w => w.prizeType === 'cash').reduce((acc, w) => acc + w.value, 0);

    const resultsList = createElement('div', { class: 'multi-win-results-list' });
    wins.forEach((win, index) => {
        const prizeItem = createElement('div', { class: ['multi-win-item', `is-${win.prizeType}`], style: { animationDelay: `${index * 0.2}s` } }, [
            createElement('span', { class: 'multi-win-prize-type', textContent: `${win.prizeType === 'credit' ? 'Site Credit' : 'Cash'}` }),
            createElement('span', { class: 'multi-win-prize-value', textContent: `£${win.value.toFixed(2)}` })
        ]);
        resultsList.append(prizeItem);
    });

    const totalSection = createElement('div', { class: 'multi-win-total' }, [
        createElement('h3', { textContent: `Total Won: £${(totalCredit + totalCash).toFixed(2)}` })
    ]);

    const closeBtn = createElement('button', { class: 'btn', textContent: 'Awesome!' });
    closeBtn.addEventListener('click', closeWinCelebrationModal, { once: true });

    const modalContent = createElement('div', { class: 'modal-content' }, [
        createElement('div', { class: 'win-modal-icon', textContent: '🎉' }),
        createElement('p', { class: 'win-modal-heading', textContent: 'MULTIPLE WINS!' }),
        resultsList,
        totalSection,
        createElement('div', { class: 'win-modal-actions' }, [closeBtn])
    ]);

    winCelebrationModal.innerHTML = '';
    winCelebrationModal.append(modalContent);
    winCelebrationModal.classList.add('show', 'multi-win-modal');
}

const allSpinButtons = [spinButton, spinX3Button, spinX5Button];

const createSpinHandler = (spinCount) => {
    return () => {
        // First, check if a spin is already in progress. This is the primary guard.
        if (isSpinning) {
            console.warn("Spin attempt ignored: already spinning.");
            return;
        }

        // Immediately disable all buttons to prevent double-clicks or race conditions
        // before the async handleMultiSpin function sets its own isSpinning flag.
        allSpinButtons.forEach(btn => btn.disabled = true);

        // Now, call the main logic
        handleMultiSpin(spinCount);
    };
};

spinButton.addEventListener('click', createSpinHandler(1));
spinX3Button.addEventListener('click', createSpinHandler(3));
spinX5Button.addEventListener('click', createSpinHandler(5));

spinPrizeReveal.addEventListener('click', () => {
    if (isSpinning || spinPrizeReveal.classList.contains('revealed')) return;
    spinPrizeReveal.classList.add('revealed');
});


// --- Plinko Logic ---
/*
let plinkoPegs = [], plinkoSlots = [], plinkoOffsets = [];

function initializePlinkoBoard() {
    const PLINKO_ROWS = plinkoConfig.rows || 12;
    while (plinkoSvg.firstChild) plinkoSvg.removeChild(plinkoSvg.firstChild);

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
        <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#f4d488"/>
            <stop offset="45%" stop-color="#e0a94a"/>
            <stop offset="100%" stop-color="#b38a37"/>
        </linearGradient>
    `;
    plinkoSvg.appendChild(defs);

    const W = 800, H = 900, margin = 60, rowGap = 58;
    const usableWidth = W - margin * 2;
    const colGap = usableWidth / (PLINKO_ROWS + 1);

    plinkoPegs = []; plinkoSlots = []; plinkoOffsets = [];

    for (let r = 0; r < PLINKO_ROWS; r++) {
        const pegsInRow = r + 1;
        const offset = (usableWidth - (pegsInRow - 1) * colGap) / 2 + margin;
        plinkoOffsets[r] = offset;
        const row = [];
        const y = margin + rowGap * (r + 1);
        for (let k = 0; k < pegsInRow; k++) {
            const x = offset + k * colGap;
            row.push(x);
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 8);
            c.setAttribute('class', 'peg');
            plinkoSvg.appendChild(c);
        }
        plinkoPegs[r] = row;
    }

    const slotsY = margin + rowGap * (PLINKO_ROWS + 1) + 10;
    for (let s = 0; s <= PLINKO_ROWS; s++) {
        const x = margin + (s + 0.5) * colGap;
        const w = colGap * 0.9;
        plinkoSlots.push({ x, width: w, idx: s });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', x - w / 2); rect.setAttribute('y', slotsY);
        rect.setAttribute('width', w); rect.setAttribute('height', 48);
        rect.setAttribute('class', 'pocket');
        plinkoSvg.appendChild(rect);
        const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t2.setAttribute('x', x); t2.setAttribute('y', slotsY + 32);
        t2.setAttribute('text-anchor', 'middle');
        t2.setAttribute('class', 'payoutLabel');
        const prize = plinkoConfig.payouts?.[s] || {value: 0};
        t2.textContent = `£${(prize.value || 0).toFixed(2)}`;
        t2.setAttribute('data-slot-payout', String(s));
        plinkoSvg.appendChild(t2);
    }
}

async function handlePlinkoDrop(numDrops = 1) {
    if (userPlinkoTokens.length < numDrops || plinkoActiveBalls >= MAX_PLINKO_BALLS) return;
    
    plinkoActiveBalls += numDrops;
    updateUI();

    const playPlinkoFunc = httpsCallable(functions, 'playPlinko');

    for (let i = 0; i < numDrops; i++) {
        if (userPlinkoTokens.length === 0) break;
        const tokenToSpend = userPlinkoTokens.shift();

        try {
            // Stagger the drops for a better visual effect
            if (i > 0) await new Promise(res => setTimeout(res, 150));
            
            const result = await playPlinkoFunc({ tokenId: tokenToSpend.tokenId });
            const { prize, path } = result.data;
            animatePlinkoDrop(path, prize); // Don't await this so drops can overlap
        } catch (error) {
            console.error("Error playing Plinko:", error);
            alert(`Plinko Error: ${error.message}`);
            userPlinkoTokens.unshift(tokenToSpend); // Return token on error
        } finally {
            if (i === numDrops - 1) { // Only update UI after the final call
                 setTimeout(() => {
                    plinkoActiveBalls -= numDrops;
                    updateUI();
                }, (plinkoConfig.gravity || 1.0) * 2000); // Wait for animation to settle
            }
        }
    }
}


async function animatePlinkoDrop(path, prize) {
    const PLINKO_ROWS = plinkoConfig.rows || 12;
    const gravity = plinkoConfig.gravity || 1.0;
    const W = 800, margin = 60, rowGap = 58;
    const usableWidth = W - margin * 2;
    const colGap = usableWidth / (PLINKO_ROWS + 1);

    let k = 0, x = plinkoOffsets[0], y = margin + 8;
    const ball = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ball.setAttribute('cx', x); ball.setAttribute('cy', y); ball.setAttribute('r', 10);
    ball.setAttribute('fill', 'var(--primary-gold)');
    ball.style.filter = 'drop-shadow(0 4px 10px rgba(224,169,74,.35))';
    plinkoSvg.appendChild(ball);

    const tween = (toX, toY, ms) => new Promise(resolve => {
        ms = ms * gravity;
        const x0 = x, y0 = y, dx = toX - x0, dy = toY - y0; let t0 = null;
        const step = t => {
            if (!t0) t0 = t; const p = Math.min(1, (t - t0) / ms); const ease = p < .5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
            ball.setAttribute('cx', x0 + dx * ease); ball.setAttribute('cy', y0 + dy * ease);
            if (p < 1) requestAnimationFrame(step); else { x = toX; y = toY; resolve(); }
        };
        requestAnimationFrame(step);
    });

    for (let r = 0; r < PLINKO_ROWS; r++) {
        await tween(plinkoOffsets[r] + k * colGap, margin + rowGap * (r + 1), 140);
        const stepRight = path.steps[r] === 1;
        const nextOffset = plinkoOffsets[r + 1] || (margin + (usableWidth - (r + 1) * colGap) / 2 + margin);
        await tween(nextOffset + (k + (stepRight ? 0.5 : -0.5)) * colGap, margin + rowGap * (r + 1) + rowGap * 0.45, 110);
        if (stepRight) k++;
    }

    const slot = plinkoSlots[k];
    await tween(slot.x, margin + rowGap * (PLINKO_ROWS + 1) + 34, 240);
    
    if (prize.value > 0) {
        showWinCelebrationModal(prize.type, prize.value, 'plinko');
    }

    await new Promise(res => setTimeout(res, 420 * gravity));
    plinkoSvg.removeChild(ball);
}

plinkoDrop1Btn.addEventListener('click', () => handlePlinkoDrop(1));
plinkoDrop3Btn.addEventListener('click', () => handlePlinkoDrop(3));
plinkoBoard.addEventListener('click', () => handlePlinkoDrop(1));
*/


// --- Shared Modal & Accordion Logic ---
function renderTokenAccordion() {
    tokenAccordionContainer.innerHTML = '';
    const userPlinkoTokens = [];
    const allTokens = [
        ...userTokens.map(t => ({...t, type: 'Spinner'})),
        ...userPlinkoTokens.map(t => ({...t, type: 'Plinko'}))
    ].sort((a,b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000));
    
    if (allTokens.length === 0) {
        tokenAccordionContainer.append(createElement('div', { class: 'placeholder', textContent: 'You have no game tokens. Enter a competition to earn them!' }));
        return;
    }
    const groupedTokens = allTokens.reduce((acc, token) => {
        const groupTitle = token.compTitle || "Purchased Tokens";
        (acc[groupTitle] = acc[groupTitle] || []).push(token);
        return acc;
    }, {});
    const fragment = document.createDocumentFragment();
    for (const groupTitle in groupedTokens) {
        const tokens = groupedTokens[groupTitle];
        const date = new Date(tokens[0].earnedAt.seconds * 1000).toLocaleDateString();
        const content = createElement('div', { class: 'accordion-content' }, [
            createElement('ul', {}, tokens.map(t => createElement('li', { textContent: `${t.type} Token ID: ...${t.tokenId.slice(-8)}` })))
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

async function openPurchaseModal(tokenType) {
    const modalBody = document.getElementById('purchase-modal-body');
    modalBody.innerHTML = '';
    modalBody.append(createElement('h2', { textContent: `Get More Spins` }), createElement('p', { class: 'placeholder', textContent: 'Finding assigned competition...' }));
    purchaseModal.classList.add('show');

    try {
        const assignmentsRef = doc(db, 'admin_settings', 'game_assignments');
        const assignmentsSnap = await getDoc(assignmentsRef);
        if (!assignmentsSnap.exists()) throw new Error('Game assignments not configured by admin.');
        
        const assignments = assignmentsSnap.data();
        const compId = assignments.spinnerCompId;
        if (!compId) throw new Error(`No token competition has been assigned to the spinner game.`);

        const compRef = doc(db, 'competitions', compId);
        const compSnap = await getDoc(compRef);
        if (!compSnap.exists() || compSnap.data().status !== 'live') {
            throw new Error('The assigned token competition is not currently active.');
        }

        activeTokenCompetition = { id: compSnap.id, ...compSnap.data() };
        
        const answers = Object.entries(activeTokenCompetition.skillQuestion.answers)
            .map(([key, value]) => createElement('button', { type: 'button', class: 'answer-btn', 'data-answer': key, textContent: value }));

        const bundlesHTML = activeTokenCompetition.ticketTiers.map(b => 
            createElement('button', { type: 'button', class: 'ticket-option', 'data-amount': b.amount, 'data-price': b.price, textContent: `${b.amount} Entries for £${b.price.toFixed(2)}` })
        );
        
        modalBody.innerHTML = '';
        const form = createElement('form', { id: 'token-entry-form', class: 'modal-form' }, [
            createElement('h2', { textContent: activeTokenCompetition.title }),
            createElement('p', {}, [`Enter our weekly draw for a chance to win `, createElement('strong', { textContent: `£${activeTokenCompetition.cashAlternative} Cash` }), ` and get bonus tokens instantly!`]),
            createElement('div', { class: 'skill-question-box' }, [
                createElement('p', { class: 'question-text', textContent: activeTokenCompetition.skillQuestion.text }),
                createElement('div', { class: 'answer-options' }, answers)
            ]),
            createElement('div', { class: 'ticket-selector-box' }, [
                 createElement('div', { class: 'ticket-options' }, bundlesHTML)
            ]),
            createElement('div', { id: 'credit-payment-option', style: { display: 'none', marginTop: '1rem' } }),
            createElement('div', { class: 'modal-actions' }, [
                createElement('button', { type: 'button', class: ['btn', 'btn-secondary'], 'data-close-modal': true }, ['Cancel']),
                createElement('button', { type: 'submit', class: 'btn' }, ['Confirm & Pay'])
            ])
        ]);
        
        modalBody.append(form);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            handleTokenCompEntry(form, tokenType, 'card');
        });

    } catch (error) {
        console.error(error);
        modalBody.innerHTML = '';
        modalBody.append(
            createElement('h2', { textContent: 'Error' }),
            createElement('p', { textContent: error.message }),
             createElement('div', {class: 'modal-actions'}, [
                createElement('button', { class: 'btn', 'data-close-modal': true }, ['Close'])
            ])
        );
    }
}

buySpinnerBtn.addEventListener('click', () => openPurchaseModal('spinner'));
// buyPlinkoBtn.addEventListener('click', () => openPurchaseModal('plinko'));
// buyPlinkoBtn2.addEventListener('click', () => openPurchaseModal('plinko'));

async function handleTokenCompEntry(form, tokenType, paymentMethod = 'card') {
    const selectedAnswer = form.querySelector('.answer-btn.selected');
    const selectedBundle = form.querySelector('.ticket-option.selected');

    if (!activeTokenCompetition) { alert('Error: No active competition selected.'); return; }
    if (!selectedAnswer) { alert('Please answer the question.'); return; }
    if (selectedAnswer.dataset.answer !== activeTokenCompetition.skillQuestion.correctAnswer) { alert('Incorrect answer. Please try again.'); return; }
    if (!selectedBundle) { alert('Please select a bundle.'); return; }

    const submitBtn = form.querySelector('button[type="submit"]');
    const creditBtn = form.querySelector('#pay-with-credit-btn');
    if(submitBtn) submitBtn.disabled = true;
    if(creditBtn) creditBtn.disabled = true;
    
    const targetBtn = paymentMethod === 'credit' ? creditBtn : submitBtn;
    const originalText = targetBtn ? targetBtn.textContent : '';
    if(targetBtn) targetBtn.textContent = 'Processing...';

    try {
        const allocateTicketsAndAwardTokens = httpsCallable(functions, 'allocateTicketsAndAwardTokens');
        await allocateTicketsAndAwardTokens({
            compId: activeTokenCompetition.id,
            ticketsBought: parseInt(selectedBundle.dataset.amount),
            expectedPrice: parseFloat(selectedBundle.dataset.price),
            paymentMethod: paymentMethod,
            tokenType: tokenType
        });
        purchaseModal.classList.remove('show');
    } catch (error) {
        console.error("Token comp entry failed:", error);
        alert(`Entry failed: ${error.message}`);
    } finally {
        if(submitBtn) submitBtn.disabled = false;
        if(creditBtn) creditBtn.disabled = false;
        if(targetBtn) targetBtn.textContent = originalText;
    }
}

document.getElementById('purchase-modal').addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;

    if (target.matches('[data-close-modal]')) {
        target.closest('.modal-container').classList.remove('show');
        return;
    }

    const form = target.closest('form');
    if (!form) return;
    
    const currentTokenType = 'spinner';

    if (target.classList.contains('answer-btn')) {
        form.querySelectorAll('.answer-btn').forEach(btn => btn.classList.remove('selected'));
        target.classList.add('selected');
    }
    if (target.classList.contains('ticket-option')) {
        const price = parseFloat(target.dataset.price);
        form.querySelectorAll('.ticket-option').forEach(opt => opt.classList.remove('selected'));
        target.classList.add('selected');

        const creditOptionDiv = form.querySelector('#credit-payment-option');
        creditOptionDiv.innerHTML = '';
        if (userCreditBalance >= price) {
            const creditButton = createElement('button', { type: 'button', id: 'pay-with-credit-btn', class: ['btn', 'btn-credit'], textContent: `Pay with £${price.toFixed(2)} Credit` });
            creditButton.onclick = () => {
                 handleTokenCompEntry(target.closest('form'), currentTokenType, 'credit');
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
    const modal = e.target.closest('.modal-container');
    if (modal && e.target === modal) {
        modal.classList.remove('show');
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
