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

// --- DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    competitionId = params.get('id');
    if (competitionId) {
        loadCompetitionDetails(competitionId);
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
            openModal('modal-container', `<h2>Login Required</h2><p>Please log in or register to enter.</p><a href="login.html" class="btn">Login</a>`);
            return;
        }
        if (!isAnswerCorrect) {
            openModal('modal-container', `<h2>Incorrect Answer</h2><p>You must select the correct answer to enter.</p><button data-close-modal class="btn">Try Again</button>`);
            return;
        }
        
        // This function now handles ALL entry types
        showConfirmationModal();
    });
}


// --- Universal Entry Flow ---

function showConfirmationModal() {
    const selectedTicket = document.querySelector('.ticket-option.selected');
    if (!selectedTicket) {
        openModal('modal-container', `<h2>Select Tickets</h2><p>Please choose a ticket bundle.</p><button data-close-modal class="btn">OK</button>`);
        return;
    }
    const tickets = parseInt(selectedTicket.dataset.amount);
    const price = parseFloat(selectedTicket.dataset.price).toFixed(2);
    
    openModal('modal-container', `
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
    openModal('modal-container', `<h2>Processing Entry...</h2><p>Please wait.</p>`);
    try {
        // We now call our new, universal 'allocateTicketsAndAwardTokens' function
        const allocateTicketsAndAwardTokens = httpsCallable(functions, 'allocateTicketsAndAwardTokens');
        const result = await allocateTicketsAndAwardTokens({ compId: competitionId, ticketsBought });
        const data = result.data;
        
        let successMessage = `<p>Your tickets #${data.ticketStart} to #${data.ticketStart + data.ticketsBought - 1} are registered. Good luck!</p>`;
        
        // Check if tokens were awarded and add a special message and call-to-action
        if (data.awardedTokens && data.awardedTokens.length > 0) {
            const tokenCount = data.awardedTokens.length;
            successMessage += `
                <div class="token-award-banner">
                    <h3>You've earned ${tokenCount} Spin Token${tokenCount > 1 ? 's' : ''}!</h3>
                    <p>Visit the Instant Win Games page to spend them for a chance to win now!</p>
                    <a href="instant-games.html" class="btn">Spend Tokens</a>
                </div>
            `;
        }

        openModal('modal-container', `
            <h2>Entry Successful!</h2>
            ${successMessage}
            <button data-close-modal class="btn btn-secondary" onclick="window.location.reload()">Done</button>
        `);
    } catch (error) {
        console.error("Entry failed:", error);
        openModal('modal-container', `<h2>Error</h2><p>${error.message}</p><button data-close-modal class="btn">Close</button>`);
    }
}


// --- UTILITY FUNCTIONS (Modal, Countdown, HTML) ---
// (These are unchanged, but included for completeness)

function openModal(modalId, content) {
    let modal, modalContent;
    modal = document.getElementById(modalId);
    if (!modal) return;
    
    modalContent = modal.querySelector('.modal-content');
    if (content) modalContent.innerHTML = content;
    
    modal.classList.add('show');
}

function closeModal(modalId) {
    const modalToClose = modalId ? document.getElementById(modalId) : document.querySelector('.modal-container.show');
    if (modalToClose) modalToClose.classList.remove('show');
}

// Universal listener to close modals
document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close-modal]')) {
        closeModal();
    }
    // Also close if the modal overlay background is clicked
    if (e.target.matches('.modal-container.show')) {
        closeModal();
    }
});


function createCompetitionHTML(data) {
    const answersHTML = Object.entries(data.skillQuestion.answers).map(([key, value]) => `<button class="answer-btn" data-answer="${key}">${value}</button>`).join('');
    const ticketTiersHTML = data.ticketTiers.map(tier => `<button class="ticket-option" data-amount="${tier.amount}" data-price="${tier.price}">${tier.amount} Entries for £${tier.price.toFixed(2)}</button>`).join('');
    const progressPercent = (data.ticketsSold / data.totalTickets) * 100;
    return `
        <div class="competition-detail-view">
            <div class="prize-image-panel"><img src="${data.prizeImage}" alt="${data.title}"></div>
            <div class="entry-details-panel">
                <h1>${data.title}</h1>
                <p class="cash-alternative">Or <span>£${(data.cashAlternative || 0).toLocaleString()}</span> Cash Alternative</p>
                <div class="detail-section detail-timer-section"><div id="timer" class="detail-timer"></div></div>
                <div class="detail-section detail-progress">
                    <div class="progress-bar"><div class="progress-bar-fill" style="width: ${progressPercent}%;"></div></div>
                    <p><strong>${data.ticketsSold || 0}</strong> / ${data.totalTickets} sold</p>
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
        const d = String(Math.floor(distance / (1000 * 60 * 60 * 24))).padStart(2, '0');
        const h = String(Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
        const m = String(Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
        const s = String(Math.floor((distance % (1000 * 60)) / 1000)).padStart(2, '0');
        timerElement.innerHTML = `${d}<small>d</small> : ${h}<small>h</small> : ${m}<small>m</small> : ${s}<small>s</small>`;
    }, 1000);
}
