import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, addDoc, updateDoc, serverTimestamp, Timestamp, getDocs, query, orderBy, where, runTransaction, limit } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js';

const auth = getAuth(app);
const db = getFirestore(app);

// Global State & DOM Elements
let allCompetitions = [];
const mainContentContainer = document.getElementById('admin-main-content');
const modalContainer = document.getElementById('modal-container');
const modalBody = document.getElementById('modal-body');

// HTML Templates for Dynamic Views
const dashboardViewHTML = `
    <div class="content-panel">
        <h2>Manage Competitions</h2>
        <div id="competition-list"><div class="placeholder">Loading competitions...</div></div>
    </div>`;

const createCompViewHTML = `
    <div class="content-panel">
        <h2>Create New Competition</h2>
        <form id="create-comp-form" class="admin-form">
            <fieldset><legend>Core Details</legend>
                <div class="form-group"><label for="title">Competition Title</label><input type="text" id="title" required></div>
                <div class="form-group"><label for="prizeImage">Prize Image URL</label><input type="url" id="prizeImage" required></div>
                <div class="form-group-inline">
                    <div class="form-group"><label for="totalTickets">Total Tickets</label><input type="number" id="totalTickets" required></div>
                    <div class="form-group"><label for="userEntryLimit">Max Entries Per User</label><input type="number" id="userEntryLimit" value="75" required></div>
                </div>
                <div class="form-group-inline">
                    <div class="form-group"><label for="cashAlternative">Cash Alternative (£)</label><input type="number" id="cashAlternative" required></div>
                    <div class="form-group"><label for="endDate">End Date & Time</label><input type="datetime-local" id="endDate" required></div>
                </div>
            </fieldset>
            <fieldset><legend>Ticket Pricing</legend><div id="ticket-tiers-container"></div><button type="button" id="add-tier-btn" class="btn btn-secondary btn-small">Add Tier</button></fieldset>
            <fieldset><legend>Skill Question</legend>
                <div class="form-group"><label for="questionText">Question</label><input type="text" id="questionText" required></div>
                <div class="form-group-inline">
                    <div class="form-group"><label for="correctAnswer">Correct Answer</label><input type="text" id="correctAnswer" required></div>
                    <div class="form-group"><label for="otherAnswers">Incorrect Answers (comma separated)</label><input type="text" id="otherAnswers" required></div>
                </div>
            </fieldset>
            <button type="submit" class="btn btn-primary">Create Competition</button>
        </form>
    </div>`;

// Admin Gatekeeper
onAuthStateChanged(auth, user => {
    const authWall = document.getElementById('auth-wall');
    if (user) {
        checkAdminStatus(user);
    } else {
        // Show auth wall if not logged in
    }
});

const checkAdminStatus = async (user) => {
    // ... logic remains the same
};

function initializeAdminPage() {
    setupNavigation();
    setupModal();
    renderView('dashboard');
}

function setupNavigation() {
    document.getElementById('admin-nav').addEventListener('click', (e) => {
        e.preventDefault();
        const link = e.target.closest('.admin-nav-link');
        if (!link || link.classList.contains('active')) return;
        document.querySelectorAll('.admin-nav-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        renderView(link.dataset.view);
    });
}

function renderView(viewName) {
    mainContentContainer.innerHTML = ''; // Clear previous content
    switch (viewName) {
        case 'dashboard':
            mainContentContainer.innerHTML = dashboardViewHTML;
            loadAndRenderCompetitions();
            break;
        case 'create':
            mainContentContainer.innerHTML = createCompViewHTML;
            initializeCreateFormView();
            break;
        // Other views like 'winners' would go here
    }
}

async function loadAndRenderCompetitions() {
    const listDiv = document.getElementById('competition-list');
    try {
        const q = query(collection(db, "competitions"), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);
        allCompetitions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        listDiv.innerHTML = allCompetitions.map(comp => renderCompetitionRow(comp)).join('');
        listDiv.addEventListener('click', handleDashboardClick);
    } catch (error) {
        console.error("Error loading competitions:", error);
    }
}

function renderCompetitionRow(comp) {
    const progress = (comp.ticketsSold / comp.totalTickets) * 100;
    let buttons = '';
    
    if (comp.status === 'live') {
        buttons = `
            <button class="btn btn-small" data-action="edit">Edit</button>
            <button class="btn btn-small" data-action="end">End</button>
            <button class="btn btn-small btn-secondary" data-action="add-fer">Add Free Entry</button>
        `;
    } else if (comp.status === 'ended' && !comp.winnerId) {
        buttons = `<button class="btn btn-small" data-action="draw-winner">Draw Winner</button>`;
    } else {
        buttons = `<span class="status-badge status-won">Winner Drawn</span>`;
    }

    return `
        <div class="competition-row" data-comp-id="${comp.id}">
            <div class="comp-info">
                <h4>${comp.title}</h4>
                <div class="progress-bar"><div class="progress-bar-fill" style="width:${progress}%"></div></div>
                <span>${comp.ticketsSold || 0} / ${comp.totalTickets}</span>
            </div>
            <div class="comp-status"><span class="status-badge status-${comp.status}">${comp.status}</span></div>
            <div class="comp-actions">${buttons}</div>
        </div>`;
}

function initializeCreateFormView() {
    const form = document.getElementById('create-comp-form');
    const addTierBtn = document.getElementById('add-tier-btn');
    const tiersContainer = document.getElementById('ticket-tiers-container');
    
    const addTier = () => {
        const tierEl = document.createElement('div');
        tierEl.className = 'form-group-inline ticket-tier-row';
        tierEl.innerHTML = `<div class="form-group"><label>Tickets</label><input type="number" class="tier-amount" required></div><div class="form-group"><label>Price (£)</label><input type="number" step="0.01" class="tier-price" required></div><button type="button" class="btn-remove-tier">×</button>`;
        tiersContainer.appendChild(tierEl);
        tierEl.querySelector('.btn-remove-tier').addEventListener('click', () => tierEl.remove());
    };
    addTierBtn.addEventListener('click', addTier);
    addTier(); // Add one tier by default
    
    form.addEventListener('submit', handleCreateFormSubmit);
}

async function handleCreateFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;

    try {
        const ticketTiers = Array.from(document.querySelectorAll('.ticket-tier-row')).map(row => ({ amount: parseInt(row.querySelector('.tier-amount').value), price: parseFloat(row.querySelector('.tier-price').value) }));
        const correctAnswer = form.querySelector('#correctAnswer').value.trim();
        const otherAnswers = form.querySelector('#otherAnswers').value.split(',').map(a => a.trim());
        const allAnswers = [correctAnswer, ...otherAnswers].sort(() => Math.random() - 0.5);
        const answers = {};
        let correctKey = '';
        ['A', 'B', 'C', 'D'].slice(0, allAnswers.length).forEach((key, i) => {
             answers[key] = allAnswers[i];
             if (allAnswers[i] === correctAnswer) correctKey = key;
        });

        const competitionData = {
            title: form.querySelector('#title').value, prizeImage: form.querySelector('#prizeImage').value, totalTickets: parseInt(form.querySelector('#totalTickets').value), userEntryLimit: parseInt(form.querySelector('#userEntryLimit').value), cashAlternative: parseFloat(form.querySelector('#cashAlternative').value), endDate: Timestamp.fromDate(new Date(form.querySelector('#endDate').value)), skillQuestion: { text: form.querySelector('#questionText').value, answers, correctAnswer: correctKey }, ticketTiers, ticketsSold: 0, status: 'live', createdAt: serverTimestamp(), winnerId: null,
        };
        await addDoc(collection(db, "competitions"), competitionData);
        alert('Competition created!');
        renderView('dashboard');

    } catch (error) {
        console.error("Error creating competition:", error);
        alert(`Error: ${error.message}`);
    } finally {
        submitButton.disabled = false;
    }
}

function handleDashboardClick(e) {
    const button = e.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;
    const compId = button.closest('.competition-row')?.dataset.compId;
    if (!action || !compId) return;
    
    if (action === 'add-fer') showAddFerModal(compId);
    // ... other actions like edit, end, draw winner
}

function showAddFerModal(compId) {
    const comp = allCompetitions.find(c => c.id === compId);
    if (!comp) return;
    
    openModal(`
        <h2>Add Free Entry for:</h2>
        <h3>${comp.title}</h3>
        <form id="fer-form" class="modal-form">
            <div class="form-group"><label for="fer-email">User's Email</label><input type="email" id="fer-email" required placeholder="user@example.com"></div>
            <div class="form-group"><label for="fer-tickets">Number of Entries</label><input type="number" id="fer-tickets" required value="1" min="1"></div>
            <div class="modal-actions">
                <button type="button" class="btn" id="modal-cancel-btn">Cancel</button>
                <button type="submit" class="btn">Add Entry</button>
            </div>
        </form>
    `);

    document.getElementById('fer-form').addEventListener('submit', (e) => handleAddFerSubmit(e, compId));
    document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
}

async function handleAddFerSubmit(e, compId) {
    e.preventDefault();
    const form = e.target;
    form.querySelector('button[type="submit"]').disabled = true;

    const userEmail = form.querySelector('#fer-email').value;
    const ticketsToAdd = parseInt(form.querySelector('#fer-tickets').value);

    try {
        const usersRef = collection(db, 'users');
        const q = query(usersRef, where("email", "==", userEmail), limit(1));
        const userSnapshot = await getDocs(q);
        if (userSnapshot.empty) throw new Error(`User with email ${userEmail} not found.`);
        const userId = userSnapshot.docs[0].id;

        await runTransaction(db, async (transaction) => {
            const competitionRef = doc(db, 'competitions', compId);
            const userRef = doc(db, 'users', userId);
            const compDoc = await transaction.get(competitionRef);
            const userDoc = await transaction.get(userRef);

            if (!compDoc.exists() || !userDoc.exists()) throw new Error("Competition or User not found.");
            
            const compData = compDoc.data();
            const userData = userDoc.data();
            
            if (compData.status !== 'live') throw new Error("This competition is no longer live.");
            
            const userEntryCount = userData.entryCount?.[compId] || 0;
            const limit = compData.userEntryLimit || 75;
            if (userEntryCount + ticketsToAdd > limit) {
                throw new Error(`Entry limit exceeded. User has ${limit - userEntryCount} entries remaining.`);
            }

            const newTicketsSold = (compData.ticketsSold || 0) + ticketsToAdd;
            if (newTicketsSold > compData.totalTickets) throw new Error("Not enough tickets available.");

            transaction.update(competitionRef, { ticketsSold: newTicketsSold });
            transaction.update(userRef, { [`entryCount.${compId}`]: userEntryCount + ticketsToAdd });
            transaction.set(doc(collection(competitionRef, 'entries')), {
                userId: userId, userDisplayName: userData.displayName, ticketsBought: ticketsToAdd, enteredAt: serverTimestamp(), entryType: 'free_postal'
            });
        });

        alert('Free entry added successfully!');
        closeModal();
        loadAndRenderCompetitions();

    } catch (error) {
        console.error("FER Error:", error);
        alert(`Error: ${error.message}`);
        form.querySelector('button[type="submit"]').disabled = false;
    }
}

function setupModal() {
    modalContainer.addEventListener('click', (e) => {
        if (e.target === modalContainer) closeModal();
    });
}

function openModal(content) {
    modalBody.innerHTML = content;
    modalContainer.classList.add('show');
}

function closeModal() {
    modalContainer.classList.remove('show');
}
