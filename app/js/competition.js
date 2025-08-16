import { getAuth } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

// --- Singletons ---
const db = getFirestore(app);
const auth = getAuth(app);
const functions = getFunctions(app);

// --- Module State ---
let currentCompetitionData = null;
let competitionId = null;
let spinnerPrizes = []; // For the instant win modal wheel

// --- DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    competitionId = params.get('id');
    if (competitionId) {
        loadCompetitionDetails(competitionId);
        loadPrizeSettings(); // Load prize settings for the modal wheel
    } else {
        document.getElementById('competition-container').innerHTML = '<div class="hawk-card placeholder">Error: No competition specified.</div>';
    }
});

// --- Core Functions ---
async function loadCompetitionDetails(id) {
    const container = document.getElementById('competition-container');
    const competitionRef = doc(db, 'competitions', id);
    try {
        const docSnap = await getDoc(competitionRef);
        if (docSnap.exists()) {
            currentCompetitionData = docSnap.data();
            document.title = `${currentCompetitionData.title} | The Hawk Games`;
            container.innerHTML = createCompetitionHTML(currentCompetitionData);
            setupCountdown(currentCompetitionData.endDate.toDate());
            setupEntryLogic(currentCompetitionData.skillQuestion.correctAnswer);
        } else {
            container.innerHTML = '<div class="hawk-card placeholder">Error: Competition not found.</div>';
        }
    } catch (error) {
        console.error("Error fetching competition details:", error);
        container.innerHTML = '<div class="hawk-card placeholder" style="color:red">Could not load competition details.</div>';
    }
}

async function loadPrizeSettings() {
    try {
        const settingsRef = doc(db, 'admin_settings', 'spinnerPrizes');
        const docSnap = await getDoc(settingsRef);
        if (docSnap.exists() && docSnap.data().prizes) {
            spinnerPrizes = docSnap.data().prizes;
        }
    } catch (error) {
        console.error("Error fetching spinner prizes for modal:", error);
    }
}


function setupEntryLogic(correctAnswer) {
    const entryButton = document.getElementById('entry-button');
    let isAnswerCorrect = false;

    document.querySelector('.answer-options').addEventListener('click', (e) => {
        const button = e.target.closest('.answer-btn');
        if (!button) return;
        document.querySelectorAll('.answer-options .answer-btn').forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        isAnswerCorrect = button.dataset.answer === correctAnswer;
    });

    document.querySelector('.ticket-options').addEventListener('click', (e) => {
        const option = e.target.closest('.ticket-option');
        if (!option) return;
        document.querySelectorAll('.ticket-options .ticket-option').forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        entryButton.disabled = false;
        entryButton.textContent = "Confirm Entry";
    });

    entryButton.addEventListener('click', () => {
        if (!auth.currentUser) {
            openModal(`<h2>Login Required</h2><p>Please log in or register to enter.</p><a href="login.html" class="btn">Login</a>`);
            return;
        }
        if (!isAnswerCorrect) {
            openModal(`<h2>Incorrect Answer</h2><p>You must select the correct answer to enter.</p><button data-close-modal class="btn">Try Again</button>`);
            return;
        }
        showConfirmationModal();
    });
}

function showConfirmationModal() {
    const selectedTicket = document.querySelector('.ticket-option.selected');
    if (!selectedTicket) {
        openModal(`<h2>Select Tickets</h2><p>Please choose a ticket bundle.</p><button data-close-modal class="btn">OK</button>`);
        return;
    }
    const tickets = parseInt(selectedTicket.dataset.amount);
    const price = parseFloat(selectedTicket.dataset.price).toFixed(2);
    
    openModal(`
        <h2>Confirm Your Entry</h2>
        <p>You are about to purchase <strong>${tickets}</strong> entries for <strong>£${price}</strong>.</p>
        <div class="modal-actions">
            <button data-close-modal class="btn btn-secondary">Cancel</button>
            <button id="confirm-entry-btn" class="btn">Confirm & Pay</button>
        </div>
    `);
    
    const confirmBtn = document.getElementById('confirm-entry-btn');
    confirmBtn.addEventListener('click', () => handleEntry(tickets), { once: true });
}

async function handleEntry(ticketsBought) {
    openModal(`<h2>Processing Entry...</h2><div class="loader"></div><p>Please wait, do not close this window.</p>`);
    try {
        const allocateTicketsAndAwardTokens = httpsCallable(functions, 'allocateTicketsAndAwardTokens');
        const result = await allocateTicketsAndAwardTokens({ compId: competitionId, ticketsBought });
        const data = result.data;
        
        if (data.awardedTokens && data.awardedTokens.length > 0) {
            // If tokens are awarded, trigger the spin wheel modal
            showInstantWinModal(data.awardedTokens.length);
        } else {
            // Otherwise, show the celebratory success modal
            let successMessage = `<p>Your tickets #${data.ticketStart} to #${data.ticketStart + data.ticketsBought - 1} have been successfully registered. Good luck in the draw!</p>`;
            openModal(`
                <div class="celebration-modal">
                    <div class="modal-icon-success">✓</div>
                    <h2>Entry Successful!</h2>
                    ${successMessage}
                    <button data-close-modal class="btn" style="margin-top:1rem;" onclick="window.location.reload()">Done</button>
                </div>
            `);
        }
    } catch (error) {
        console.error("Entry failed:", error);
        openModal(`<h2>Error</h2><p>${error.message}</p><button data-close-modal class="btn">Close</button>`);
    }
}


// --- UTILITY & MODAL FUNCTIONS ---
function openModal(content) {
    const modal = document.getElementById('modal-container');
    const modalContent = document.getElementById('modal-content');
    if (!modal || !modalContent) return;
    modalContent.innerHTML = content;
    modal.classList.add('show');
}

function closeModal() {
    const modal = document.querySelector('.modal-container.show');
    if (modal) modal.classList.remove('show');
}

document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close-modal]')) {
        closeModal();
    }
});

function createCompetitionHTML(data) {
    const answersHTML = Object.entries(data.skillQuestion.answers).map(([key, value]) => `<button class="answer-btn" data-answer="${key}">${value}</button>`).join('');
    const ticketTiersHTML = data.ticketTiers.map(tier => `<button class="ticket-option" data-amount="${tier.amount}" data-price="${tier.price}">${tier.amount} Entr${tier.amount > 1 ? 'ies' : 'y'} for £${tier.price.toFixed(2)}</button>`).join('');
    const progressPercent = (data.ticketsSold / data.totalTickets) * 100;
    
    return `
        <div class="competition-detail-view">
            <div class="prize-image-panel"><img src="${data.prizeImage}" alt="${data.title}"></div>
            <div class="entry-details-panel">
                <h1>${data.title}</h1>
                <p class="cash-alternative">Or <span>£${(data.cashAlternative || 0).toLocaleString()}</span> Cash Alternative</p>
                <div id="timer" class="detail-timer"></div>
                <div class="detail-progress">
                    <div class="progress-bar"><div class="progress-bar-fill" style="width: ${progressPercent}%;"></div></div>
                    <p>${data.ticketsSold || 0} / ${data.totalTickets} sold</p>
                </div>
                <div class="detail-section skill-question-box">
                    <h3><span>1.</span> Answer The Question</h3>
                    <p class="question-text">${data.skillQuestion.text}</p>
                    <div class="answer-options">${answersHTML}</div>
                </div>
                <div class="detail-section ticket-selector-box">
                    <h3><span>2.</span> Choose Your Tickets</h3>
                    <div class="ticket-options">${ticketTiersHTML}</div>
                </div>
                <button id="entry-button" class="btn" disabled>Select Answer & Tickets</button>
            </div>
        </div>
    `;
}

function setupCountdown(endDate) {
    const timerElement = document.getElementById('timer');
    if (!timerElement) return;
    const interval = setInterval(() => {
        const distance = endDate.getTime() - new Date().getTime();
        if (distance < 0) {
            clearInterval(interval);
            timerElement.innerHTML = "COMPETITION CLOSED";
            document.querySelectorAll('#entry-button, .answer-btn, .ticket-option').forEach(el => el.disabled = true);
            return;
        }
        const d = String(Math.floor(distance / (1000 * 60 * 60 * 24)));
        const h = String(Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
        const m = String(Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
        const s = String(Math.floor((distance % (1000 * 60)) / 1000)).padStart(2, '0');
        timerElement.innerHTML = `${d}<small>d</small> : ${h}<small>h</small> : ${m}<small>m</small> : ${s}<small>s</small>`;
    }, 1000);
}

// --- INSTANT WIN MODAL LOGIC ---
function showInstantWinModal(tokenCount) {
    const modal = document.getElementById('instant-win-modal');
    if (!modal) return;

    document.getElementById('spin-modal-title').textContent = `You've Unlocked ${tokenCount} Instant Win Spin${tokenCount > 1 ? 's' : ''}!`;
    
    // Reset state
    const spinButton = document.getElementById('spin-button');
    spinButton.disabled = false;
    spinButton.textContent = "SPIN THE WHEEL";
    document.getElementById('spin-result').innerHTML = '';

    modal.classList.add('show');
    
    // Only set up the wheel and button once
    if (!modal.dataset.initialized) {
        setupSpinWheel();
        document.getElementById('spin-button').addEventListener('click', handleSpinButtonClick);
        modal.dataset.initialized = 'true';
    }
}

function setupSpinWheel() {
    const wheel = document.getElementById('wheel');
    const segmentCount = 12; // Based on the visual design of the wheel
    wheel.innerHTML = ''; // Clear previous segments
    for (let i = 0; i < segmentCount; i++) {
        const segment = document.createElement('div');
        segment.className = 'wheel-segment';
        // You can add prize text here if desired, but the background image handles it
        wheel.appendChild(segment);
    }
}

async function handleSpinButtonClick() {
    const spinButton = document.getElementById('spin-button');
    const spinResultContainer = document.getElementById('spin-result');
    const wheel = document.getElementById('wheel');

    // Fetch the latest user tokens from Firestore to prevent double-spending
    const userDocRef = doc(db, 'users', auth.currentUser.uid);
    const userDocSnap = await getDoc(userDocRef);
    const userTokens = userDocSnap.data().spinTokens || [];

    if (userTokens.length === 0 || spinButton.disabled) return;

    spinButton.disabled = true;
    spinButton.textContent = 'SPINNING...';
    spinResultContainer.innerHTML = '';
    
    const tokenToSpend = userTokens.sort((a, b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000))[0];
    const spendTokenFunc = httpsCallable(functions, 'spendSpinToken');

    try {
        const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
        // The rest of the logic for spinning the wheel would go here, similar to instant-games.js
        // For now, we'll just show the result and provide a link.
        
        const { won, prizeType, value } = result.data;
        if (won) {
            const prizeValue = (typeof value === 'number') ? value.toFixed(2) : '0.00';
            const prizeText = prizeType === 'credit' ? `£${prizeValue} STORE CREDIT` : `£${prizeValue} CASH`;
            spinResultContainer.innerHTML = `<p class="spin-win">🎉 YOU WON ${prizeText}! 🎉</p>`;
        } else {
            spinResultContainer.innerHTML = `<p>Better luck next time!</p>`;
        }
        
    } catch (error) {
        console.error("Error spending token:", error);
        spinResultContainer.innerHTML = `<p class="spin-error">Error: ${error.message}</p>`;
    } finally {
        // After the spin, offer to go to the main games page or close
        spinButton.textContent = 'GO TO INSTANT GAMES';
        spinButton.onclick = () => window.location.href = 'instant-games.html';
        spinButton.disabled = false;
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn btn-secondary';
        closeBtn.textContent = 'Close';
        closeBtn.style.marginTop = '1rem';
        closeBtn.onclick = () => {
            document.getElementById('instant-win-modal').classList.remove('show');
            window.location.reload();
        };
        spinResultContainer.appendChild(closeBtn);
    }
}
