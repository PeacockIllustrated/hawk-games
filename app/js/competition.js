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
        
        // This is the new branching logic for the "Spin the Wheel" experience
        const isInstantWinComp = currentCompetitionData?.instantWinsConfig?.enabled;
        if (isInstantWinComp) {
            handleInstantWinEntry();
        } else {
            showStandardConfirmationModal();
        }
    });
}


// --- NEW: Instant Win Wheel Logic ---

function handleInstantWinEntry() {
    const selectedTicket = document.querySelector('.ticket-option.selected');
    if (!selectedTicket) {
        openModal('modal-container', `<h2>Select Tickets</h2><p>Please choose a ticket bundle.</p><button data-close-modal class="btn">OK</button>`);
        return;
    }
    const ticketsBought = parseInt(selectedTicket.dataset.amount);

    // 1. Build the wheel dynamically from competition data
    const prizes = currentCompetitionData.instantWinsConfig.prizes || [];
    const wheel = document.getElementById('wheel');
    
    // Create a list of all individual prizes
    const allPrizeValues = [];
    prizes.forEach(tier => {
        for (let i = 0; i < tier.count; i++) {
            allPrizeValues.push(tier.value);
        }
    });

    // For a better user experience, we ensure there are always some "No Win" slices.
    const numberOfSlices = Math.max(12, allPrizeValues.length * 2);
    const noWinSlices = numberOfSlices - allPrizeValues.length;

    let wheelSlices = [...allPrizeValues];
    for(let i = 0; i < noWinSlices; i++) {
        wheelSlices.push(0); // 0 represents "No Win"
    }

    // Shuffle the slices so prize positions are random on the wheel
    wheelSlices.sort(() => Math.random() - 0.5);

    // Generate the CSS and HTML for the wheel
    const sliceAngle = 360 / numberOfSlices;
    let gradientParts = [];
    let htmlSegments = '';
    const colors = ['#333', '#444']; // Alternating background colors for slices

    wheelSlices.forEach((prizeValue, i) => {
        const startAngle = i * sliceAngle;
        const endAngle = (i + 1) * sliceAngle;
        gradientParts.push(`${colors[i % 2]} ${startAngle}deg ${endAngle}deg`);

        const labelAngle = startAngle + (sliceAngle / 2);
        const labelText = prizeValue > 0 ? `£${prizeValue}` : 'Try Again';
        
        htmlSegments += `
            <div class="wheel-segment" style="transform: rotate(${labelAngle}deg);">
                <span class="segment-label">${labelText}</span>
            </div>
        `;
    });
    
    wheel.style.background = `conic-gradient(${gradientParts.join(', ')})`;
    wheel.innerHTML = htmlSegments;

    // 2. Show the modal and wire up the spin button
    const spinButton = document.getElementById('spin-button');
    const spinResultContainer = document.getElementById('spin-result');

    // Reset UI from any previous spin
    spinResultContainer.innerHTML = '';
    spinButton.disabled = false;
    spinButton.style.display = 'block';
    wheel.style.transition = 'transform 5s cubic-bezier(0.25, 0.1, 0.25, 1)';
    wheel.style.transform = `rotate(0deg)`;

    openModal('instant-win-modal');

    spinButton.addEventListener('click', async () => {
        spinButton.disabled = true;
        spinButton.textContent = 'SPINNING...';

        try {
            // 3. Call the secure Cloud Function to get the REAL result
            const allocateTicketsAndCheckWins = httpsCallable(functions, 'allocateTicketsAndCheckWins');
            const result = await allocateTicketsAndCheckWins({ compId: competitionId, ticketsBought });
            const data = result.data;
            
            // 4. Determine the outcome and calculate the target slice
            const totalWinnings = data.wonPrizes.reduce((sum, prize) => sum + prize.prizeValue, 0);
            let targetSliceIndex = wheelSlices.findIndex(sliceValue => sliceValue === (totalWinnings > 0 ? totalWinnings : 0));
            
            // Failsafe if the exact prize value isn't on the wheel (e.g., multiple small wins)
            if (targetSliceIndex === -1) {
                targetSliceIndex = wheelSlices.findIndex(sliceValue => sliceValue === 0);
            }

            // 5. Calculate the spin angle
            const sliceCenterAngle = (targetSliceIndex * sliceAngle) + (sliceAngle / 2);
            // Add multiple full rotations for visual effect, plus a random offset within the slice
            const randomOffset = (Math.random() - 0.5) * (sliceAngle * 0.8);
            const finalAngle = (360 * 5) + sliceCenterAngle + randomOffset;
            
            // 6. SPIN!
            wheel.style.transform = `rotate(${finalAngle}deg)`;

            // 7. Handle the result after the animation finishes
            setTimeout(() => {
                let resultHTML = '';
                if (totalWinnings > 0) {
                    resultHTML = `<h2>Congratulations!</h2><p>You won £${totalWinnings.toFixed(2)} instantly!</p>`;
                } else {
                    resultHTML = `<h2>Better Luck Next Time!</h2><p>Your tickets are still in the main prize draw.</p>`;
                }
                resultHTML += `<button data-close-modal class="btn" onclick="window.location.reload()">Continue</button>`;
                spinResultContainer.innerHTML = resultHTML;
                spinButton.style.display = 'none';
            }, 5500); // 500ms after the spin animation ends

        } catch (error) {
            console.error("Entry failed:", error);
            closeModal('instant-win-modal');
            openModal('modal-container', `<h2>Error</h2><p>${error.message}</p><button data-close-modal class="btn">Close</button>`);
        }
    }, { once: true });
}

// --- Standard (Non-Instant Win) Entry Flow ---

function showStandardConfirmationModal() {
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
            <button id="confirm-standard-entry-btn" class="btn">Confirm & Pay</button>
        </div>
    `);
    
    const confirmBtn = document.getElementById('confirm-standard-entry-btn');
    confirmBtn.addEventListener('click', () => handleStandardEntry(tickets), { once: true });
}

async function handleStandardEntry(ticketsBought) {
    openModal('modal-container', `<h2>Processing Entry...</h2><p>Please wait.</p>`);
    try {
        const allocateTicketsAndCheckWins = httpsCallable(functions, 'allocateTicketsAndCheckWins');
        const result = await allocateTicketsAndCheckWins({ compId: competitionId, ticketsBought });
        const data = result.data;
        
        openModal('modal-container', `
            <h2>Entry Successful!</h2>
            <p>Your tickets #${data.ticketStart} to #${data.ticketStart + data.ticketsBought - 1} are registered. Good luck!</p>
            <button data-close-modal class="btn" onclick="window.location.reload()">Done</button>
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
    if (modalId === 'modal-container') {
        modal = document.getElementById(modalId);
        modalContent = modal.querySelector('.modal-content');
        if (content) modalContent.innerHTML = content;
    } else {
        modal = document.getElementById(modalId);
    }
    if (modal) modal.classList.add('show');
}

function closeModal(modalId) {
    const modalToClose = modalId ? document.getElementById(modalId) : document.querySelector('.modal-container.show');
    if (modalToClose) modalToClose.classList.remove('show');
}

document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close-modal]')) {
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
