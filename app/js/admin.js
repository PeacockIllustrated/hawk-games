// This is the functional `retrocomps/js/admin.js`, heavily adapted for The Hawk Games.
// It keeps the SPA structure but adds the new "Add FER" functionality.
// The theme switcher has been removed.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, addDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, getDocs, query, orderBy, where, runTransaction } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js'; // Use the shared app instance

const auth = getAuth(app);
const db = getFirestore(app);

// Global State & DOM Elements
let allCompetitions = []; 
const mainContentContainer = document.getElementById('admin-main-content');
const modalContainer = document.getElementById('modal-container');
const modalBody = document.getElementById('modal-body');

// HTML Templates for Dynamic Views (Simplified for brevity, full logic remains)
const dashboardViewHTML = `
    <div class="content-panel">
        <h2>Manage Competitions</h2>
        <div id="competition-list">Loading competitions...</div>
    </div>`;
// Other view templates like create form would go here.

onAuthStateChanged(auth, user => {
    // Admin check logic remains the same...
});

function initializeAdminPage() {
    setupNavigation();
    setupModal();
    renderView('dashboard');
}

function setupNavigation() { /* ... unchanged ... */ }
function renderView(viewName) {
    mainContentContainer.innerHTML = ''; 
    if (viewName === 'dashboard') {
        mainContentContainer.innerHTML = dashboardViewHTML;
        loadAndRenderCompetitions();
    }
    // ... other views
}

async function loadAndRenderCompetitions() {
    const listDiv = document.getElementById('competition-list');
    try {
        const q = query(collection(db, "competitions"), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);
        allCompetitions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        listDiv.innerHTML = allCompetitions.map(comp => renderCompetitionRow(comp)).join('');
        
        // Add event listeners for the entire list
        listDiv.addEventListener('click', handleDashboardClick);

    } catch (error) {
        console.error("Error loading competitions:", error);
        listDiv.innerHTML = '<p style="color:red;">Error loading data.</p>';
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
            <div class="form-group">
                <label for="fer-email">User's Email</label>
                <input type="email" id="fer-email" required placeholder="user@example.com">
            </div>
            <div class="form-group">
                <label for="fer-tickets">Number of Entries</label>
                <input type="number" id="fer-tickets" required value="1" min="1">
            </div>
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
        // 1. Find the user's UID from their email
        const usersRef = collection(db, 'users');
        const q = query(usersRef, where("email", "==", userEmail), limit(1));
        const userSnapshot = await getDocs(q);

        if (userSnapshot.empty) {
            throw new Error(`User with email ${userEmail} not found.`);
        }
        const userId = userSnapshot.docs[0].id;

        // 2. Run the same secure transaction as a paid entry
        await runTransaction(db, async (transaction) => {
            const competitionRef = doc(db, 'competitions', compId);
            const userRef = doc(db, 'users', userId);
            
            const compDoc = await transaction.get(competitionRef);
            const userDoc = await transaction.get(userRef);

            if (!compDoc.exists() || !userDoc.exists()) throw new Error("Competition or User not found.");
            
            const compData = compDoc.data();
            const userData = userDoc.data();
            
            // Perform all the same compliance checks
            if (compData.status !== 'live') throw new Error("This competition is no longer live.");
            
            const userEntryCount = userData.entryCount?.[compId] || 0;
            const limit = compData.userEntryLimit || 75;
            if (userEntryCount + ticketsToAdd > limit) {
                throw new Error(`Entry limit exceeded. User has ${limit - userEntryCount} entries remaining.`);
            }

            const newTicketsSold = (compData.ticketsSold || 0) + ticketsToAdd;
            if (newTicketsSold > compData.totalTickets) {
                throw new Error("Not enough tickets available.");
            }

            // Perform updates
            transaction.update(competitionRef, { ticketsSold: newTicketsSold });
            transaction.update(userRef, { [`entryCount.${compId}`]: userEntryCount + ticketsToAdd });
            transaction.set(doc(collection(competitionRef, 'entries')), {
                userId: userId,
                userDisplayName: userData.displayName,
                ticketsBought: ticketsToAdd,
                enteredAt: serverTimestamp(),
                entryType: 'free_postal' // Critical for compliance
            });
        });

        alert('Free entry added successfully!');
        closeModal();
        loadAndRenderCompetitions(); // Refresh the list

    } catch (error) {
        console.error("FER Error:", error);
        alert(`Error: ${error.message}`);
        form.querySelector('button[type="submit"]').disabled = false;
    }
}

// Modal helper functions
function openModal(content) { /* ... unchanged ... */ }
function closeModal() { /* ... unchanged ... */ }
function setupModal() { /* ... unchanged ... */ }
