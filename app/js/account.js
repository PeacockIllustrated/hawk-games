import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, documentId, getDocs, collectionGroup, orderBy } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js';

const db = getFirestore(app);
const auth = getAuth();

onAuthStateChanged(auth, user => {
    if (user) {
        loadAccountData(user);
    } else {
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
    renderUserEntries(user.uid); // Pass UID for the new query
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

async function renderUserEntries(uid) {
    const entriesListDiv = document.getElementById('entries-list');
    if (!entriesListDiv) return;

    // 1. Use a collectionGroup query to get all entries for this user, ordered by date
    const entriesQuery = query(collectionGroup(db, 'entries'), where('userId', '==', uid), orderBy('enteredAt', 'desc'));
    const entriesSnapshot = await getDocs(entriesQuery);

    if (entriesSnapshot.empty) {
        entriesListDiv.innerHTML = `<div class="placeholder">You haven't entered any competitions yet.</div>`;
        return;
    }

    // 2. Get the unique IDs of all competitions the user has entered
    const competitionIds = [...new Set(entriesSnapshot.docs.map(doc => doc.ref.parent.parent.id))];

    // 3. Fetch the data for all those competitions in a single query
    const competitionsMap = new Map();
    if (competitionIds.length > 0) {
        // Firestore 'in' queries are limited to 10 items. We need to chunk it.
        for (let i = 0; i < competitionIds.length; i += 10) {
            const chunk = competitionIds.slice(i, i + 10);
            const compsQuery = query(collection(db, 'competitions'), where(documentId(), 'in', chunk));
            const compsSnapshot = await getDocs(compsQuery);
            compsSnapshot.forEach(doc => competitionsMap.set(doc.id, doc.data()));
        }
    }
    
    // 4. Map over the entries and render the HTML
    entriesListDiv.innerHTML = entriesSnapshot.docs.map(entryDoc => {
        const entryData = entryDoc.data();
        const compId = entryDoc.ref.parent.parent.id;
        const compData = competitionsMap.get(compId);
        if (!compData) return ''; // Failsafe

        return createEntryCardHTML(compData, entryData);
    }).join('');
}

function createEntryCardHTML(compData, entryData) {
    let statusText = compData.status.toUpperCase();
    let statusClass = `status-${compData.status}`;

    if (compData.status === 'drawn' && compData.winnerId && compData.winnerId === auth.currentUser.uid) {
        statusText = 'YOU WON THE MAIN PRIZE!';
        statusClass = 'status-won';
    }

    let instantWinHTML = '';
    if (entryData.instantWins && entryData.instantWins.length > 0) {
        const totalWinnings = entryData.instantWins.reduce((sum, prize) => sum + prize.prizeValue, 0);
        instantWinHTML = `
            <div class="entry-item-win-banner">
                ⚡️ YOU WON £${totalWinnings.toFixed(2)} INSTANTLY WITH THIS ENTRY!
            </div>
        `;
    }

    return `
        <div class="entry-item">
            ${instantWinHTML}
            <img src="${compData.prizeImage}" alt="${compData.title}" class="entry-item-image">
            <div class="entry-item-details">
                <h4>${compData.title}</h4>
                <p>You bought <strong>${entryData.ticketsBought}</strong> entries.</p>
                <p class="entry-ticket-numbers">Your Tickets: #${entryData.ticketStart} - #${entryData.ticketEnd}</p>
            </div>
            <div class="entry-item-status">
                <span class="status-badge ${statusClass}">${statusText}</span>
            </div>
        </div>
    `;
}

function setupEventListeners(uid, initialConsent) {
    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
            await signOut(auth);
            window.location.href = 'index.html';
        });
    }

    const consentCheckbox = document.getElementById('marketing-consent');
    const feedbackEl = document.getElementById('preference-feedback');
    if (consentCheckbox && feedbackEl) {
        consentCheckbox.checked = !!initialConsent; 
        
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
