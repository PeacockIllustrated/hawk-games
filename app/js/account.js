import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, collection, query, where, documentId, getDocs } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js';

const db = getFirestore(app);
const auth = getAuth();

onAuthStateChanged(auth, user => {
    if (user) {
        loadAccountData(user);
    } else {
        // If not logged in, redirect to login page
        window.location.replace('login.html');
    }
});

async function loadAccountData(user) {
    const userDocRef = doc(db, 'users', user.uid);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
        console.error("User profile not found! Redirecting...");
        window.location.replace('login.html');
        return;
    }

    const userData = userDocSnap.data();
    renderUserProfile(userData);
    renderUserEntries(userData);
    setupEventListeners(user.uid, userData.marketingConsent);
}

function renderUserProfile(userData) {
    const profileCard = document.getElementById('profile-card');
    if (!profileCard) return;

    const adminButtonHTML = userData.isAdmin ? `<a href="admin.html" class="btn">Admin Panel</a>` : '';

    profileCard.innerHTML = `
        <img src="${userData.photoURL || 'https://i.pravatar.cc/150'}" alt="User Avatar" class="profile-avatar">
        <h2 class="profile-name">${userData.displayName}</h2>
        <p class="profile-email">${userData.email}</p>
        <div class="profile-actions">
            ${adminButtonHTML}
            <button id="sign-out-btn" class="btn">Sign Out</button>
        </div>
    `;
}

async function renderUserEntries(userData) {
    const entriesListDiv = document.getElementById('entries-list');
    if (!entriesListDiv) return;

    const entryCountMap = userData.entryCount || {};
    const competitionIds = Object.keys(entryCountMap);

    if (competitionIds.length === 0) {
        entriesListDiv.innerHTML = `<div class="placeholder">You haven't entered any competitions yet.</div>`;
        return;
    }

    // Fetch all competition data in one go (or chunked if > 30)
    const competitionsMap = new Map();
    for (let i = 0; i < competitionIds.length; i += 30) {
        const chunk = competitionIds.slice(i, i + 30);
        const q = query(collection(db, 'competitions'), where(documentId(), 'in', chunk));
        const snapshot = await getDocs(q);
        snapshot.forEach(doc => competitionsMap.set(doc.id, doc.data()));
    }
    
    // Sort by most recent entry first (assuming compId is related to time, which it might not be. A better approach would be to store lastEntryDate on the user doc if needed)
    entriesListDiv.innerHTML = competitionIds.reverse().map(compId => {
        const compData = competitionsMap.get(compId);
        if (!compData) return ''; // Skip if comp data not found
        const userTickets = entryCountMap[compId];
        return createEntryCardHTML(compData, userTickets);
    }).join('');
}

// REPLACE the existing createEntryCardHTML function in account.js

function createEntryCardHTML(compData, userTickets, entryData) { // We now pass the full entryData
    let statusText = compData.status.toUpperCase();
    let statusClass = `status-${compData.status}`;

    if (compData.status === 'drawn' && compData.winnerId && compData.winnerId === auth.currentUser.uid) {
        statusText = 'YOU WON THE MAIN PRIZE!';
        statusClass = 'status-won';
    }

    // **THE NEW PART**: Check for and display instant wins
    let instantWinHTML = '';
    if (entryData.instantWins && entryData.instantWins.length > 0) {
        const totalWinnings = entryData.instantWins.reduce((sum, prize) => sum + prize.prizeValue, 0);
        instantWinHTML = `
            <div class="entry-item-win-banner">
                ⚡️ YOU WON £${totalWinnings.toFixed(2)} INSTANTLY!
            </div>
        `;
    }

    return `
        <div class="entry-item">
            ${instantWinHTML}
            <img src="${compData.prizeImage}" alt="${compData.title}" class="entry-item-image">
            <div class="entry-item-details">
                <h4>${compData.title}</h4>
                <p>You have <strong>${userTickets}</strong> entries.</p>
                <p class="entry-ticket-numbers">Tickets: #${entryData.ticketStart} - #${entryData.ticketEnd}</p>
            </div>
            <div class="entry-item-status">
                <span class="status-badge ${statusClass}">${statusText}</span>
            </div>
        </div>
    `;
}

function setupEventListeners(uid, initialConsent) {
    // Sign out
    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
            await signOut(auth);
            window.location.href = 'index.html';
        });
    }

    // Marketing Consent Toggle
    const consentCheckbox = document.getElementById('marketing-consent');
    const feedbackEl = document.getElementById('preference-feedback');
    if (consentCheckbox && feedbackEl) {
        consentCheckbox.checked = !!initialConsent; // Ensure it's a boolean
        
        consentCheckbox.addEventListener('change', async (e) => {
            const newConsentValue = e.target.checked;
            const userRef = doc(db, 'users', uid);
            feedbackEl.textContent = 'Saving...';
            try {
                await updateDoc(userRef, { marketingConsent: newConsentValue });
                feedbackEl.textContent = 'Preferences Saved!';
                setTimeout(() => feedbackEl.textContent = '', 2000);
            } catch (error) {
                console.error("Error updating consent:", error);
                feedbackEl.textContent = 'Error Saving. Please try again.';
            }
        });
    }
}
