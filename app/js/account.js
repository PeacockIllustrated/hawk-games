import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, documentId, getDocs, collectionGroup, orderBy, updateDoc } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js';

const db = getFirestore(app);
const auth = getAuth(app);

// This is the primary listener for the page.
onAuthStateChanged(auth, async (user) => {
    if (user) {
        console.log("--- STARTING DIAGNOSTIC SEQUENCE ---");
        await runDiagnostics(user);
    } else {
        window.location.replace('login.html');
    }
});

async function runDiagnostics(user) {
    try {
        // --- CHECKPOINT 1: Is the user object valid? ---
        console.log(`[DEBUG 1/4] Auth state confirmed. User UID: ${user.uid}`);

        // --- CHECKPOINT 2: Can we get a fresh auth token? ---
        await user.getIdToken(true);
        console.info(`[DEBUG 2/4] Auth token refresh successful. User is fully authenticated.`);

        // --- CHECKPOINT 3: Can we perform a simple authenticated read? ---
        const userDocRef = doc(db, 'users', user.uid);
        console.log(`[DEBUG 3/4] Attempting to read user profile at: ${userDocRef.path}`);
        const userDocSnap = await getDoc(userDocRef);
        
        if (!userDocSnap.exists()) {
            console.warn(`[DEBUG 3/4] User profile does not exist in Firestore yet. This is normal for a new user.`);
            // Render basic UI and stop, as there are no entries to load.
            renderUserProfile({ displayName: user.displayName, email: user.email, photoURL: user.photoURL });
            document.getElementById('entries-list').innerHTML = `<div class="placeholder">You haven't entered any competitions yet.</div>`;
            return;
        }
        console.info(`[DEBUG 3/4] Successfully read user profile data.`);
        
        // Render the profile and setup listeners now that we have the data
        const userData = userDocSnap.data();
        renderUserProfile(userData);
        setupEventListeners(user.uid, userData.marketingConsent);

        // --- CHECKPOINT 4: Can we perform the complex collectionGroup query? ---
        console.log(`[DEBUG 4/4] Attempting to run collectionGroup query for entries...`);
        await renderUserEntries(user.uid);
        console.info(`[DEBUG 4/4] Successfully rendered user entries.`);

    } catch (error) {
        console.error("--- DIAGNOSTIC FAILED ---");
        console.error("The sequence failed. The error below is the root cause:");
        console.error(error);
        document.getElementById('entries-list').innerHTML = `<div class="placeholder" style="color:red;">Could not load your entries. An error occurred. Check the console.</div>`;
    }
}


function renderUserProfile(userData) {
    const profileCard = document.getElementById('profile-card');
    if (!profileCard) return;
    const adminButtonHTML = userData.isAdmin ? `<a href="admin.html" class="btn">Admin Panel</a>` : '';
    profileCard.innerHTML = `
        <img src="${userData.photoURL || 'https://i.pravatar.cc/150'}" alt="User Avatar" class="profile-avatar">
        <h2 class="profile-name">${userData.displayName || 'New User'}</h2>
        <p class="profile-email">${userData.email}</p>
        <div class="profile-actions">${adminButtonHTML}<button id="sign-out-btn" class="btn">Sign Out</button></div>`;
}

async function renderUserEntries(uid) {
    const entriesListDiv = document.getElementById('entries-list');
    if (!entriesListDiv) return;

    // This is the query that is failing.
    const entriesQuery = query(collectionGroup(db, 'entries'), where('userId', '==', uid), orderBy('enteredAt', 'desc'));
    const entriesSnapshot = await getDocs(entriesQuery);

    if (entriesSnapshot.empty) {
        entriesListDiv.innerHTML = `<div class="placeholder">You haven't entered any competitions yet.</div>`;
        return;
    }
    const competitionIds = [...new Set(entriesSnapshot.docs.map(doc => doc.ref.parent.parent.id))];
    const competitionsMap = new Map();
    if (competitionIds.length > 0) {
        for (let i = 0; i < competitionIds.length; i += 10) {
            const chunk = competitionIds.slice(i, i + 10);
            const compsQuery = query(collection(db, 'competitions'), where(documentId(), 'in', chunk));
            const compsSnapshot = await getDocs(compsQuery);
            compsSnapshot.forEach(doc => competitionsMap.set(doc.id, doc.data()));
        }
    }
    entriesListDiv.innerHTML = entriesSnapshot.docs.map(entryDoc => {
        const entryData = entryDoc.data();
        const compId = entryDoc.ref.parent.parent.id;
        const compData = competitionsMap.get(compId);
        return compData ? createEntryCardHTML(compData, entryData) : '';
    }).join('');
}

function createEntryCardHTML(compData, entryData) {
    let statusText = compData.status.toUpperCase();
    let statusClass = `status-${compData.status}`;
    const currentUser = auth.currentUser;
    if (compData.status === 'drawn' && currentUser && compData.winnerId === currentUser.uid) {
        statusText = 'YOU WON THE MAIN PRIZE!';
        statusClass = 'status-won';
    }
    let instantWinHTML = '';
    if (entryData.instantWins && entryData.instantWins.length > 0) {
        const totalWinnings = entryData.instantWins.reduce((sum, prize) => sum + prize.prizeValue, 0);
        instantWinHTML = `<div class="entry-item-win-banner">⚡️ YOU WON £${totalWinnings.toFixed(2)} INSTANTLY!</div>`;
    }
    return `
        <div class="entry-item">
            ${instantWinHTML}
            <img src="${compData.prizeImage}" alt="${compData.title}" class="entry-item-image">
            <div class="entry-item-details">
                <h4>${compData.title}</h4>
                <p>You bought <strong>${entryData.ticketsBought}</strong> entries.</p>
                <p class="entry-ticket-numbers">Tickets: #${entryData.ticketStart} - #${entryData.ticketEnd}</p>
            </div>
            <div class="entry-item-status"><span class="status-badge ${statusClass}">${statusText}</span></div>
        </div>`;
}

function setupEventListeners(uid, initialConsent) {
    const signOutBtn = document.getElementById('sign-out-btn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', () => { signOut(auth); });
    }
    const consentCheckbox = document.getElementById('marketing-consent');
    const feedbackEl = document.getElementById('preference-feedback');
    if (consentCheckbox && feedbackEl) {
        consentCheckbox.checked = !!initialConsent; 
        consentCheckbox.addEventListener('change', (e) => {
            const userRef = doc(db, 'users', uid);
            updateDoc(userRef, { marketingConsent: e.target.checked });
        });
    }
}
