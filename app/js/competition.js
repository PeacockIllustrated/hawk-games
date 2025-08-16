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
        document.getElementById('competition-page-content').innerHTML = '<main><div class="container"><div class="hawk-card placeholder">Error: No competition specified.</div></div></main>';
    }
});

// --- Core Functions ---
async function loadCompetitionDetails(id) {
    const pageContent = document.getElementById('competition-page-content');
    const competitionRef = doc(db, 'competitions', id);
    try {
        const docSnap = await getDoc(competitionRef);
        if (docSnap.exists()) {
            currentCompetitionData = docSnap.data();
            document.title = `${currentCompetitionData.title} | The Hawk Games`;

            if (currentCompetitionData.isHeroComp && currentCompetitionData.hasParallax) {
                pageContent.innerHTML = createHeroPageHTML(currentCompetitionData);
                initializeParallax();
            } else {
                pageContent.innerHTML = createStandardPageHTML(currentCompetitionData);
            }
            
            setupCountdown(currentCompetitionData.endDate.toDate());
            setupEntryLogic(currentCompetitionData.skillQuestion.correctAnswer);
        } else {
            pageContent.innerHTML = '<main><div class="container"><div class="hawk-card placeholder">Error: Competition not found.</div></div></main>';
        }
    } catch (error) {
        console.error("Error fetching competition details:", error);
        pageContent.innerHTML = '<main><div class="container"><div class="hawk-card placeholder" style="color:red">Could not load competition details.</div></div></main>';
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
        // The hero button has different text, so we don't change it here.
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
            showInstantWinModal(data.awardedTokens.length);
        } else {
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
        
        // Check if it's the hero timer based on its class
        if (timerElement.classList.contains('hero-digital-timer')) {
             timerElement.innerHTML = `${d}:${h}:${m}:${s}`;
        } else {
            timerElement.innerHTML = `${d}<small>d</small> : ${h}<small>h</small> : ${m}<small>m</small> : ${s}<small>s</small>`;
        }
    }, 1000);
}

function initializeParallax() {
    const bg = document.querySelector('.hero-comp-header-bg');
    const fg = document.querySelector('.hero-comp-header-fg');
    if (!bg || !fg) return;

    window.addEventListener('scroll', () => {
        const scrollValue = window.scrollY;
        // Move background slightly slower than scroll, foreground slightly faster
        bg.style.transform = `translateY(${scrollValue * 0.1}px)`;
        fg.style.transform = `translateY(-${scrollValue * 0.15}px)`;
    });
}

// --- HTML Generation ---

function createStandardPageHTML(data) {
    const answersHTML = Object.entries(data.skillQuestion.answers).map(([key, value]) => `<button class="answer-btn" data-answer="${key}">${value}</button>`).join('');
    const ticketTiersHTML = data.ticketTiers.map(tier => `<button class="ticket-option" data-amount="${tier.amount}" data-price="${tier.price}">${tier.amount} Entr${tier.amount > 1 ? 'ies' : 'y'} for £${tier.price.toFixed(2)}</button>`).join('');
    const progressPercent = (data.ticketsSold / data.totalTickets) * 100;
    
    return `
    <main>
        <div id="competition-container" class="container">
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
                    <button id="entry-button" class="btn" disabled>Select Tickets</button>
                </div>
            </div>
        </div>
    </main>
    `;
}

function createHeroPageHTML(data) {
    const answersHTML = Object.entries(data.skillQuestion.answers).map(([key, value]) => `<div class="answer-btn" data-answer="${key}">${value}</div>`).join('');
    const ticketTiersHTML = data.ticketTiers.map(tier => {
        const isBestValue = tier.amount === 10; // Example logic for best value
        return `<div class="ticket-option card-style-option ${isBestValue ? 'best-value' : ''}" data-amount="${tier.amount}" data-price="${tier.price}">
                    ${isBestValue ? '<div class="best-value-badge">BEST VALUE</div>' : ''}
                    <span class="ticket-amount">${tier.amount}</span>
                    <span class="ticket-label">Entr${tier.amount > 1 ? 'ies' : 'y'}</span>
                    <span class="ticket-price">£${tier.price.toFixed(2)}</span>
                </div>`;
    }).join('');
    const progressPercent = (data.ticketsSold / data.totalTickets) * 100;

    // A placeholder for prize specs - in a real app this would come from the DB
    const prizeSpecs = `
        <li>AMG Spec</li>
        <li>Diesel Coupe</li>
        <li>Premium Black Finish</li>
        <li>Cash Alternative: £${(data.cashAlternative || 0).toLocaleString()}</li>
    `;

    return `
        <header class="hero-comp-header">
            <div class="hero-comp-header-bg" style="background-image: url('${data.imageSet.background}')"></div>
            <img class="hero-comp-header-fg" src="${data.imageSet.foreground}" alt="${data.title}">
        </header>
        <main class="hero-comp-main">
            <div class="container">
                <section class="hero-comp-title-section">
                    <h1>Win a ${data.title}</h1>
                    <p class="cash-alternative-hero">Or take <span>£${(data.cashAlternative || 0).toLocaleString()}</span> Cash Alternative</p>
                    <div class="time-remaining">TIME REMAINING</div>
                    <div id="timer" class="hero-digital-timer"></div>
                </section>
                
                <section class="hero-comp-progress-section">
                     <label>Tickets Sold: ${data.ticketsSold || 0} / ${data.totalTickets}</label>
                     <div class="progress-bar">
                        <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
                    </div>
                </section>

                <section class="hero-comp-entry-flow">
                    <div class="entry-step question-step">
                        <h2>1. Answer The Question</h2>
                        <p class="question-text">${data.skillQuestion.text}</p>
                        <div class="answer-options">${answersHTML}</div>
                    </div>
                    <div class="entry-step tickets-step">
                        <h2>2. Choose Your Tickets</h2>
                        <div class="ticket-options">${ticketTiersHTML}</div>
                    </div>
                </section>
                
                <section class="hero-comp-confirm-section">
                    <button id="entry-button" class="btn hero-cta-btn" disabled>
                        Enter Now
                        <span>Secure Your Chance</span>
                    </button>
                </section>

                <section class="hero-comp-glance-section">
                    <h2>3. Prize At a Glance</h2>
                    <div class="glance-content">
                        <img src="${data.imageSet.foreground}" alt="Prize image">
                        <ul>${prizeSpecs}</ul>
                    </div>
                </section>
                
                <section class="hero-comp-trust-section">
                    <div class="trust-badge">
                        <span class="trust-icon">🛡️</span>
                        <h3>100% Secure Payments</h3>
                    </div>
                    <div class="trust-badge">
                        <span class="trust-icon">⚖️</span>
                        <h3>Licensed & Fully Compliant</h3>
                    </div>
                     <div class="trust-badge">
                        <span class="trust-icon">🏆</span>
                        <h3>Real Winners Every Week</h3>
                    </div>
                </section>
            </div>
        </main>
    `;
}

// --- INSTANT WIN MODAL LOGIC ---
// This remains simple as the main spin page is instant-games.html
// This modal is just a notification and CTA
function showInstantWinModal(tokenCount) {
    openModal(`
        <div class="celebration-modal">
            <div class="modal-icon-success">⚡️</div>
            <h2>Spins Unlocked!</h2>
            <p>You've earned ${tokenCount} Spin Token${tokenCount > 1 ? 's' : ''} for the Instant Win game!</p>
            <div class="modal-actions" style="flex-direction: column;">
                <a href="instant-games.html" class="btn">Use Spins Now</a>
                <button data-close-modal class="btn btn-secondary" onclick="window.location.reload()">Maybe Later</button>
            </div>
        </div>
    `);
}
