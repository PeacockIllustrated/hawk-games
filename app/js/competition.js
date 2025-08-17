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

// --- PRIZE ANGLE CONFIGURATION ---
const PRIZE_ANGLES = {
    'cash-1000': 150, 'cash-500': 210, 'cash-250': 300, 'cash-100': 0, 'cash-50': 60,
    'credit-20': 30, 'credit-10': 270, 'credit-5': 120, 'no-win': [90, 180, 240, 330] 
};

// --- SECURITY: Corrected helper function for safe element creation ---
function createElement(tag, options = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
        if (key === 'class') {
            const classes = Array.isArray(value) ? value : String(value).split(' ');
            classes.forEach(c => {
                if (c) el.classList.add(c);
            });
        } else if (key === 'textContent') {
            el.textContent = value;
        } else if (key === 'style') {
            Object.assign(el.style, value);
        } else {
            el.setAttribute(key, value);
        }
    });
    children.forEach(child => child && el.append(child));
    return el;
}


// --- DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    competitionId = params.get('id');
    const pageContent = document.getElementById('competition-page-content');
    if (competitionId) {
        loadCompetitionDetails(competitionId);
    } else {
        pageContent.innerHTML = '';
        pageContent.append(createElement('main', {}, [
            createElement('div', { class: 'container' }, [
                createElement('div', { class: 'hawk-card placeholder', textContent: 'Error: No competition specified.' })
            ])
        ]));
    }
});


async function loadCompetitionDetails(id) {
    const pageContent = document.getElementById('competition-page-content');
    const competitionRef = doc(db, 'competitions', id);
    try {
        const docSnap = await getDoc(competitionRef);
        if (docSnap.exists()) {
            currentCompetitionData = docSnap.data();
            document.title = `${currentCompetitionData.title} | The Hawk Games`;

            pageContent.innerHTML = ''; // Clear placeholders
            if (currentCompetitionData.isHeroComp && currentCompetitionData.hasParallax) {
                pageContent.append(...createHeroPageElements(currentCompetitionData));
                initializeParallax();
            } else {
                pageContent.append(createStandardPageElement(currentCompetitionData));
            }
            
            if (currentCompetitionData.endDate) {
                setupCountdown(currentCompetitionData.endDate.toDate());
            }

            setupEntryLogic(currentCompetitionData.skillQuestion.correctAnswer);
        } else {
            pageContent.innerHTML = '';
            pageContent.append(createElement('main', {}, [createElement('div', { class: 'container' }, [createElement('div', { class: 'hawk-card placeholder', textContent: 'Error: Competition not found.' })])]));
        }
    } catch (error) {
        console.error("Error fetching competition details:", error);
        pageContent.innerHTML = '';
        pageContent.append(createElement('main', {}, [createElement('div', { class: 'container' }, [createElement('div', { class: 'hawk-card placeholder', style: { color: 'red' }, textContent: 'Could not load competition details.' })])]));
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
    });

    entryButton.addEventListener('click', () => {
        if (!auth.currentUser) {
            openModal(createElement('div', {}, [
                createElement('h2', { textContent: 'Login Required' }),
                createElement('p', { textContent: 'Please log in or register to enter.' }),
                createElement('a', { href: 'login.html', class: 'btn' }, ['Login'])
            ]));
            return;
        }
        if (!isAnswerCorrect) {
            openModal(createElement('div', {}, [
                createElement('h2', { textContent: 'Incorrect Answer' }),
                createElement('p', { textContent: 'You must select the correct answer to enter.' }),
                createElement('button', { 'data-close-modal': true, class: 'btn' }, ['Try Again'])
            ]));
            return;
        }
        showConfirmationModal();
    });
}

function showConfirmationModal() {
    const selectedTicket = document.querySelector('.ticket-option.selected');
    if (!selectedTicket) {
        openModal(createElement('div',{},[ createElement('h2', {textContent: 'Select Tickets'}), createElement('p', {textContent: 'Please choose a ticket bundle.'}), createElement('button', {'data-close-modal': true, class:'btn'},['OK']) ]));
        return;
    }
    const tickets = parseInt(selectedTicket.dataset.amount);
    const price = parseFloat(selectedTicket.dataset.price);
    
    const confirmBtn = createElement('button', { id: 'confirm-entry-btn', class: 'btn' }, ['Confirm & Pay']);
    const content = createElement('div', {}, [
        createElement('h2', { textContent: 'Confirm Your Entry' }),
        createElement('p', {}, [`You are about to purchase `, createElement('strong', { textContent: `${tickets}` }), ` entries for `, createElement('strong', { textContent: `£${price.toFixed(2)}` }), `.`]),
        createElement('div', { class: 'modal-actions' }, [
            createElement('button', { 'data-close-modal': true, class: ['btn', 'btn-secondary'] }, ['Cancel']),
            confirmBtn
        ])
    ]);
    openModal(content);
    // --- FIX: Pass both tickets and price to the handler ---
    confirmBtn.addEventListener('click', () => handleEntry(tickets, price), { once: true });
}

// --- FIX: Update function signature and payload ---
async function handleEntry(ticketsBought, price) {
    openModal(createElement('div', {}, [createElement('h2', { textContent: 'Processing Entry...' }), createElement('div', { class: 'loader' }), createElement('p', { textContent: 'Please wait, do not close this window.' })]));
    try {
        const allocateTicketsAndAwardTokens = httpsCallable(functions, 'allocateTicketsAndAwardTokens');
        
        // --- FIX: Construct the full, valid payload ---
        const payload = {
            compId: competitionId,
            ticketsBought: ticketsBought,
            expectedPrice: price,
            paymentMethod: 'card' // Default to 'card' for entries from this page
        };
        
        const result = await allocateTicketsAndAwardTokens(payload);
        const data = result.data;
        
        if (data.awardedTokens && data.awardedTokens.length > 0) {
            showInstantWinModal(data.awardedTokens.length);
        } else {
            const successMessage = `Your tickets #${data.ticketStart} to #${data.ticketStart + data.ticketsBought - 1} have been successfully registered. Good luck in the draw!`;
            const doneBtn = createElement('button', { 'data-close-modal': true, class: 'btn', style: { marginTop: '1rem' } }, ['Done']);
            doneBtn.onclick = () => window.location.reload();
            openModal(createElement('div', { class: 'celebration-modal' }, [
                createElement('div', { class: 'modal-icon-success', textContent: '✓' }),
                createElement('h2', { textContent: 'Entry Successful!' }),
                createElement('p', { textContent: successMessage }),
                doneBtn
            ]));
        }
    } catch (error) {
        console.error("Entry failed:", error);
        openModal(createElement('div', {}, [ createElement('h2', {textContent: 'Error'}), createElement('p', {textContent: error.message}), createElement('button', {'data-close-modal': true, class: 'btn'}, ['Close']) ]));
    }
}

function openModal(contentElement) {
    const modal = document.getElementById('modal-container');
    const modalContent = document.getElementById('modal-content');
    if (!modal || !modalContent) return;
    modalContent.innerHTML = '';
    modalContent.append(contentElement);
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
        timerElement.innerHTML = ''; 
        if (distance < 0) {
            clearInterval(interval);
            timerElement.textContent = "COMPETITION CLOSED";
            document.querySelectorAll('#entry-button, .answer-btn, .ticket-option').forEach(el => el.disabled = true);
            return;
        }
        const d = String(Math.floor(distance / (1000 * 60 * 60 * 24)));
        const h = String(Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
        const m = String(Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
        const s = String(Math.floor((distance % (1000 * 60)) / 1000)).padStart(2, '0');
        
        if (timerElement.classList.contains('hero-digital-timer')) {
             timerElement.textContent = `${d}:${h}:${m}:${s}`;
        } else {
            timerElement.append(
                d, createElement('small', { textContent: 'd' }), ` : ${h}`,
                createElement('small', { textContent: 'h' }), ` : ${m}`,
                createElement('small', { textContent: 'm' }), ` : ${s}`,
                createElement('small', { textContent: 's' })
            );
        }
    }, 1000);
}

function initializeParallax() {
    const bg = document.querySelector('.hero-comp-header-bg');
    const fg = document.querySelector('.hero-comp-header-fg');
    if (!bg || !fg) return;
    window.addEventListener('scroll', () => {
        const scrollValue = window.scrollY;
        bg.style.transform = `translateY(${scrollValue * 0.1}px)`;
        fg.style.transform = `translateY(-${scrollValue * 0.15}px)`;
    });
}

function createStandardPageElement(data) {
    const answers = Object.entries(data.skillQuestion.answers).map(([key, value]) => createElement('button', { class: 'answer-btn', 'data-answer': key, textContent: value }));
    const ticketTiers = data.ticketTiers.map(tier => createElement('button', { class: 'ticket-option', 'data-amount': tier.amount, 'data-price': tier.price, textContent: `${tier.amount} Entr${tier.amount > 1 ? 'ies' : 'y'} for £${tier.price.toFixed(2)}` }));
    const progressPercent = (data.ticketsSold / data.totalTickets) * 100;
    
    const timerElement = data.endDate 
        ? createElement('div', { id: 'timer', class: 'detail-timer' })
        : createElement('div', { class: 'detail-timer', textContent: 'Draws Weekly' });
    
    return createElement('main', {}, [
        createElement('div', { id: 'competition-container', class: 'container' }, [
            createElement('div', { class: 'competition-detail-view' }, [
                createElement('div', { class: 'prize-image-panel' }, [createElement('img', { src: data.prizeImage, alt: data.title })]),
                createElement('div', { class: 'entry-details-panel' }, [
                    createElement('h1', { textContent: data.title }),
                    createElement('p', { class: 'cash-alternative' }, ['Or ', createElement('span', { textContent: `£${(data.cashAlternative || 0).toLocaleString()}` }), ' Cash Alternative']),
                    timerElement,
                    createElement('div', { class: 'detail-progress' }, [
                        createElement('div', { class: 'progress-bar' }, [createElement('div', { class: 'progress-bar-fill', style: { width: `${progressPercent}%` } })]),
                        createElement('p', { textContent: `${data.ticketsSold || 0} / ${data.totalTickets} sold` })
                    ]),
                    createElement('div', { class: 'detail-section skill-question-box' }, [
                        createElement('h3', {}, [createElement('span', { textContent: '1.' }), ' Answer The Question']),
                        createElement('p', { class: 'question-text', textContent: data.skillQuestion.text }),
                        createElement('div', { class: 'answer-options' }, answers)
                    ]),
                    createElement('div', { class: 'detail-section ticket-selector-box' }, [
                        createElement('h3', {}, [createElement('span', { textContent: '2.' }), ' Choose Your Tickets']),
                        createElement('div', { class: 'ticket-options' }, ticketTiers)
                    ]),
                    createElement('button', { id: 'entry-button', class: 'btn', disabled: true }, ['Select Tickets'])
                ])
            ])
        ])
    ]);
}

function createHeroPageElements(data) {
    const answers = Object.entries(data.skillQuestion.answers).map(([key, value]) => createElement('div', { class: 'answer-btn', 'data-answer': key, textContent: value }));
    
    let bestValueAmount = -1;
    if (data.ticketTiers && data.ticketTiers.length > 1) {
        const bestTier = data.ticketTiers.reduce((best, current) => (current.price / current.amount < best.price / best.amount) ? current : best);
        bestValueAmount = bestTier.amount;
    }

    const ticketTiers = data.ticketTiers.map(tier => {
        const isBestValue = tier.amount === bestValueAmount;
        return createElement('div', { class: ['ticket-option', 'card-style-option', isBestValue ? 'best-value' : ''], 'data-amount': tier.amount, 'data-price': tier.price }, [
            isBestValue ? createElement('div', { class: 'best-value-badge', textContent: 'BEST VALUE' }) : null,
            createElement('span', { class: 'ticket-amount', textContent: tier.amount }),
            createElement('span', { class: 'ticket-label', textContent: `Entr${tier.amount > 1 ? 'ies' : 'y'}` }),
            createElement('span', { class: 'ticket-price', textContent: `£${tier.price.toFixed(2)}` })
        ]);
    });
    const progressPercent = (data.ticketsSold / data.totalTickets) * 100;

    const prizeSpecs = [
        'AMG Spec', 'Diesel Coupe', 'Premium Black Finish', `Cash Alternative: £${(data.cashAlternative || 0).toLocaleString()}`
    ].map(spec => createElement('li', { textContent: spec }));

    const header = createElement('header', { class: 'hero-comp-header' }, [
        createElement('div', { class: 'hero-comp-header-bg', style: { backgroundImage: `url('${data.imageSet.background}')` } }),
        createElement('img', { class: 'hero-comp-header-fg', src: data.imageSet.foreground, alt: data.title })
    ]);

    const main = createElement('main', { class: 'hero-comp-main' }, [
        createElement('div', { class: 'container' }, [
            createElement('section', { class: 'hero-comp-title-section' }, [
                createElement('h1', { textContent: `Win a ${data.title}` }),
                createElement('p', { class: 'cash-alternative-hero' }, ['Or take ', createElement('span', { textContent: `£${(data.cashAlternative || 0).toLocaleString()}` }), ' Cash Alternative']),
                createElement('div', { class: 'time-remaining', textContent: 'TIME REMAINING' }),
                createElement('div', { id: 'timer', class: 'hero-digital-timer' })
            ]),
            createElement('section', { class: 'hero-comp-progress-section' }, [
                createElement('label', { textContent: `Tickets Sold: ${data.ticketsSold || 0} / ${data.totalTickets}` }),
                createElement('div', { class: 'progress-bar' }, [createElement('div', { class: 'progress-bar-fill', style: { width: `${progressPercent}%` } })])
            ]),
            createElement('section', { class: 'hero-comp-entry-flow' }, [
                createElement('div', { class: 'entry-step question-step' }, [
                    createElement('h2', { textContent: '1. Answer The Question' }),
                    createElement('p', { class: 'question-text', textContent: data.skillQuestion.text }),
                    createElement('div', { class: 'answer-options' }, answers)
                ]),
                createElement('div', { class: 'entry-step tickets-step' }, [
                    createElement('h2', { textContent: '2. Choose Your Tickets' }),
                    createElement('div', { class: 'ticket-options' }, ticketTiers)
                ])
            ]),
            createElement('section', { class: 'hero-comp-confirm-section' }, [
                createElement('button', { id: 'entry-button', class: ['btn', 'hero-cta-btn'], disabled: true }, [ 'Enter Now', createElement('span', { textContent: 'Secure Your Chance' }) ])
            ]),
            createElement('section', { class: 'hero-comp-glance-section' }, [
                createElement('h2', { textContent: '3. Prize At a Glance' }),
                createElement('div', { class: 'glance-content' }, [
                    createElement('img', { src: data.imageSet.foreground, alt: 'Prize image' }),
                    createElement('ul', {}, prizeSpecs)
                ])
            ]),
            createElement('section', { class: 'hero-comp-trust-section' }, [
                createElement('div', { class: 'trust-badge' }, [createElement('span', { class: 'trust-icon', textContent: '🛡️' }), createElement('h3', { textContent: '100% Secure Payments' })]),
                createElement('div', { class: 'trust-badge' }, [createElement('span', { class: 'trust-icon', textContent: '⚖️' }), createElement('h3', { textContent: 'Licensed & Fully Compliant' })]),
                createElement('div', { class: 'trust-badge' }, [createElement('span', { class: 'trust-icon', textContent: '🏆' }), createElement('h3', { textContent: 'Real Winners Every Week' })])
            ])
        ])
    ]);
    return [header, main];
}

// --- INSTANT WIN MODAL LOGIC ---
function showInstantWinModal(tokenCount) {
    const modal = document.getElementById('instant-win-modal');
    if (!modal) return;

    document.getElementById('spin-modal-title').textContent = `You've Unlocked ${tokenCount} Instant Win Spin${tokenCount > 1 ? 's' : ''}!`;
    
    const spinButton = document.getElementById('spin-button');
    const spinResultContainer = document.getElementById('spin-result');
    const wheel = document.getElementById('wheel');
    
    spinButton.disabled = false;
    spinButton.textContent = "SPIN THE WHEEL";
    spinButton.onclick = handleSpinButtonClick;
    spinResultContainer.innerHTML = '';
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';

    modal.classList.add('show');
    
    if (!modal.dataset.initialized) {
        setupSpinWheel();
        modal.dataset.initialized = 'true';
    }
}

function setupSpinWheel() {
    const wheel = document.getElementById('wheel');
    const segmentCount = 12; 
    wheel.innerHTML = '';
    for (let i = 0; i < segmentCount; i++) {
        const segment = document.createElement('div');
        segment.className = 'wheel-segment';
        wheel.appendChild(segment);
    }
}

async function handleSpinButtonClick() {
    const spinButton = document.getElementById('spin-button');
    const spinResultContainer = document.getElementById('spin-result');
    const wheel = document.getElementById('wheel');

    const userDocRef = doc(db, 'users', auth.currentUser.uid);
    const userDocSnap = await getDoc(userDocRef);
    const userTokens = userDocSnap.data().spinTokens || [];

    if (userTokens.length === 0 || spinButton.disabled) return;

    spinButton.disabled = true;
    spinButton.textContent = 'SPINNING...';
    spinResultContainer.innerHTML = '';
    
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    void wheel.offsetWidth;

    const tokenToSpend = userTokens.sort((a, b) => new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000))[0];
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

        }, 8500);

    } catch (error) {
        console.error("Error spending token:", error);
        spinResultContainer.innerHTML = `<p class="spin-error">Error: ${error.message}</p>`;
        spinButton.disabled = false;
        spinButton.textContent = "SPIN THE WHEEL";
    }
}
