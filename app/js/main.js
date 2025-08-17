'use strict';

import { getFirestore, collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js'; 

const db = getFirestore(app);

// --- SECURITY: Helper for safe element creation ---
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

document.addEventListener('DOMContentLoaded', () => {
    loadAllCompetitions();
    loadPastWinners();
    initializeHeaderScroll();
    initializeHowItWorks();
    initializeSmoothScroll();
});

const initializeSmoothScroll = () => {
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href*="#"]');
        if (link && link.pathname === window.location.pathname) {
            const hash = link.hash;
            const targetElement = document.querySelector(hash);
            if (targetElement) {
                e.preventDefault();
                targetElement.scrollIntoView({ behavior: 'smooth' });
                history.pushState(null, null, hash);
            }
        }
    });
};

const initializeHeaderScroll = () => {
    const header = document.querySelector('.main-header');
    if (!header) return;
    window.addEventListener('scroll', () => {
        header.classList.toggle('scrolled', window.scrollY > 50);
    });
};

const initializeHowItWorks = () => {
    const stepCards = document.querySelectorAll('.how-it-works-grid .step-card');
    stepCards.forEach(card => {
        card.addEventListener('click', () => {
            const isActive = card.classList.contains('active');
            stepCards.forEach(c => c.classList.remove('active'));
            if (!isActive) card.classList.add('active');
        });
    });
};

const loadAllCompetitions = async () => {
    const heroContainer = document.getElementById('hero-competition-section');
    const mainGrid = document.getElementById('main-competition-grid');
    const instantWinGrid = document.getElementById('instant-win-grid');
    const spinnerGrid = document.getElementById('spinner-competition-grid');

    try {
        const q = query(collection(db, "competitions"), where("status", "==", "live"), orderBy("endDate", "asc"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            instantWinGrid.innerHTML = '';
            mainGrid.innerHTML = '';
            spinnerGrid.innerHTML = '';
            instantWinGrid.append(createElement('div', { class: 'hawk-card placeholder', textContent: 'No Instant Win competitions are live right now.'}));
            mainGrid.append(createElement('div', { class: 'hawk-card placeholder', textContent: 'No Main Prize competitions are live right now.'}));
            spinnerGrid.append(createElement('div', { class: 'hawk-card placeholder', textContent: 'No Token competitions are active.'}));
            heroContainer.style.display = 'none';
            return;
        }

        let heroComp = null;
        const mainComps = [];
        const instantWinComps = [];
        const tokenComps = [];

        querySnapshot.forEach((doc) => {
            const compData = { id: doc.id, ...doc.data() };
            // Prioritize hero comp classification
            if (compData.competitionType === 'hero') {
                 heroComp = compData;
            } else if (compData.competitionType === 'instant') {
                instantWinComps.push(compData);
            } else if (compData.competitionType === 'token') {
                tokenComps.push(compData);
            } else { // 'main' or undefined legacy comps
                mainComps.push(compData);
            }
        });
        
        // Render Hero Competition
        heroContainer.innerHTML = '';
        if (heroComp) {
            heroContainer.append(createHeroCompetitionCard(heroComp));
            heroContainer.style.display = 'block';
        } else {
            heroContainer.style.display = 'none';
        }

        // Render Main Competitions
        mainGrid.innerHTML = '';
        if (mainComps.length > 0) mainComps.forEach(comp => mainGrid.append(createCompetitionCard(comp)));
        else mainGrid.append(createElement('div', { class: 'hawk-card placeholder', textContent: 'No main prize competitions are live right now.'}));

        // Render Instant Win Competitions
        instantWinGrid.innerHTML = '';
        if (instantWinComps.length > 0) instantWinComps.forEach(comp => instantWinGrid.append(createCompetitionCard(comp)));
        else instantWinGrid.append(createElement('div', { class: 'hawk-card placeholder', textContent: 'No Instant Win competitions are live right now.'}));
        
        // Render Token Competitions
        spinnerGrid.innerHTML = '';
        if (tokenComps.length > 0) tokenComps.forEach(comp => spinnerGrid.append(createCompetitionCard(comp, true))); // Pass true to use 'Get Spins' text
        else spinnerGrid.append(createElement('div', { class: 'hawk-card placeholder', textContent: 'No Token competitions are active right now.'}));


        startAllCountdowns();

    } catch (error) {
        console.error("Error loading competitions:", error);
        mainGrid.innerHTML = '';
        mainGrid.append(createElement('div', { class: 'hawk-card placeholder', style: {color: 'red'}, textContent: 'Could not load competitions.'}));
    }
};

const loadPastWinners = async () => {
    const winnersGrid = document.getElementById('past-winners-grid');
    if (!winnersGrid) return;
    winnersGrid.innerHTML = '';

    try {
        const q = query(collection(db, "pastWinners"), orderBy("drawDate", "desc"));
        const querySnapshot = await getDocs(q);
        
        const validWinners = querySnapshot.docs.map(doc => doc.data()).filter(winner => winner.winnerDisplayName);

        if (validWinners.length === 0) {
            winnersGrid.append(createElement('div', { class: 'placeholder', textContent: 'Our first winners will be announced soon!'}));
            return;
        }
        
        validWinners.forEach(winner => winnersGrid.append(createWinnerCard(winner)));

    } catch (error) {
        console.error("Error loading past winners:", error);
        winnersGrid.innerHTML = '<div class="placeholder" style="color:red;">Could not load winner information.</div>';
    }
};

function createWinnerCard(winnerData) {
    return createElement('div', { class: 'winner-card' }, [
        createElement('img', { src: winnerData.winnerPhotoURL || `https://i.pravatar.cc/150?u=${winnerData.winnerId}`, alt: `${winnerData.winnerDisplayName}'s avatar` }),
        createElement('h4', { textContent: winnerData.winnerDisplayName }),
        createElement('p', { textContent: `Won the ${winnerData.prizeTitle}` })
    ]);
}

function createHeroCompetitionCard(compData) {
    const progressPercent = (compData.ticketsSold / compData.totalTickets) * 100;
    const endDate = compData.endDate.toDate();
    const price = compData.ticketTiers?.[0]?.price || 0.00;
    const instantWinBadge = compData.instantWinsConfig?.enabled 
        ? createElement('div', { class: 'hawk-card__instant-win-badge', textContent: '⚡️ Instant Wins' })
        : null;

    return createElement('a', { href: `competition.html?id=${compData.id}`, class: 'hero-competition-card' }, [
        instantWinBadge,
        createElement('div', { class: 'hero-card-image' }, [
            createElement('img', { src: compData.prizeImage, alt: compData.title })
        ]),
        createElement('div', { class: 'hero-card-content' }, [
            createElement('span', { class: 'hero-card-tagline', textContent: 'Main Event' }),
            createElement('h2', { class: 'hero-card-title', textContent: compData.title }),
            createElement('div', { class: 'hero-card-timer', 'data-end-date': endDate.toISOString(), textContent: 'Calculating...' }),
            createElement('div', { class: 'progress-bar' }, [
                createElement('div', { class: 'progress-bar-fill', style: { width: `${progressPercent}%` } })
            ]),
            createElement('p', { class: 'hawk-card__progress-text', textContent: `${compData.ticketsSold || 0} / ${compData.totalTickets} sold` }),
            createElement('div', { class: 'hero-card-footer' }, [
                createElement('span', { class: 'hawk-card__price', textContent: `£${price.toFixed(2)}` }),
                createElement('span', { class: 'btn', textContent: 'Enter' })
            ])
        ])
    ]);
}

function createCompetitionCard(compData, isTokenComp = false) {
    const progressPercent = (compData.ticketsSold / compData.totalTickets) * 100;
    const endDate = compData.endDate ? compData.endDate.toDate() : null;
    const price = compData.ticketTiers?.[0]?.price || 0.00;
    const instantWinBadge = compData.instantWinsConfig?.enabled 
        ? createElement('div', { class: 'hawk-card__instant-win-badge', textContent: '⚡️ Instant Wins' })
        : null;

    const timerElement = endDate
        ? createElement('div', { class: 'hawk-card__timer', 'data-end-date': endDate.toISOString(), textContent: 'Calculating...' })
        : createElement('div', { class: 'hawk-card__timer', textContent: 'Draws Weekly' }); // Display for token comps

    const buttonText = isTokenComp ? 'Get Spins' : 'Enter Now';
    const linkHref = isTokenComp ? `competition.html?id=${compData.id}` : `competition.html?id=${compData.id}`; // Can be different later

    return createElement('a', { href: linkHref, class: 'hawk-card' }, [
        instantWinBadge,
        createElement('img', { src: compData.prizeImage || 'https://via.placeholder.com/600x400.png?text=Prize', alt: compData.title, class: 'hawk-card__image' }),
        createElement('div', { class: 'hawk-card__content' }, [
            createElement('h3', { class: 'hawk-card__title', textContent: compData.title }),
            timerElement,
            createElement('div', { class: 'progress-bar' }, [
                createElement('div', { class: 'progress-bar-fill', style: { width: `${progressPercent}%` } })
            ]),
            createElement('p', { class: 'hawk-card__progress-text', textContent: `${compData.ticketsSold || 0} / ${compData.totalTickets} sold` }),
            createElement('div', { class: 'hawk-card__footer' }, [
                createElement('span', { class: 'hawk-card__price', textContent: `£${price.toFixed(2)}` }),
                createElement('span', { class: 'btn', textContent: buttonText })
            ])
        ])
    ]);
}

function startAllCountdowns() {
    const timerElements = document.querySelectorAll('.hawk-card__timer[data-end-date], .hero-card-timer[data-end-date]');
    if (timerElements.length === 0) return;

    const updateTimers = () => {
        timerElements.forEach(timer => {
            const endDate = new Date(timer.dataset.endDate);
            const distance = endDate.getTime() - new Date().getTime();
            timer.innerHTML = ''; 

            if (distance < 0) {
                timer.append(createElement('strong', { textContent: "Competition Closed" }));
                return;
            }

            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            
            timer.append(
                createElement('strong', { textContent: `${days}D ${hours}H ${minutes}M` }),
                ' LEFT TO ENTER'
            );
        });
    };
    
    updateTimers(); 
    setInterval(updateTimers, 60000);
}
