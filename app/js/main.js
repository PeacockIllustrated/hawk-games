import { getFirestore, collection, getDocs, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js'; // Import the initialized app

const db = getFirestore(app);

document.addEventListener('DOMContentLoaded', () => {
    loadLiveCompetitions();
    // loadRecentWinners(); // We can add this back later
});

const loadLiveCompetitions = async () => {
    const grid = document.getElementById('competition-grid');
    if (!grid) return;

    try {
        const q = query(collection(db, "competitions"), where("status", "==", "live"), orderBy("endDate", "asc"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            grid.innerHTML = '<div class="hawk-card placeholder">No live competitions right now. Check back soon!</div>';
            return;
        }

        grid.innerHTML = ''; // Clear placeholder
        querySnapshot.forEach((doc) => {
            grid.innerHTML += createCompetitionCard(doc.data(), doc.id);
        });

        startAllCountdowns();

    } catch (error) {
        console.error("Error loading competitions:", error);
        grid.innerHTML = '<div class="hawk-card placeholder" style="color:red;">Could not load competitions.</div>';
    }
};

function createCompetitionCard(compData, compId) {
    const progressPercent = (compData.ticketsSold / compData.totalTickets) * 100;
    const endDate = compData.endDate.toDate();
    const price = compData.ticketTiers[0]?.price || 0.00;

    return `
        <a href="competition.html?id=${compId}" class="hawk-card">
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
    setInterval(updateTimers, 60000); // Update every minute
}
