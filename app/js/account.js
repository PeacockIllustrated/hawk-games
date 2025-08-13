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
  collectionGroup,
  query,
  where,
  getDocs
  // , orderBy // uncomment if you add ordering and an index
} from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js';

// --- Firebase singletons ---
const auth = getAuth(app);
const db   = getFirestore(app);

// --- DOM hooks (all optional; code no-ops if missing) ---
const elName           = document.getElementById('account-user-name');
const elEmail          = document.getElementById('account-user-email');
const elAvatar         = document.getElementById('account-user-avatar'); // <img> or <div data-initials>
const elSignOut        = document.getElementById('sign-out-btn');        // button
const elMarketingTgl   = document.getElementById('marketing-toggle');    // input[type="checkbox"] for “I’d like to receive marketing…”
const elEntriesList    = document.getElementById('entries-list');        // container to render rows/cards
const elEntriesError   = document.getElementById('entries-error');       // optional error placeholder
const elEntriesEmpty   = document.getElementById('entries-empty');       // optional empty-state node

// --- Utility: safe text setter ---
function setText(el, text) {
  if (!el) return;
  el.textContent = text ?? '';
}

// --- Utility: avatar renderer (initials fallback) ---
function renderAvatar(el, user) {
  if (!el || !user) return;

  const asImg = el.tagName?.toLowerCase() === 'img';
  const photo = user.photoURL;

  if (asImg) {
    if (photo) {
      el.src = photo;
      el.alt = user.displayName || user.email || 'User';
    } else {
      // no photo – show a generated initial via data URI (simple coloured circle with initial)
      const initial = (user.displayName || user.email || 'U').trim().charAt(0).toUpperCase();
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // background circle
      ctx.fillStyle = '#0E1116';
      ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.fill();
      // initial
      ctx.fillStyle = '#E0E3E7';
      ctx.font = 'bold 64px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(initial, size/2, size/2 + 4);
      el.src = canvas.toDataURL('image/png');
      el.alt = initial;
    }
    return;
  }

  // Non-IMG avatar element (e.g., a circle div) – prefer initials
  const initial = (user.displayName || user.email || 'U').trim().charAt(0).toUpperCase();
  el.setAttribute('data-initials', initial);
  if (photo) el.style.backgroundImage = `url("${photo}")`;
}

// --- Utility: date formatting ---
function fmtDate(ts) {
  // Accepts JS Date, Firestore Timestamp or ISO string
  try {
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  } catch {
    return '';
  }
}

// --- Render: single entry row/card ---
function renderEntryRow(entry) {
  const when = fmtDate(entry.createdAt);
  const title = entry.compTitle || entry.compName || entry.compId || 'Competition';
  const tickets = entry.tickets ?? entry.quantity ?? entry.ticketCount ?? 1;
  const numbers = Array.isArray(entry.ticketNumbers) ? entry.ticketNumbers.join(', ') : (entry.ticketNumber ?? '');

  return `
    <div class="entry-row">
      <div class="entry-main">
        <div class="entry-title">${escapeHtml(title)}</div>
        ${numbers ? `<div class="entry-numbers">Ticket(s): ${escapeHtml(numbers)}</div>` : ''}
      </div>
      <div class="entry-meta">
        <div class="entry-tickets">${tickets} ticket${tickets === 1 ? '' : 's'}</div>
        <div class="entry-date">${when}</div>
      </div>
    </div>
  `;
}

// --- Simple HTML escaper for dynamic content ---
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

// --- Entries: fetch and render for current user ---
async function loadUserEntries(uid, { alsoOrderByCreatedAt = false } = {}) {
  if (!elEntriesList) return;

  // Loading state (lightweight; replace with your skeleton markup if desired)
  elEntriesList.innerHTML = `
    <div class="entries-loading">Loading your entries…</div>
  `;
  if (elEntriesError) elEntriesError.style.display = 'none';
  if (elEntriesEmpty) elEntriesEmpty.style.display = 'none';

  try {
    // Build the collectionGroup query that matches security rules:
    // where('userId','==', uid)
    let q = query(
      collectionGroup(db, 'entries'),
      where('userId', '==', uid)
    );

    // If you want ordering, uncomment both this block AND add an index in Firestore:
    // q = query(
    //   collectionGroup(db, 'entries'),
    //   where('userId', '==', uid),
    //   orderBy('createdAt', 'desc')
    // );

    const snap = await getDocs(q);

    if (snap.empty) {
      elEntriesList.innerHTML = '';
      if (elEntriesEmpty) {
        elEntriesEmpty.style.display = '';
      } else {
        elEntriesList.innerHTML = `<div class="entries-empty">No entries yet.</div>`;
      }
      return;
    }

    const rows = [];
    snap.forEach(docSnap => {
      const data = docSnap.data();
      rows.push(renderEntryRow(data));
    });

    elEntriesList.innerHTML = rows.join('');
  } catch (err) {
    console.error('[Entries] Failed to load user entries:', err);
    if (elEntriesList) {
      elEntriesList.innerHTML = `<div class="error">Could not load your entries. ${escapeHtml(err.code || err.message || 'Error')}.</div>`;
    }
    if (elEntriesError) elEntriesError.style.display = '';
  }
}

// --- Profile: create (if missing) and load user's profile doc ---
async function ensureAndLoadUserProfile(user) {
  const userRef = doc(db, 'users', user.uid);

  try {
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      // Create a minimal profile; do NOT allow client to set isAdmin
      const payload = {
        uid: user.uid,
        email: user.email || null,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
        isAdmin: false,
        marketingOptIn: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      await setDoc(userRef, payload, { merge: true });
      return payload;
    }

    return snap.data();
  } catch (err) {
    console.error('[Profile] Failed to load/create user profile:', err);
    throw err;
  }
}

// --- Marketing toggle wiring ---
function wireMarketingToggle(user, profile) {
  if (!elMarketingTgl) return;

  // Initial state from profile
  const initial = !!profile?.marketingOptIn;
  elMarketingTgl.checked = initial;

  elMarketingTgl.addEventListener('change', async (e) => {
    const checked = !!e.currentTarget.checked;

    try {
      await updateDoc(doc(db, 'users', user.uid), {
        marketingOptIn: checked,
        updatedAt: serverTimestamp()
      });
      // Optional: reflect success
    } catch (err) {
      console.error('[Marketing] Failed to update preference:', err);
      // Roll back UI state on failure
      try { e.currentTarget.checked = !checked; } catch {}
      alert('Could not update your communication preferences. Please try again.');
    }
  });
}

// --- Sign out wiring ---
function wireSignOut() {
  if (!elSignOut) return;
  elSignOut.addEventListener('click', async () => {
    try {
      await signOut(auth);
      window.location.replace('/login.html');
    } catch (err) {
      console.error('[Auth] Sign-out failed:', err);
      alert('Sign out failed. Please try again.');
    }
  });
}

// --- Auth gate and page boot ---
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // Not signed in; kick to login
    window.location.replace('/login.html');
    return;
  }

  // Basic header/profile fill
  setText(elName, user.displayName || 'My Account');
  setText(elEmail, user.email || '');
  renderAvatar(elAvatar, user);

  // Ensure Firestore profile exists & load it
  let profile;
  try {
    profile = await ensureAndLoadUserProfile(user);
  } catch {
    // if this fails, we still want to try entries to avoid blanking the whole page
  }

  // Wire marketing toggle
  wireMarketingToggle(user, profile);

  // Load entries for this user
  await loadUserEntries(user.uid);

  // Wire sign-out
  wireSignOut();

  // Optional: ensure auth displayName stays in sync with profile displayName
  try {
    if (profile?.displayName && profile.displayName !== user.displayName) {
      await updateProfile(user, { displayName: profile.displayName });
      setText(elName, profile.displayName);
    }
  } catch (err) {
    // Non-fatal; log only
    console.debug('[Profile] Skipped auth profile sync:', err?.message);
  }
});

// --- End of file ---
