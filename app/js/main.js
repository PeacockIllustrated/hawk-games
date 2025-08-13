import { getFirestore, collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js'; // Import the initialized app

const db = getFirestore(app);

document.addEventListener('DOMContentLoaded', () => {
    loadAllCompetitions();
});

const loadAllCompetitions = async () => {
    // Get references to BOTH new grid containers
    const instantWinGrid = document.getElementById('instant-win-grid');
    const regularGrid = document.getElementById('competition-grid');

    if (!instantWinGrid || !regularGrid) {
        console.error("Missing a required grid container in the HTML.");
        return;
    }

    try {
        // A single, efficient query to get all live competitions
        const q = query(collection(db, "competitions"), where("status", "==", "live"), orderBy("endDate", "asc"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            instantWinGrid.innerHTML = '<div class="hawk-card placeholder">No Instant Win games are live right now. Check back soon!</div>';
            regularGrid.innerHTML = '<div class="hawk-card placeholder">No other competitions are live right now.</div>';
            return;
        }

        // --- NEW LOGIC: Separate competitions into two lists ---
        const instantWinComps = [];
        const regularComps = [];

        querySnapshot.forEach((doc) => {
            const compData = { id: doc.id, ...doc.data() };
            // Check if the competition has instant wins enabled
            if (compData.instantWinsConfig && compData.instantWinsConfig.enabled === true) {
                instantWinComps.push(compData);
            } else {
                regularComps.push(compData);
            }
        });

        // --- Render the Instant Win Grid ---
        if (instantWinComps.length > 0) {
            instantWinGrid.innerHTML = instantWinComps.map(comp => createCompetitionCard(comp)).join('');
        } else {
            instantWinGrid.innerHTML = '<div class="hawk-card placeholder">No Instant Win games are live right now. Check back soon!</div>';
        }

        // --- Render the Regular Competitions Grid ---
        if (regularComps.length > 0) {
            regularGrid.innerHTML = regularComps.map(comp => createCompetitionCard(comp)).join('');
        } else {
            regularGrid.innerHTML = '<div class="hawk-card placeholder">No other competitions are live right now.</div>';
        }

        // This function works on all rendered cards, regardless of their grid
        startAllCountdowns();

    } catch (error) {
        console.error("Error loading competitions:", error);
        instantWinGrid.innerHTML = '<div class="hawk-card placeholder" style="color:red;">Could not load competitions.</div>';
        regularGrid.innerHTML = ''; // Hide the second grid on a major error
    }
};

function createCompetitionCard(compData) { // Now accepts the whole object
    const progressPercent = (compData.ticketsSold / compData.totalTickets) * 100;
    const endDate = compData.endDate.toDate();
    const price = compData.ticketTiers?.[0]?.price || 0.00;

    // This logic remains the same and works perfectly!
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
    const timerInterval = setInterval(updateTimers, 60000);
}
