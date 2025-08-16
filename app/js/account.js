// /js/account.js

'use strict';

import { app } from './auth.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, collectionGroup, query, where, getDocs, orderBy, documentId } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js';

const auth = getAuth(app);
const db   = getFirestore(app);

const elUserName = document.getElementById('account-user-name');
const elUserEmail = document.getElementById('account-user-email');
const elUserAvatar = document.getElementById('account-user-avatar');
const elSignOut = document.getElementById('sign-out-btn');
const elMarketingTgl = document.getElementById('marketing-consent');
const elMarketingFeedback = document.getElementById('preference-feedback');
const elEntriesList = document.getElementById('entries-list');
const elAdminContainer = document.getElementById('admin-panel-container');

// --- SECURITY: Helper for safe element creation ---
function createElement(tag, options = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
        if (key === 'class') {
            if (Array.isArray(value)) value.forEach(c => c && el.classList.add(c));
            else if (value) el.classList.add(value);
        } else if (key === 'textContent') {
            el.textContent = value;
        } else if (key === 'style') {
            Object.assign(el.style, value);
        } else {
            el.setAttribute(key, value);
        }
    });
    children.forEach(child => child && el.append(child));
    return el;
}

// --- Utility: safe text setter ---
function setText(el, text) {
  if (!el) return;
  el.textContent = text ?? '';
}

function renderAvatar(el, user) {
  if (!el || !user) return;
  el.src = user.photoURL || `https://i.pravatar.cc/150?u=${user.email}`;
  el.alt = user.displayName || 'User Avatar';
}

// --- SECURITY: Renders competition groups programmatically (no innerHTML) ---
function renderCompetitionGroups(competitionsMap, groupedEntries, currentUid) {
    if (!elEntriesList) return;
    elEntriesList.innerHTML = ''; // Clear placeholder

    const competitionIds = Object.keys(groupedEntries);
    if (competitionIds.length === 0) {
        elEntriesList.append(createElement('div', { class: 'placeholder', textContent: "You haven't entered any competitions yet." }));
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const compId of competitionIds) {
        const compData = competitionsMap.get(compId);
        const entriesForComp = groupedEntries[compId];
        if (!compData || !entriesForComp) continue;

        let statusText = compData.status.toUpperCase();
        let statusClass = `status-${compData.status}`;

        if (compData.status === 'drawn' && compData.winnerId === currentUid) {
            statusText = 'YOU WON THE MAIN PRIZE!';
            statusClass = 'status-won';
        }

        const entryRows = entriesForComp.map(entry => {
            const totalWinnings = (entry.instantWins || []).reduce((sum, prize) => sum + prize.prizeValue, 0);
            const instantWinTag = totalWinnings > 0
                ? createElement('span', { class: 'instant-win-tag', textContent: `⚡️ £${totalWinnings.toFixed(2)} WIN` })
                : null;
            
            return createElement('div', { class: 'entry-list-item' }, [
                createElement('span', { class: 'entry-date', textContent: entry.enteredAt?.toDate ? entry.enteredAt.toDate().toLocaleDateString() : 'N/A' }),
                createElement('span', { class: 'entry-tickets', textContent: `${entry.ticketsBought} Ticket${entry.ticketsBought > 1 ? 's' : ''}` }),
                createElement('span', { class: 'entry-numbers', textContent: `#${entry.ticketStart} - #${entry.ticketEnd}` }),
                instantWinTag
            ]);
        });

        const group = createElement('div', { class: 'competition-entry-group' }, [
            createElement('div', { class: 'competition-group-header' }, [
                createElement('img', { src: compData.prizeImage, alt: compData.title, class: 'group-header-image' }),
                createElement('div', { class: 'group-header-details' }, [
                    createElement('h4', { textContent: compData.title }),
                    createElement('span', { class: ['status-badge', statusClass], textContent: statusText })
                ])
            ]),
            createElement('div', { class: 'entry-list-container' }, entryRows)
        ]);
        fragment.appendChild(group);
    }
    elEntriesList.appendChild(fragment);
}


async function loadUserEntries(user) {
  if (!elEntriesList) return;
  elEntriesList.innerHTML = `<div class="placeholder">Loading your entries...</div>`;

  try {
    await user.getIdToken(true);

    const entriesQuery = query(collectionGroup(db, 'entries'), where('userId', '==', user.uid), orderBy('enteredAt', 'desc'));
    const entriesSnapshot = await getDocs(entriesQuery);

    const groupedEntries = {};
    entriesSnapshot.docs.forEach(doc => {
        const entryData = doc.data();
        const compId = doc.ref.parent.parent.id;
        if (!groupedEntries[compId]) groupedEntries[compId] = [];
        groupedEntries[compId].push(entryData);
    });
    
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
    
    renderCompetitionGroups(competitionsMap, groupedEntries, user.uid);

  } catch (err) {
    console.error('[Entries] Failed to load user entries:', err);
    elEntriesList.innerHTML = `<div class="placeholder" style="color:red;">Could not load your entries. Please try again.</div>`;
  }
}

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
    return { displayName: user.displayName, email: user.email, photoURL: user.photoURL, marketingConsent: false };
  }
}

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

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    window.location.replace('login.html');
    return;
  }

  const profile = await ensureAndLoadUserProfile(user);

  setText(elUserName, profile.displayName || 'My Account');
  setText(elUserEmail, user.email || '');
  renderAvatar(elUserAvatar, user);
  
  if (elAdminContainer && profile.isAdmin) {
    elAdminContainer.innerHTML = ''; // Clear previous content
    const adminButton = createElement('a', { href: 'admin.html', class: 'btn' }, ['Admin Panel']);
    elAdminContainer.append(adminButton);
  }

  setupEventListeners(user, profile);
  await loadUserEntries(user);
});
