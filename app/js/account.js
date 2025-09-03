'use strict';

import { app } from './auth.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js';
import { 
    getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, 
    collection, collectionGroup, query, where, getDocs, orderBy, documentId, onSnapshot
} from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js';

const auth = getAuth(app);
const db   = getFirestore(app);
const functions = getFunctions(app);

// Balance-related Cloud Functions
const transferCashToCredit = httpsCallable(functions, 'transferCashToCredit');
const requestCashPayout = httpsCallable(functions, 'requestCashPayout');

const elUserName = document.getElementById('account-user-name');
const elUserEmail = document.getElementById('account-user-email');
const elUserAvatar = document.getElementById('account-user-avatar');
const elSignOut = document.getElementById('sign-out-btn');
const elMarketingTgl = document.getElementById('marketing-consent');
const elMarketingFeedback = document.getElementById('preference-feedback');
const elEntriesList = document.getElementById('entries-list');
const elAdminContainer = document.getElementById('admin-panel-container');

// Balance display elements
const elCreditBalance = document.getElementById('account-credit-balance');
const elCashBalance = document.getElementById('account-cash-balance');
const elBalanceFeedback = document.getElementById('balance-feedback');

// Transfer form elements
const elTransferForm = document.getElementById('transfer-form');
const elTransferAmount = document.getElementById('transfer-amount');

// Payout form elements
const elPayoutForm = document.getElementById('payout-form');
const elPayoutAmount = document.getElementById('payout-amount');

function createElement(tag, options = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
        if (key === 'class') {
            const classes = Array.isArray(value) ? value : String(value).split(' ');
            classes.forEach(c => { if (c) el.classList.add(c); });
        } else if (key === 'textContent') { el.textContent = value;
        } else if (key === 'style') { Object.assign(el.style, value);
        } else { el.setAttribute(key, value); }
    });
    children.forEach(child => child && el.append(child));
    return el;
}

function setText(el, text) {
  if (!el) return;
  el.textContent = text ?? '';
}

function renderAvatar(el, user) {
  if (!el || !user) return;
  el.src = user.photoURL || `https://i.pravatar.cc/150?u=${user.email}`;
  el.alt = user.displayName || 'User Avatar';
}

function renderCompetitionGroups(competitionsMap, groupedEntries, currentUid) {
    if (!elEntriesList) return;
    elEntriesList.innerHTML = ''; 

    const competitionIdsInOrder = Object.keys(groupedEntries).sort((a, b) => {
        const dateA = groupedEntries[a][0].enteredAt?.toDate() || 0;
        const dateB = groupedEntries[b][0].enteredAt?.toDate() || 0;
        return dateB - dateA; // Sort by most recent entry first
    });

    if (competitionIdsInOrder.length === 0) {
        elEntriesList.append(createElement('div', { class: 'placeholder', textContent: "You haven't entered any competitions yet." }));
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const compId of competitionIdsInOrder) {
        const compData = competitionsMap.get(compId);
        const entriesForComp = groupedEntries[compId];
        if (!compData || !entriesForComp) continue;

        let statusText = compData.status ? compData.status.toUpperCase() : 'LIVE';
        let statusClass = `status-${compData.status || 'live'}`;

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
    const competitionIds = new Set();
    const spinnerCompIds = new Set();

    entriesSnapshot.docs.forEach(doc => {
        const entryData = doc.data();
        const parentCollectionPath = doc.ref.parent.parent.path;
        const compId = doc.ref.parent.parent.id;
        
        if (!groupedEntries[compId]) groupedEntries[compId] = [];
        groupedEntries[compId].push(entryData);

        if (parentCollectionPath.startsWith('competitions/')) {
            competitionIds.add(compId);
        } else if (parentCollectionPath.startsWith('spinner_competitions/')) {
            spinnerCompIds.add(compId);
        }
    });
    
    const competitionsMap = new Map();
    const mainCompIdsArray = Array.from(competitionIds);
    const spinnerCompIdsArray = Array.from(spinnerCompIds);

    if (mainCompIdsArray.length > 0) {
        for (let i = 0; i < mainCompIdsArray.length; i += 30) { // Firestore 'in' query limit is 30
            const chunk = mainCompIdsArray.slice(i, i + 30);
            const compsQuery = query(collection(db, 'competitions'), where(documentId(), 'in', chunk));
            const compsSnapshot = await getDocs(compsQuery);
            compsSnapshot.forEach(doc => competitionsMap.set(doc.id, doc.data()));
        }
    }
    if (spinnerCompIdsArray.length > 0) {
        for (let i = 0; i < spinnerCompIdsArray.length; i += 30) {
            const chunk = spinnerCompIdsArray.slice(i, i + 30);
            const compsQuery = query(collection(db, 'spinner_competitions'), where(documentId(), 'in', chunk));
            const compsSnapshot = await getDocs(compsQuery);
            compsSnapshot.forEach(doc => {
                // Adapt spinner comp data to match the template's expected fields
                const data = doc.data();
                competitionsMap.set(doc.id, { 
                    prizeImage: 'assets/logo-icon.png', 
                    title: data.title,
                    status: 'live' // Spinner comps are always considered live
                });
            });
        }
    }
    
    renderCompetitionGroups(competitionsMap, groupedEntries, user.uid);

  } catch (err) {
    console.error('[Entries] Failed to load user entries:', err);
    elEntriesList.innerHTML = `<div class="placeholder" style="color:red;">Could not load your entries. Please try again.</div>`;
  }
}


function setupEventListeners(user, profile) {
    // Marketing consent toggle
    if (elMarketingTgl) {
        elMarketingTgl.checked = !!profile?.marketingConsent;
        elMarketingTgl.addEventListener('change', async(e) => {
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

    // Sign out button
    if (elSignOut) {
        elSignOut.addEventListener('click', () => signOut(auth));
    }

    // Transfer form submission
    if (elTransferForm) {
        elTransferForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const amount = parseFloat(elTransferAmount.value);
            if (isNaN(amount) || amount <= 0) {
                setText(elBalanceFeedback, "Please enter a valid amount to transfer.");
                return;
            }

            const button = e.target.querySelector('button[type="submit"]');
            const originalButtonText = button.textContent;
            button.disabled = true;
            button.textContent = 'Processing...';
            setText(elBalanceFeedback, '');

            try {
                await transferCashToCredit({ amount });
                setText(elBalanceFeedback, `Successfully transferred £${amount.toFixed(2)} to credit!`);
                elTransferForm.reset();
            } catch (error) {
                console.error("Transfer failed:", error);
                setText(elBalanceFeedback, `Error: ${error.message}`);
            } finally {
                button.disabled = false;
                button.textContent = originalButtonText;
                 setTimeout(() => setText(elBalanceFeedback, ''), 4000);
            }
        });
    }

    // Payout form submission
    if (elPayoutForm) {
        elPayoutForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const amount = parseFloat(elPayoutAmount.value);
             if (isNaN(amount) || amount <= 0) {
                setText(elBalanceFeedback, "Please enter a valid amount for payout.");
                return;
            }

            const button = e.target.querySelector('button[type="submit"]');
            const originalButtonText = button.textContent;
            button.disabled = true;
            button.textContent = 'Processing...';
            setText(elBalanceFeedback, '');

            try {
                await requestCashPayout({ amount });
                setText(elBalanceFeedback, `Payout request for £${amount.toFixed(2)} submitted successfully.`);
                elPayoutForm.reset();
            } catch (error) {
                console.error("Payout request failed:", error);
                setText(elBalanceFeedback, `Error: ${error.message}`);
            } finally {
                button.disabled = false;
                button.textContent = originalButtonText;
                setTimeout(() => setText(elBalanceFeedback, ''), 4000);
            }
        });
    }
}

let userProfileUnsubscribe = null;

auth.onAuthStateChanged(async(user) => {
    if (!user) {
        window.location.replace('login.html');
        return;
    }

    // Unsubscribe from any previous listener
    if (userProfileUnsubscribe) {
        userProfileUnsubscribe();
    }

    const userRef = doc(db, 'users', user.uid);
    userProfileUnsubscribe = onSnapshot(userRef, (docSnap) => {
        if (docSnap.exists()) {
            const profile = docSnap.data();

            // Update profile info
            setText(elUserName, profile.displayName || 'My Account');
            setText(elUserEmail, user.email || '');
            renderAvatar(elUserAvatar, user);

            // Update balances
            const creditBalance = profile.creditBalance || 0;
            const cashBalance = profile.cashBalance || 0;
            if (elCreditBalance) setText(elCreditBalance, `£${creditBalance.toFixed(2)}`);
            if (elCashBalance) setText(elCashBalance, `£${cashBalance.toFixed(2)}`);

            // Show admin panel if applicable
            if (elAdminContainer) {
                elAdminContainer.innerHTML = '';
                if (profile.isAdmin) {
                    const adminButton = createElement('a', { href: 'admin.html', class: 'btn' }, ['Admin Panel']);
                    elAdminContainer.append(adminButton);
                }
            }

            // Setup event listeners with the latest profile data
            // This is repeatedly called, but event listeners are idempotent
            setupEventListeners(user, profile);

        } else {
            // This case is for a user who is authenticated but has no profile document yet.
            // We should create it.
            const payload = {
                uid: user.uid,
                email: user.email,
                displayName: user.displayName,
                photoURL: user.photoURL,
                isAdmin: false,
                marketingConsent: false,
                createdAt: serverTimestamp(),
                creditBalance: 0,
                cashBalance: 0,
            };
            setDoc(userRef, payload).catch(err => {
                console.error("Failed to create user profile:", err);
            });
        }
    });

    // Load static or less frequently updated data
    await loadUserEntries(user);
});
