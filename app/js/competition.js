import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

const db = getFirestore(app);
const auth = getAuth(app);

let currentCompetitionData = null;
let competitionId = null;
let currentUser = null;

// Listen for auth state changes to keep our currentUser variable up to date
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
    } else {
        currentUser = null;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    competitionId = params.get('id');
    if (competitionId) {
        loadCompetitionDetails(competitionId);
    } else {
        document.getElementById('competition-container').innerHTML = '<div class="hawk-card placeholder">Error: No competition specified.</div>';
    }
    document.getElementById('modal-container').addEventListener('click', (e) => {
        if (e.target.id === 'modal-container' || e.target.closest('[data-close-modal]')) {
            closeModal();
        }
    });
});

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
        if (!currentUser) {
            openModal(`<h2>Login Required</h2><p>Please log in or register to enter the competition.</p><a href="login.html" class="btn">Login</a>`);
            return;
        }
        if (!isAnswerCorrect) {
            openModal(`<h2>Incorrect Answer</h2><p>You must select the correct answer to be eligible to enter.</p><button data-close-modal class="btn">Try Again</button>`);
            return;
        }
        showConfirmationModal();
    });
}

function showConfirmationModal() {
    const selectedTicket = document.querySelector('.ticket-option.selected');
    if (!selectedTicket) {
        openModal(`<h2>Select Tickets</h2><p>Please choose a ticket bundle before confirming.</p><button data-close-modal class="btn">OK</button>`);
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
    if (!currentUser) {
        openModal(`<h2>Error</h2><p>You seem to have been logged out. Please refresh and log in again.</p><button data-close-modal class="btn">Close</button>`);
        return;
    }

    openModal(`<h2>Processing Entry...</h2><p>Please wait, do not close this window.</p>`);
    
    try {
        // This forces the SDK to get a fresh, valid auth token before proceeding.
        // This can solve race conditions on page load.
        await currentUser.getIdToken(true); 

        const functions = getFunctions(app);
        const allocateTicketsAndCheckWins = httpsCallable(functions, 'allocateTicketsAndCheckWins');

        const result = await allocateTicketsAndCheckWins({
            compId: competitionId,
            ticketsBought: ticketsBought,
        });

        const data = result.data;
        if (data.wonPrizes && data.wonPrizes.length > 0) {
            const totalWinnings = data.wonPrizes.reduce((sum, prize) => sum + prize.prizeValue, 0);
            openModal(`
                <div class="modal-icon-win">⚡️</div>
                <h2>INSTANT WIN!</h2>
                <p>Congratulations! You've just won <strong>£${totalWinnings.toFixed(2)}</strong> instantly!</p>
                <p class="small-text">Your tickets #${data.ticketStart} to #${data.ticketStart + data.ticketsBought - 1} are still in the main draw!</p>
                <button id="reload-btn" class="btn">Awesome!</button>
            `);
        } else {
            openModal(`
                <h2>Entry Successful!</h2>
                <p>Thank you for entering. Your ticket numbers are ${data.ticketStart} to ${data.ticketStart + data.ticketsBought - 1}. Good luck!</p>
                <button id="reload-btn" class="btn">Done</button>
            `);
        }
        document.getElementById('reload-btn')?.addEventListener('click', () => window.location.reload());

    } catch (error) {
        console.error("Entry failed:", error);
        openModal(`<h2>Error</h2><p>${error.message}</p><button data-close-modal class="btn">Close</button>`);
    }
}

function openModal(content) {
    const modalContent = document.getElementById('modal-content');
    const modalContainer = document.getElementById('modal-container');
    if (!modalContent || !modalContainer) return;
    modalContent.innerHTML = content;
    modalContainer.classList.add('show');
}

function closeModal() {
    const modalContainer = document.getElementById('modal-container');
    if (modalContainer) modalContainer.classList.remove('show');
}
