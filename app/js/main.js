
import { getFirestore, collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js'; // Import the initialized app

const db = getFirestore(app);

document.addEventListener('DOMContentLoaded', () => {
    loadAllCompetitions();
    loadPastWinners();
    initializeHeaderScroll(); // Activate the header scroll effect
    initializeHowItWorks(); // Activate the interactive cards
});

// --- NEW FUNCTION: Initialize Header Scroll Effect ---
const initializeHeaderScroll = () => {
    const header = document.querySelector('.main-header');
    if (!header) return;

    const handleScroll = () => {
        // Add 'scrolled' class if user scrolls more than 50px, otherwise remove it
        if (window.scrollY > 50) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
    };

    window.addEventListener('scroll', handleScroll);
};

// --- NEW FUNCTION: Initialize "How It Works" Interactive Cards ---
const initializeHowItWorks = () => {
    const stepCards = document.querySelectorAll('.how-it-works-grid .step-card');
    if (stepCards.length === 0) return;

    stepCards.forEach(card => {
        card.addEventListener('click', () => {
            // If the clicked card is already active, deactivate it.
            if (card.classList.contains('active')) {
                card.classList.remove('active');
            } else {
                // Otherwise, deactivate all other cards and activate this one.
                stepCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
            }
        });
    });
};


const loadAllCompetitions = async () => {
    const instantWinGrid = document.getElementById('instant-win-grid');
    const regularGrid = document.getElementById('competition-grid');

    if (!instantWinGrid || !regularGrid) {
        console.error("Missing a required grid container in the HTML.");
        return;
    }

    try {
        const q = query(collection(db, "competitions"), where("status", "==", "live"), orderBy("endDate", "asc"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            instantWinGrid.innerHTML = '<div class="hawk-card placeholder">No Instant Win games are live right now. Check back soon!</div>';
            regularGrid.innerHTML = '<div class="hawk-card placeholder">No other competitions are live right now.</div>';
            return;
        }

        const instantWinComps = [];
        const regularComps = [];

        querySnapshot.forEach((doc) => {
            const compData = { id: doc.id, ...doc.data() };
            if (compData.instantWinsConfig && compData.instantWinsConfig.enabled === true) {
                instantWinComps.push(compData);
            } else {
                regularComps.push(compData);
            }
        });

        if (instantWinComps.length > 0) {
            instantWinGrid.innerHTML = instantWinComps.map(comp => createCompetitionCard(comp)).join('');
        } else {
            instantWinGrid.innerHTML = '<div class="hawk-card placeholder">No Instant Win games are live right now. Check back soon!</div>';
        }

        if (regularComps.length > 0) {
            regularGrid.innerHTML = regularComps.map(comp => createCompetitionCard(comp)).join('');
        } else {
            regularGrid.innerHTML = '<div class="hawk-card placeholder">No other competitions are live right now.</div>';
        }

        startAllCountdowns();

    } catch (error) {
        console.error("Error loading competitions:", error);
        instantWinGrid.innerHTML = '<div class="hawk-card placeholder" style="color:red;">Could not load competitions.</div>';
        regularGrid.innerHTML = '';
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

function startAllCountdowns() {
    const timerElements = document.querySelectorAll('.hawk-card__timer');
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
