import { getAuth } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, runTransaction, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js';

const db = getFirestore(app);
const auth = getAuth();

let currentCompetitionData = null;
let competitionId = null;

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    competitionId = params.get('id');
    if (competitionId) {
        loadCompetitionDetails(competitionId);
    } else {
        document.getElementById('competition-container').innerHTML = '<div class="hawk-card placeholder">Error: No competition specified.</div>';
    }
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
    }
}

function createCompetitionHTML(data) {
    const answersHTML = Object.entries(data.skillQuestion.answers)
        .map(([key, value]) => `<button class="answer-btn" data-answer="${key}">${value}</button>`).join('');

    const ticketTiersHTML = data.ticketTiers.map(tier => 
        `<button class="ticket-option" data-amount="${tier.amount}" data-price="${tier.price}">${tier.amount} Entries for £${tier.price.toFixed(2)}</button>`
    ).join('');
    
    const progressPercent = (data.ticketsSold / data.totalTickets) * 100;

    return `
        <div class="competition-detail-view">
            <div class="prize-image-panel">
                <img src="${data.prizeImage}" alt="${data.title}">
            </div>
            <div class="entry-details-panel">
                <h1>${data.title}</h1>
                <p class="cash-alternative">Or <span>£${(data.cashAlternative || 0).toLocaleString()}</span> Cash Alternative</p>
                
                <div class="detail-section detail-timer-section">
                    <div id="timer" class="detail-timer"></div>
                </div>

                <div class="detail-section detail-progress">
                    <div class="progress-bar">
                        <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
                    </div>
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
            document.getElementById('entry-button').disabled = true;
            return;
        }
        const d = String(Math.floor(distance / (1000*60*60*24))).padStart(2,'0');
        const h = String(Math.floor((distance % (1000*60*60*24))/(1000*60*60))).padStart(2,'0');
        const m = String(Math.floor((distance % (1000*60*60))/(1000*60))).padStart(2,'0');
        timerElement.innerHTML = `${d}<small>d</small> : ${h}<small>h</small> : ${m}<small>m</small>`;
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
        if (!auth.currentUser) {
            alert("Please log in to enter.");
            window.location.href = 'login.html';
            return;
        }
        if (!isAnswerCorrect) {
            alert("You must select the correct answer to enter.");
            return;
        }
        showConfirmationModal();
    });
}

function showConfirmationModal() {
    const selectedTicket = document.querySelector('.ticket-option.selected');
    const tickets = parseInt(selectedTicket.dataset.amount);
    const price = parseFloat(selectedTicket.dataset.price).toFixed(2);
    
    openModal(`
        <h2>Confirm Your Entry</h2>
        <p>You are about to purchase <strong>${tickets}</strong> entries for <strong>£${price}</strong>.</p>
        <div class="modal-actions">
            <button id="cancel-entry-btn" class="btn">Cancel</button>
            <button id="confirm-entry-btn" class="btn">Confirm & Pay</button>
        </div>
    `);
    
    document.getElementById('confirm-entry-btn').addEventListener('click', () => handleEntry(tickets));
    document.getElementById('cancel-entry-btn').addEventListener('click', closeModal);
}

async function handleEntry(ticketsBought) {
    const user = auth.currentUser;
    if (!user) return;

    openModal(`<h2>Processing...</h2><p>Please wait.</p>`);

    const competitionRef = doc(db, 'competitions', competitionId);
    const userRef = doc(db, 'users', user.uid);

    try {
        await runTransaction(db, async (transaction) => {
            const compDoc = await transaction.get(competitionRef);
            const userDoc = await transaction.get(userRef);

            if (!compDoc.exists()) throw new Error("Competition not found.");
            if (!userDoc.exists()) throw new Error("User not found.");

            const compData = compDoc.data();
            const userData = userDoc.data();
            
            if (compData.status !== 'live') throw new Error("This competition is no longer live.");
            
            // --- COMPLIANCE: PER-USER ENTRY LIMIT CHECK ---
            const userEntryCount = userData.entryCount?.[competitionId] || 0;
            const limit = compData.userEntryLimit || 75;
            if (userEntryCount + ticketsBought > limit) {
                throw new Error(`Entry limit exceeded. You have ${limit - userEntryCount} entries remaining.`);
            }

            // --- TICKET AVAILABILITY CHECK ---
            const newTicketsSold = (compData.ticketsSold || 0) + ticketsBought;
            if (newTicketsSold > compData.totalTickets) {
                throw new Error("Not enough tickets available for this purchase.");
            }

            // All checks passed, perform updates
            transaction.update(competitionRef, { ticketsSold: newTicketsSold });
            
            const newEntryCount = userEntryCount + ticketsBought;
            transaction.update(userRef, {
                [`entryCount.${competitionId}`]: newEntryCount
            });

            // Log the entry in the subcollection for drawing purposes
            transaction.set(doc(collection(competitionRef, 'entries')), {
                userId: user.uid,
                userDisplayName: user.displayName,
                ticketsBought: ticketsBought,
                enteredAt: serverTimestamp(),
                entryType: 'paid'
            });
        });

        openModal(`<h2>Entry Successful!</h2><p>Thank you for entering. Good luck!</p>`);
        setTimeout(() => window.location.reload(), 2000);

    } catch (error) {
        console.error("Entry Transaction failed: ", error);
        openModal(`<h2>Error</h2><p>${error.message}</p><button id="close-error-btn" class="btn">Close</button>`);
        document.getElementById('close-error-btn')?.addEventListener('click', closeModal);
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
    if(modalContainer) modalContainer.classList.remove('show');
}
