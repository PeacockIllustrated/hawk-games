import { getFirestore, collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js'; // Import the initialized app

const db = getFirestore(app);

document.addEventListener('DOMContentLoaded', () => {
    loadAllCompetitions();
    loadSpinnerCompetitions();
    loadPastWinners();
    initializeHeaderScroll();
    initializeHowItWorks();
    initializeSmoothScroll();
});

// --- NEW FUNCTION: Smooth Scroll for Anchor Links ---
const initializeSmoothScroll = () => {
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href*="#"]');
        if (link && link.pathname === window.location.pathname) {
            const hash = link.hash;
            const targetElement = document.querySelector(hash);
            if (targetElement) {
                e.preventDefault();
                targetElement.scrollIntoView({
                    behavior: 'smooth'
                });
                history.pushState(null, null, hash);
            }
        }
    });
};

const initializeHeaderScroll = () => {
    const header = document.querySelector('.main-header');
    if (!header) return;

    const handleScroll = () => {
        if (window.scrollY > 50) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
    };

    window.addEventListener('scroll', handleScroll);
};

const initializeHowItWorks = () => {
    const stepCards = document.querySelectorAll('.how-it-works-grid .step-card');
    if (stepCards.length === 0) return;

    stepCards.forEach(card => {
        card.addEventListener('click', () => {
            if (card.classList.contains('active')) {
                card.classList.remove('active');
            } else {
                stepCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
            }
        });
    });
};


const loadAllCompetitions = async () => {
    const heroContainer = document.getElementById('hero-competition-section');
    const mainGrid = document.getElementById('main-competition-grid');
    const instantWinGrid = document.getElementById('instant-win-grid');

    try {
        const q = query(collection(db, "competitions"), where("status", "==", "live"), orderBy("endDate", "asc"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            instantWinGrid.innerHTML = '<div class="hawk-card placeholder">No Instant Win competitions are live right now.</div>';
            mainGrid.innerHTML = '<div class="hawk-card placeholder">No Main Prize competitions are live right now.</div>';
            heroContainer.style.display = 'none'; // Hide the hero section if no comps
            return;
        }

        let heroComp = null;
        const mainComps = [];
        const instantWinComps = [];

        querySnapshot.forEach((doc) => {
            const compData = { id: doc.id, ...doc.data() };
            if (compData.isHeroComp === true) {
                heroComp = compData; // There should only be one
            } else if (compData.instantWinsConfig && compData.instantWinsConfig.enabled === true) {
                instantWinComps.push(compData);
            } else {
                mainComps.push(compData);
            }
        });

        // Render Hero Competition
        if (heroComp) {
            heroContainer.innerHTML = createHeroCompetitionCard(heroComp);
            heroContainer.style.display = 'block';
        } else {
            heroContainer.innerHTML = '';
            heroContainer.style.display = 'none';
        }

        // Render Main Competitions
        if (mainComps.length > 0) {
            mainGrid.innerHTML = mainComps.map(comp => createCompetitionCard(comp)).join('');
        } else {
            mainGrid.innerHTML = '<div class="hawk-card placeholder">No other main prize competitions are live right now.</div>';
        }

        // Render Instant Win Competitions
        if (instantWinComps.length > 0) {
            instantWinGrid.innerHTML = instantWinComps.map(comp => createCompetitionCard(comp)).join('');
        } else {
            instantWinGrid.innerHTML = '<div class="hawk-card placeholder">No Instant Win competitions are live right now.</div>';
        }

        startAllCountdowns();

    } catch (error) {
        console.error("Error loading competitions:", error);
        mainGrid.innerHTML = '<div class="hawk-card placeholder" style="color:red;">Could not load competitions.</div>';
    }
};

const loadSpinnerCompetitions = async () => {
    const spinnerGrid = document.getElementById('spinner-competition-grid');
    if (!spinnerGrid) return;

    try {
        const q = query(collection(db, "spinner_competitions"), where("isActive", "==", true));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            spinnerGrid.innerHTML = '<div class="hawk-card placeholder">No spinner competitions are active.</div>';
            return;
        }

        const spinnerCompsHTML = querySnapshot.docs.map(doc => {
            const data = { id: doc.id, ...doc.data() };
            return createSpinnerCompetitionCard(data);
        }).join('');

        spinnerGrid.innerHTML = spinnerCompsHTML;

    } catch (error) {
        console.error("Error loading spinner competitions:", error);
        spinnerGrid.innerHTML = '<div class="hawk-card placeholder" style="color:red;">Could not load spinner competitions.</div>';
    }
};

const loadPastWinners = async () => {
    const winnersGrid = document.getElementById('past-winners-grid');
    if (!winnersGrid) return;

    try {
        const q = query(collection(db, "pastWinners"), orderBy("drawDate", "desc"));
        const querySnapshot = await getDocs(q);
        
        const validWinners = querySnapshot.docs
            .map(doc => doc.data())
            .filter(winner => winner.winnerDisplayName);

        if (validWinners.length === 0) {
            winnersGrid.innerHTML = '<div class="placeholder">Our first winners will be announced soon!</div>';
            return;
        }
        
        winnersGrid.innerHTML = validWinners.map(winner => createWinnerCard(winner)).join('');

    } catch (error) {
        console.error("Error loading past winners:", error);
        winnersGrid.innerHTML = '<div class="placeholder" style="color:red;">Could not load winner information.</div>';
    }
};

function createWinnerCard(winnerData) {
    const avatar = winnerData.winnerPhotoURL || 'https://i.pravatar.cc/150?u=' + winnerData.winnerId;
    return `
        <div class="winner-card">
            <img src="${avatar}" alt="${winnerData.winnerDisplayName}'s avatar">
            <h4>${winnerData.winnerDisplayName}</h4>
            <p>Won the ${winnerData.prizeTitle}</p>
        </div>
    `;
}

function createHeroCompetitionCard(compData) {
    const progressPercent = (compData.ticketsSold / compData.totalTickets) * 100;
    const endDate = compData.endDate.toDate();
    const price = compData.ticketTiers?.[0]?.price || 0.00;

    return `
        <a href="competition.html?id=${compData.id}" class="hero-competition-card">
            <div class="hero-card-image">
                 <img src="${compData.prizeImage}" alt="${compData.title}">
            </div>
            <div class="hero-card-content">
                <span class="hero-card-tagline">Main Event</span>
                <h2 class="hero-card-title">${compData.title}</h2>
                <div class="hero-card-timer" data-end-date="${endDate.toISOString()}">Calculating...</div>
                <div class="progress-bar">
                    <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
                </div>
                <p class="hawk-card__progress-text">${compData.ticketsSold || 0} / ${compData.totalTickets} sold</p>
                <div class="hero-card-footer">
                    <span class="hawk-card__price">£${price.toFixed(2)}</span>
                    <span class="btn">Enter</span>
                </div>
            </div>
        </a>
    `;
}

function createCompetitionCard(compData) {
    const progressPercent = (compData.ticketsSold / compData.totalTickets) * 100;
    const endDate = compData.endDate.toDate();
    const price = compData.ticketTiers?.[0]?.price || 0.00;

    const instantWinBadge = compData.instantWinsConfig?.enabled 
        ? `<div class="hawk-card__instant-win-badge">⚡️ Instant Wins</div>` 
        : '';

    return `
        <a href="competition.html?id=${compData.id}" class="hawk-card">
            ${instantWinBadge}
            <img src="${compData.prizeImage || 'https://via.placeholder.com/600x400.png?text=Prize'}" alt="${compData.title}" class="hawk-card__image">
            <div class="hawk-card__content">
                <h3 class="hawk-card__title">${compData.title}</h3>
                <div class="hawk-card__timer" data-end-date="${endDate.toISOString()}">
                    Calculating...
                </div>
                <div class="progress-bar">
                    <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
                </div>
                <p class="hawk-card__progress-text">${compData.ticketsSold || 0} / ${compData.totalTickets} sold</p>
                <div class="hawk-card__footer">
                    <span class="hawk-card__price">£${price.toFixed(2)}</span>
                    <span class="btn">Enter Now</span>
                </div>
            </div>
        </a>
    `;
}

function createSpinnerCompetitionCard(data) {
    return `
        <a href="instant-games.html" class="hawk-card spinner-comp-card">
            <div class="hawk-card__content">
                 <h3 class="hawk-card__title">${data.title}</h3>
                 <p class="spinner-comp-prize">Prize: <strong>${data.prize}</strong></p>
                 <p class="spinner-comp-cta-text">Enter the weekly draw to get bonus spin tokens instantly!</p>
                <div class="hawk-card__footer">
                    <span class="hawk-card__price">From £4.50</span>
                    <span class="btn">Get Spins</span>
                </div>
            </div>
        </a>
    `;
}

function startAllCountdowns() {
    const timerElements = document.querySelectorAll('.hawk-card__timer, .hero-card-timer');
    if (timerElements.length === 0) return;

    const updateTimers = () => {
        timerElements.forEach(timer => {
            if (!timer.dataset.endDate) return;
            const endDate = new Date(timer.dataset.endDate);
            const now = new Date();
            const distance = endDate.getTime() - now.getTime();

            if (distance < 0) {
                timer.innerHTML = "<strong>Competition Closed</strong>";
                return;
            }

            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            
            timer.innerHTML = `<strong>${days}D ${hours}H ${minutes}M</strong> LEFT TO ENTER`;
        });
    };
    
    updateTimers(); 
    setInterval(updateTimers, 60000);
}
