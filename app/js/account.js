// /js/account.js
// ES Module – ensure your HTML uses: <script type="module" src="/js/account.js"></script>

'use strict';

// --- Firebase imports (Modular v9) ---
import { app } from './auth.js'; // must export an initialized Firebase app
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js';

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  collection,
  collectionGroup,
  query,
  where,
  getDocs,
  orderBy,
  documentId
} from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js';

// --- Firebase singletons ---
const auth = getAuth(app);
const db   = getFirestore(app);

// --- DOM hooks from your account.html ---
const elUserName = document.getElementById('account-user-name');
const elUserEmail = document.getElementById('account-user-email');
const elUserAvatar = document.getElementById('account-user-avatar');
const elSignOut = document.getElementById('sign-out-btn');
const elMarketingTgl = document.getElementById('marketing-consent');
const elMarketingFeedback = document.getElementById('preference-feedback');
const elEntriesList = document.getElementById('entries-list');
const elAdminContainer = document.getElementById('admin-panel-container');


// --- Utility: safe text setter ---
function setText(el, text) {
  if (!el) return;
  el.textContent = text ?? '';
}

// --- Utility: avatar renderer ---
function renderAvatar(el, user) {
  if (!el || !user) return;
  if (user.photoURL) {
      el.src = user.photoURL;
      el.alt = user.displayName || 'User Avatar';
  } else {
      el.src = `https://i.pravatar.cc/150?u=${user.email}`;
      el.alt = 'User Avatar';
  }
}

// --- NEW RENDER LOGIC: Renders a single "Trophy Card" for a competition ---
function createCompetitionGroupHTML(compData, entries, currentUid) {
    let statusText = compData.status.toUpperCase();
    let statusClass = `status-${compData.status}`;

    // Check for a main prize win
    if (compData.status === 'drawn' && compData.winnerId && compData.winnerId === currentUid) {
        statusText = 'YOU WON THE MAIN PRIZE!';
        statusClass = 'status-won';
    }

    // Generate the HTML for each individual entry row within this group
    const entryRowsHTML = entries.map(entry => {
        let instantWinTag = '';
        if (entry.instantWins && entry.instantWins.length > 0) {
            const totalWinnings = entry.instantWins.reduce((sum, prize) => sum + prize.prizeValue, 0);
            instantWinTag = `<span class="instant-win-tag">⚡️ £${totalWinnings.toFixed(2)} WIN</span>`;
        }
        
        const entryDate = entry.enteredAt?.toDate ? entry.enteredAt.toDate().toLocaleDateString() : 'N/A';
        
        return `
            <div class="entry-list-item">
                <span class="entry-date">${entryDate}</span>
                <span class="entry-tickets">${entry.ticketsBought} Ticket${entry.ticketsBought > 1 ? 's' : ''}</span>
                <span class="entry-numbers">#${entry.ticketStart} - #${entry.ticketEnd}</span>
                ${instantWinTag}
            </div>
        `;
    }).join('');

    return `
        <div class="competition-entry-group">
            <div class="competition-group-header">
                <img src="${compData.prizeImage}" alt="${compData.title}" class="group-header-image">
                <div class="group-header-details">
                    <h4>${compData.title}</h4>
                    <span class="status-badge ${statusClass}">${statusText}</span>
                </div>
            </div>
            <div class="entry-list-container">
                ${entryRowsHTML}
            </div>
        </div>
    `;
}

// --- NEW DATA LOGIC: Fetches and groups all user entries ---
async function loadUserEntries(user) {
  if (!elEntriesList) return;
  elEntriesList.innerHTML = `<div class="placeholder">Loading your entries...</div>`;

  try {
    // Ensure auth token is fresh before this complex query
    await user.getIdToken(true);

    const entriesQuery = query(
      collectionGroup(db, 'entries'),
      where('userId', '==', user.uid),
      orderBy('enteredAt', 'desc')
    );
    const entriesSnapshot = await getDocs(entriesQuery);

    if (entriesSnapshot.empty) {
      elEntriesList.innerHTML = `<div class="placeholder">You haven't entered any competitions yet.</div>`;
      return;
    }

    // Group entries by their parent competition ID
    const groupedEntries = {};
    entriesSnapshot.docs.forEach(doc => {
        const entryData = doc.data();
        const compId = doc.ref.parent.parent.id;
        if (!groupedEntries[compId]) {
            groupedEntries[compId] = [];
        }
        groupedEntries[compId].push(entryData);
    });
    
    // Fetch the data for all the competitions these entries belong to
    const competitionIds = Object.keys(groupedEntries);
    const competitionsMap = new Map();
    if (competitionIds.length > 0) {
        for (let i = 0; i < competitionIds.length; i += 10) {
            const chunk = competitionIds.slice(i, i + 10);
            const compsQuery = query(collection(db, 'competitions'), where(documentId(), 'in', chunk));
            const compsSnapshot = await getDocs(compsQuery);
            compsSnapshot.forEach(doc => competitionsMap.set(doc.id, doc.data()));
        }
    }
    
    // Render the final grouped HTML
    let finalHTML = '';
    for (const compId of competitionIds) {
        const compData = competitionsMap.get(compId);
        const entriesForComp = groupedEntries[compId];
        if (compData && entriesForComp) {
            finalHTML += createCompetitionGroupHTML(compData, entriesForComp, user.uid);
        }
    }
    elEntriesList.innerHTML = finalHTML;

  } catch (err) {
    console.error('[Entries] Failed to load user entries:', err);
    elEntriesList.innerHTML = `<div class="placeholder" style="color:red;">Could not load your entries. Please try again.</div>`;
  }
}

// --- Profile: create (if missing) and load user's profile doc ---
async function ensureAndLoadUserProfile(user) {
  const userRef = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      const payload = {
        uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL,
        isAdmin: false, marketingConsent: false, createdAt: serverTimestamp(),
      };
      await setDoc(userRef, payload);
      return payload;
    }
    return snap.data();
  } catch (err) {
    console.error('[Profile] Failed to load/create user profile:', err);
    // Return a basic profile object so the page doesn't break
    return { displayName: user.displayName, email: user.email, photoURL: user.photoURL, marketingConsent: false };
  }
}

// --- Marketing and Sign Out Event Listeners ---
function setupEventListeners(user, profile) {
  if (elMarketingTgl) {
    elMarketingTgl.checked = !!profile?.marketingConsent;
    elMarketingTgl.addEventListener('change', async (e) => {
      const checked = !!e.currentTarget.checked;
      setText(elMarketingFeedback, 'Saving...');
      try {
        await updateDoc(doc(db, 'users', user.uid), { marketingConsent: checked });
        setText(elMarketingFeedback, 'Preferences Saved!');
      } catch (err) {
        console.error('[Marketing] Failed to update preference:', err);
        setText(elMarketingFeedback, 'Error saving.');
      } finally {
        setTimeout(() => setText(elMarketingFeedback, ''), 2000);
      }
    });
  }

  if (elSignOut) {
    elSignOut.addEventListener('click', () => signOut(auth));
  }
}


// --- Auth gate and page boot ---
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace('login.html');
    return;
  }

  // Ensure Firestore profile exists & load it
  const profile = await ensureAndLoadUserProfile(user);

  // Render basic user info into the profile card
  setText(elUserName, profile.displayName || 'My Account');
  setText(elUserEmail, user.email || '');
  renderAvatar(elUserAvatar, user);
  if (elAdminContainer && profile.isAdmin) {
      elAdminContainer.innerHTML = `<a href="admin.html" class="btn">Admin Panel</a>`;
  }

  // Wire up event listeners
  setupEventListeners(user, profile);

  // Load and render all the user's entries
  await loadUserEntries(user);
});
