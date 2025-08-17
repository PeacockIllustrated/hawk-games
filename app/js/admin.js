'use strict';

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { 
    getFirestore, doc, getDoc, collection, addDoc, updateDoc, 
    serverTimestamp, Timestamp, getDocs, query, orderBy, where, 
    runTransaction, limit, setDoc 
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// Global State & DOM Elements
let allCompetitions = [];
const mainContentContainer = document.getElementById('admin-main-content');
const modalContainer = document.getElementById('modal-container');
const modalBody = document.getElementById('modal-body');

// --- Helper for safe element creation ---
function createElement(tag, options = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
        if (key === 'class') {
            const classes = Array.isArray(value) ? value : String(value).split(' ');
            classes.forEach(c => { if (c) el.classList.add(c); });
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

// --- App Initialization & Auth ---
onAuthStateChanged(auth, user => {
    const authWall = document.getElementById('auth-wall');
    if (user) {
        checkAdminStatus(user);
    } else {
        authWall.innerHTML = '';
        authWall.append(
            createElement('h2', { class: 'section-title', textContent: 'Access Denied' }),
            createElement('p', { style: { textAlign: 'center' }, textContent: 'You must be logged in as an administrator to view this page.' })
        );
    }
});

const checkAdminStatus = async (user) => {
    const userDocRef = doc(db, 'users', user.uid);
    const userDocSnap = await getDoc(userDocRef);
    if (userDocSnap.exists() && userDocSnap.data().isAdmin) {
        initializeAdminPage();
    } else {
        const authWall = document.getElementById('auth-wall');
        authWall.innerHTML = '';
        authWall.append(
            createElement('h2', { class: 'section-title', textContent: 'Access Denied' }),
            createElement('p', { style: { textAlign: 'center' }, textContent: 'You do not have administrative privileges.' })
        );
    }
};

function initializeAdminPage() {
    setupNavigation();
    setupModal();
    renderView('dashboard');
    document.getElementById('admin-menu-toggle').addEventListener('click', () => {
        document.querySelector('.admin-layout').classList.toggle('nav-open');
    });
}

// --- Navigation & View Rendering ---
function setupNavigation() {
    document.getElementById('admin-nav').addEventListener('click', (e) => {
        e.preventDefault();
        const link = e.target.closest('.admin-nav-link');
        if (!link || link.classList.contains('active')) return;
        document.querySelectorAll('.admin-nav-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        renderView(link.dataset.view);
        document.querySelector('.admin-layout').classList.remove('nav-open');
    });
}

function renderView(viewName) {
    mainContentContainer.innerHTML = '';
    switch (viewName) {
        case 'dashboard': renderDashboardView(); break;
        case 'create': renderCreateCompView(); break;
        case 'hero-comp': renderHeroCompView(); break;
        case 'token-comps': renderTokenCompsView(); break;
        case 'spinner-settings': renderSpinnerSettingsView(); break;
        case 'plinko-settings': renderPlinkoSettingsView(); break; // NEW VIEW
    }
}

// --- VIEW: Dashboard ---
function renderDashboardView() {
    const listContainer = createElement('div', { id: 'competition-list' }, [
        createElement('div', { class: 'placeholder', textContent: 'Loading competitions...' })
    ]);
    const panel = createElement('div', { class: 'content-panel' }, [
        createElement('h2', { textContent: 'All Competitions' }),
        listContainer
    ]);
    mainContentContainer.append(panel);
    loadAndRenderCompetitions(listContainer);
}

async function loadAndRenderCompetitions(listDiv) {
    try {
        const q = query(collection(db, "competitions"), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);
        allCompetitions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        listDiv.innerHTML = '';
        const fragment = document.createDocumentFragment();
        allCompetitions.forEach(comp => fragment.appendChild(renderCompetitionRow(comp)));
        listDiv.appendChild(fragment);

        listDiv.addEventListener('click', handleDashboardClick);
    } catch (error) {
        console.error("Error loading competitions:", error);
        listDiv.innerHTML = '';
        listDiv.append(createElement('p', { style: { color: 'red' }, textContent: 'Failed to load competitions. Check Firestore index and security rules.' }));
    }
}

function renderCompetitionRow(comp) {
    const progress = (comp.ticketsSold / comp.totalTickets) * 100;

    let titleBadges = [];
    if (comp.isHeroComp) {
        titleBadges.push(createElement('span', { class: ['title-badge', 'title-badge-hero'], textContent: '⭐ Hero Comp' }));
    } else {
        const type = comp.competitionType || 'main';
        switch(type) {
            case 'instant':
                titleBadges.push(createElement('span', { class: ['title-badge', 'title-badge-instant'], textContent: '⚡️ Instant Win' }));
                break;
            case 'token':
                titleBadges.push(createElement('span', { class: ['title-badge', 'title-badge-token'], textContent: '🎟️ Token Comp' }));
                break;
            case 'main':
            default:
                 titleBadges.push(createElement('span', { class: ['title-badge', 'title-badge-main'], textContent: 'Main Prize' }));
        }
    }
    
    let statusContent;
    if (comp.status === 'live') {
        statusContent = [
            createElement('div', { class: ['status-badge', 'status-live'], textContent: 'Live' }),
            createElement('div', { class: 'comp-actions' }, [
                createElement('button', { class: ['btn', 'btn-small', 'btn-secondary'], 'data-action': 'end' }, ['End Now']),
                createElement('button', { class: ['btn', 'btn-small', 'btn-secondary'], 'data-action': 'add-fer' }, ['Add Free Entry'])
            ])
        ];
    } else if (comp.status === 'drawn') {
        statusContent = [
            createElement('div', { class: ['status-badge', 'status-drawn'], textContent: 'Drawn' }),
            createElement('div', { class: 'comp-actions' }, [
                createElement('div', { class: 'winner-info', textContent: `Winner: ${comp.winnerDisplayName || 'N/A'}` })
            ])
        ];
    } else if (comp.status === 'ended') {
        statusContent = [
            createElement('div', { class: ['status-badge', 'status-ended'], textContent: 'Ended' }),
            createElement('div', { class: 'comp-actions' }, [
                createElement('button', { class: ['btn', 'btn-small', 'btn-primary'], 'data-action': 'draw-winner' }, ['Draw Winner'])
            ])
        ];
    } else if (comp.status === 'queued') {
         statusContent = [
            createElement('div', { class: ['status-badge', 'status-queued'], textContent: 'Queued' }),
            createElement('div', { class: 'comp-actions' }, [
                createElement('button', { class: ['btn', 'btn-small', 'btn-secondary'], 'data-action': 'activate' }, ['Activate Manually'])
            ])
        ];
    }

    return createElement('div', { class: 'competition-row', 'data-comp-id': comp.id }, [
        createElement('div', { class: 'comp-row-main' }, [
            createElement('h4', { class: 'comp-title' }, [comp.title, ' ', ...titleBadges]),
            createElement('div', { class: 'comp-progress-text', textContent: `${comp.ticketsSold || 0} / ${comp.totalTickets}` }),
            createElement('div', { class: 'progress-bar' }, [
                createElement('div', { class: 'progress-bar-fill', style: { width: `${progress}%` } })
            ])
        ]),
        createElement('div', { class: 'comp-row-status' }, statusContent)
    ]);
}

// --- VIEW: Create Main / Instant Comp ---
function renderCreateCompView() {
    const form = createCompetitionForm({
        type: 'main',
        title: 'Create Main or Instant Win Competition'
    });
    mainContentContainer.append(form);
    form.addEventListener('submit', (e) => handleCreateFormSubmit(e, 'main'));
}

// --- VIEW: Hero Competition ---
function renderHeroCompView() {
    const form = createCompetitionForm({
        type: 'hero',
        title: 'Manage Hero Competition'
    });
    mainContentContainer.append(form);
    // TODO: Load existing hero comp data into the form
    form.addEventListener('submit', (e) => handleCreateFormSubmit(e, 'hero'));
}

// --- VIEW: Token Competitions ---
function renderTokenCompsView() {
    const formPanel = createCompetitionForm({
        type: 'token',
        title: 'Create New Token Competition'
    });
    const queuePanel = createElement('div', {class: 'content-panel', style: {marginTop: '2rem'}}, [
        createElement('h2', {textContent: 'Live & Queued Token Competitions'}),
        createElement('div', {id: 'token-queue-list'})
    ]);

    mainContentContainer.append(formPanel, queuePanel);
    formPanel.addEventListener('submit', (e) => handleCreateFormSubmit(e, 'token'));
    loadAndRenderTokenQueue(document.getElementById('token-queue-list'));
}

async function loadAndRenderTokenQueue(listDiv) {
    listDiv.innerHTML = `<div class="placeholder">Loading queue...</div>`;
    try {
        const q = query(
            collection(db, "competitions"), 
            where("competitionType", "==", "token"),
            where("status", "in", ["queued", "live"]),
            orderBy("createdAt", "asc")
        );
        const snapshot = await getDocs(q);
        const comps = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        listDiv.innerHTML = '';
        if (comps.length === 0) {
            listDiv.append(createElement('div', {class: 'placeholder', textContent: 'No token competitions are live or queued.'}));
            return;
        }
        comps.forEach(comp => listDiv.append(renderCompetitionRow(comp)));
    } catch(err) {
        console.error("Error loading token queue:", err);
        listDiv.innerHTML = `<div class="placeholder" style="color:red">Failed to load queue.</div>`;
    }
}


// --- VIEW: Spinner Settings ---
function renderSpinnerSettingsView() {
    const prizesContainer = createElement('div', { id: 'spinner-prizes-container' });
    const addPrizeBtn = createElement('button', { type: 'button', id: 'add-spinner-prize-btn', class: ['btn', 'btn-secondary', 'btn-small'] }, ['Add Prize Tier']);
    const saveBtn = createElement('button', { type: 'submit', class: ['btn', 'btn-primary'] }, ['Save Spinner Settings']);

    const form = createElement('form', { id: 'spinner-settings-form', class: 'admin-form', style: { marginTop: '2rem' } }, [
        prizesContainer,
        addPrizeBtn,
        createElement('hr', { style: { borderColor: 'var(--border-color)', margin: '1.5rem 0' } }),
        saveBtn
    ]);

    const panel = createElement('div', { class: 'content-panel' }, [
        createElement('h2', { textContent: 'Spinner Prize Settings' }),
        createElement('p', { style: { padding: '1.5rem', borderBottom: '1px solid var(--border-color)' }, textContent: 'Define the prize pool for the global Spin Wheel game. The odds determine the probability of winning each prize on any given spin.'}),
        form
    ]);

    mainContentContainer.append(panel);
    initializeSpinnerSettingsListeners();
}

// --- NEW VIEW: Plinko Settings ---
function renderPlinkoSettingsView() {
    const payoutsContainer = createElement('div', {id: 'plinko-payouts-container', class: 'plinko-payouts-grid'});
    const saveBtn = createElement('button', { type: 'submit', class: ['btn', 'btn-primary'] }, ['Save Plinko Payouts']);

    const form = createElement('form', { id: 'plinko-settings-form', class: 'admin-form', style: { marginTop: '2rem' } }, [
        payoutsContainer,
        createElement('hr', { style: { borderColor: 'var(--border-color)', margin: '1.5rem 0' } }),
        saveBtn
    ]);

    const panel = createElement('div', { class: 'content-panel' }, [
        createElement('h2', { textContent: 'Plinko Prize Settings' }),
        createElement('p', { style: { padding: '1.5rem', borderBottom: '1px solid var(--border-color)' }, textContent: 'Define the site credit prize for each of the 13 landing slots (0-12) in the Plinko game. The distribution follows a binomial curve.'}),
        form
    ]);
    mainContentContainer.append(panel);
    initializePlinkoSettingsListeners();
}


// --- FORM CREATION & LOGIC ---
function createCompetitionForm({ type, title }) {
    const isMain = type === 'main';
    const isHero = type === 'hero';
    const isToken = type === 'token';

    const tiersContainer = createElement('div', { id: 'ticket-tiers-container' });
    const addTierBtn = createElement('button', { type: 'button', class: ['btn', 'btn-secondary', 'btn-small'] }, ['Add Tier']);
    
    const form = createElement('form', { class: 'admin-form' }, [
        createElement('fieldset', {}, [
            createElement('legend', { textContent: 'Core Details' }),
            createElement('div', { class: 'form-group' }, [createElement('label', { for: 'title', textContent: 'Competition Title' }), createElement('input', { type: 'text', id: 'title', required: true })]),
            isHero && createElement('div', { class: 'form-group' }, [createElement('label', { for: 'prizeImage', textContent: 'Main Image URL' }), createElement('input', { type: 'url', id: 'prizeImage', required: true })])
        ]),
        createElement('fieldset', {}, [
            createElement('legend', { textContent: 'Competition Details' }),
            createElement('div', { class: 'form-group-inline' }, [
                !isToken && createElement('div', { class: 'form-group' }, [createElement('label', { for: 'totalTickets', textContent: 'Total Tickets' }), createElement('input', { type: 'number', id: 'totalTickets', required: !isToken })]),
                createElement('div', { class: 'form-group' }, [createElement('label', { for: 'userEntryLimit', textContent: 'Max Entries Per User' }), createElement('input', { type: 'number', id: 'userEntryLimit', value: '75', required: true })])
            ].filter(Boolean)),
            createElement('div', { class: 'form-group-inline' }, [
                createElement('div', { class: 'form-group' }, [createElement('label', { for: 'cashAlternative', textContent: 'Prize / Cash Alt (£)' }), createElement('input', { type: 'number', id: 'cashAlternative', required: true })]),
                !isToken && createElement('div', { class: 'form-group', id: 'end-date-group' }, [createElement('label', { for: 'endDate', textContent: 'End Date & Time' }), createElement('input', { type: 'datetime-local', id: 'endDate', required: !isToken })])
            ].filter(Boolean))
        ]),
        createElement('fieldset', {}, [createElement('legend', { textContent: 'Ticket Pricing' }), tiersContainer, addTierBtn]),
        isMain && createElement('fieldset', {}, [
            createElement('legend', {textContent: 'Competition Sub-Type'}),
            createElement('div', {class: 'admin-radio-group'}, [
                createElement('label', {}, [ createElement('input', { type: 'radio', name: 'mainSubType', value: 'main', checked: true }), 'Standard Main Competition' ]),
                createElement('label', {}, [ createElement('input', { type: 'radio', name: 'mainSubType', value: 'instant' }), 'Main Competition + Instant Win Tokens' ]),
            ])
        ]),
        createElement('fieldset', {}, [
            createElement('legend', { textContent: 'Skill Question' }),
            createElement('div', { class: 'form-group' }, [createElement('label', { for: 'questionText', textContent: 'Question' }), createElement('input', { type: 'text', id: 'questionText', required: true })]),
            createElement('div', { class: 'form-group-inline' }, [
                createElement('div', { class: 'form-group' }, [createElement('label', { for: 'correctAnswer', textContent: 'Correct Answer' }), createElement('input', { type: 'text', id: 'correctAnswer', required: true })]),
                createElement('div', { class: 'form-group' }, [createElement('label', { for: 'otherAnswers', textContent: 'Incorrect Answers (comma separated)' }), createElement('input', { type: 'text', id: 'otherAnswers', required: true })])
            ])
        ]),
        createElement('button', { type: 'submit', class: ['btn', 'btn-primary'] }, [ isHero ? 'Save Hero Competition' : 'Create Competition' ])
    ]);

    const addTier = () => {
        const removeBtn = createElement('button', { type: 'button', class: 'btn-remove-tier', textContent: '×' });
        const tierEl = createElement('div', { class: ['form-group-inline', 'ticket-tier-row'] }, [
            createElement('div', { class: 'form-group' }, [createElement('label', { textContent: 'Tickets' }), createElement('input', { type: 'number', class: 'tier-amount', required: true })]),
            createElement('div', { class: 'form-group' }, [createElement('label', { textContent: 'Price (£)' }), createElement('input', { type: 'number', step: '0.01', class: 'tier-price', required: true })]),
            removeBtn
        ]);
        tiersContainer.appendChild(tierEl);
        removeBtn.addEventListener('click', () => tierEl.remove());
    };
    addTierBtn.addEventListener('click', addTier);
    addTier();

    return createElement('div', { class: 'content-panel' }, [
        createElement('h2', { textContent: title }),
        form
    ]);
}

async function handleCreateFormSubmit(e, formType) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
        let competitionType = formType;
        if (formType === 'main') {
            competitionType = form.querySelector('input[name="mainSubType"]:checked').value;
        }

        const isHeroComp = formType === 'hero';
        const instantWinsEnabled = ['instant', 'hero', 'token'].includes(competitionType);
        
        let status = 'live';
        
        const title = form.querySelector('#title').value;
        const totalTickets = competitionType === 'token' ? 1000000 : parseInt(form.querySelector('#totalTickets').value);
        const userEntryLimit = parseInt(form.querySelector('#userEntryLimit').value);
        const cashAlternative = parseFloat(form.querySelector('#cashAlternative').value);
        
        const correctAnswerText = form.querySelector('#correctAnswer').value.trim();
        const otherAnswersText = form.querySelector('#otherAnswers').value.split(',').map(a => a.trim());
        const allAnswersArray = [correctAnswerText, ...otherAnswersText].sort(() => Math.random() - 0.5);
        
        const answersObject = {};
        let correctKey = '';
        ['A', 'B', 'C', 'D'].slice(0, allAnswersArray.length).forEach((key, index) => {
            answersObject[key] = allAnswersArray[index];
            if (allAnswersArray[index] === correctAnswerText) { correctKey = key; }
        });

        const ticketTiers = Array.from(form.querySelectorAll('.ticket-tier-row')).map(row => ({
            amount: parseInt(row.querySelector('.tier-amount').value),
            price: parseFloat(row.querySelector('.tier-price').value)
        }));
        
        const competitionPayload = {
            title, totalTickets, userEntryLimit, cashAlternative,
            ticketsSold: 0,
            status,
            createdAt: serverTimestamp(),
            competitionType,
            isHeroComp,
            instantWinsConfig: { enabled: instantWinsEnabled },
            skillQuestion: {
                text: form.querySelector('#questionText').value,
                answers: answersObject,
                correctAnswer: correctKey
            },
            ticketTiers,
            prizeImage: form.querySelector('#prizeImage')?.value || 'assets/logo-icon.png',
        };
        
        if (competitionType !== 'token') {
             competitionPayload.endDate = Timestamp.fromDate(new Date(form.querySelector('#endDate').value));
        }

        await addDoc(collection(db, 'competitions'), competitionPayload);
        
        alert(`Competition "${title}" created successfully.`);
        form.reset();
        renderView(formType === 'token' ? 'token-comps' : 'dashboard');

    } catch (error) {
        console.error("Error creating competition:", error);
        alert(`Failed to create competition: ${error.message}`);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isHeroComp ? 'Save Hero Competition' : 'Create Competition';
    }
}

function initializeSpinnerSettingsListeners() {
    const form = document.getElementById('spinner-settings-form');
    const prizesContainer = document.getElementById('spinner-prizes-container');
    const addPrizeBtn = document.getElementById('add-spinner-prize-btn');
    const addPrizeTier = (type = 'credit', value = '', odds = '') => {
        const removeBtn = createElement('button', { type: 'button', class: 'btn-remove-tier', textContent: '×' });
        const prizeEl = createElement('div', { class: ['form-group-inline', 'spinner-prize-row'] }, [
            createElement('div', { class: 'form-group', style: { flex: '1' } }, [
                createElement('label', { textContent: 'Prize Type' }),
                createElement('select', { class: 'spinner-prize-type' }, [
                    createElement('option', { value: 'credit', textContent: 'Site Credit' }),
                    createElement('option', { value: 'cash', textContent: 'Cash' })
                ])
            ]),
            createElement('div', { class: 'form-group', style: { flex: '1' } }, [createElement('label', { textContent: 'Value (£)' }), createElement('input', { type: 'number', step: '0.01', class: 'spinner-prize-value', value: value, required: true })]),
            createElement('div', { class: 'form-group', style: { flex: '1' } }, [createElement('label', { textContent: 'Odds (1 in X)' }), createElement('input', { type: 'number', class: 'spinner-prize-odds', value: odds, required: true })]),
            removeBtn
        ]);
        prizeEl.querySelector('.spinner-prize-type').value = type;
        prizesContainer.appendChild(prizeEl);
        removeBtn.addEventListener('click', () => { prizeEl.remove(); });
    };

function initializePlinkoSettingsListeners() {
    const form = document.getElementById('plinko-settings-form');
    const payoutsContainer = document.getElementById('plinko-payouts-container');
    const PLINKO_SLOTS = 13; // 0 to 12

    const renderInputs = (payouts = []) => {
        payoutsContainer.innerHTML = '';
        for (let i = 0; i < PLINKO_SLOTS; i++) {
            const val = payouts[i] !== undefined ? payouts[i] : 0;
            const inputGroup = createElement('div', {class: 'form-group'}, [
                createElement('label', {textContent: `Slot ${i} Payout (£)`}),
                createElement('input', { type: 'number', 'data-slot': i, class: 'plinko-payout-input', value: val.toFixed(2), step: '0.01', required: true })
            ]);
            payoutsContainer.append(inputGroup);
        }
    };

    const loadSettings = async () => {
        const settingsRef = doc(db, 'admin_settings', 'plinkoPrizes');
        const docSnap = await getDoc(settingsRef);
        if (docSnap.exists() && docSnap.data().payouts) {
            renderInputs(docSnap.data().payouts);
        } else {
            // Default binomial-like distribution if nothing is set
            renderInputs([0, 0.20, 0.50, 1, 2, 5, 10, 5, 2, 1, 0.50, 0.20, 0]);
        }
    };
    loadSettings();
    
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        try {
            const inputs = Array.from(payoutsContainer.querySelectorAll('.plinko-payout-input'));
            const payouts = inputs.map(input => parseFloat(input.value) || 0);
            await setDoc(doc(db, 'admin_settings', 'plinkoPrizes'), { payouts });
            alert('Plinko payouts saved successfully!');
        } catch (error) {
            console.error('Error saving plinko payouts:', error);
            alert('Error: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Plinko Payouts';
        }
    });
}


// --- Re-pasting unchanged functions for completeness ---

    addPrizeBtn.addEventListener('click', () => addPrizeTier());
    const loadSettings = async () => { 
        const defaultsRef = doc(db, 'admin_settings', 'spinnerPrizes');
        const docSnap = await getDoc(defaultsRef);
        prizesContainer.innerHTML = '';
        if (docSnap.exists() && docSnap.data().prizes) {
            docSnap.data().prizes.forEach(p => addPrizeTier(p.type, p.value, p.odds));
        }
        if (prizesContainer.children.length === 0) addPrizeTier();
    };
    loadSettings();
    form.addEventListener('submit', async (e) => { 
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        try {
            const prizes = Array.from(document.querySelectorAll('.spinner-prize-row')).map(row => ({
                type: row.querySelector('.spinner-prize-type').value,
                value: parseFloat(row.querySelector('.spinner-prize-value').value),
                odds: parseInt(row.querySelector('.spinner-prize-odds').value)
            }));
            const defaultsRef = doc(db, 'admin_settings', 'spinnerPrizes');
            await setDoc(defaultsRef, { prizes });
            alert('Spinner settings saved successfully!');
        } catch (error) {
            console.error('Error saving spinner settings:', error);
            alert('Error: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Spinner Settings';
        }
    });
}
function handleDashboardClick(e) { 
    const button = e.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;
    const compRow = button.closest('.competition-row');
    const compId = compRow?.dataset.compId;
    if (!action || !compId) return;
    button.disabled = true;
    if (action === 'add-fer') {
        showAddFerModal(compId);
        button.disabled = false; 
    } else if (action === 'end') {
        handleEndCompetition(compId, button);
    } else if (action === 'draw-winner') {
        handleDrawWinner(compId, button);
    }
}
async function handleEndCompetition(compId, button) { 
    if (!confirm('Are you sure you want to end this competition? This cannot be undone.')) {
        button.disabled = false;
        return;
    }
    try {
        const compRef = doc(db, 'competitions', compId);
        await updateDoc(compRef, { status: 'ended' });
        alert('Competition has been ended.');
        renderView('dashboard');
    } catch (error) {
        console.error('Error ending competition:', error);
        alert(`Error: ${error.message}`);
        button.disabled = false;
    }
}
async function handleDrawWinner(compId, button) { 
    if (!confirm('This will draw a winner and publicly announce them. Are you absolutely sure?')) {
        button.disabled = false;
        return;
    }
    button.textContent = 'Drawing...';
    try {
        const drawWinner = httpsCallable(functions, 'drawWinner');
        const result = await drawWinner({ compId });
        if (result.data.success) {
            alert(`🎉 Winner Drawn! 🎉\n\nWinner: ${result.data.winnerDisplayName}\nTicket: #${result.data.winningTicketNumber}`);
            renderView('dashboard');
        } else {
            throw new Error(result.data.message || 'The draw failed for an unknown reason.');
        }
    } catch (error) {
        console.error('Error drawing winner:', error);
        alert(`Draw Failed: ${error.message}`);
        button.disabled = false;
        button.textContent = 'Draw Winner';
    }
}
function showAddFerModal(compId) {
    const comp = allCompetitions.find(c => c.id === compId);
    if (!comp) return;
    const form = createElement('form', { id: 'fer-form', class: 'modal-form' }, [
        createElement('div', { class: 'form-group' }, [createElement('label', { for: 'fer-email', textContent: "User's Email" }), createElement('input', { type: 'email', id: 'fer-email', required: true, placeholder: 'user@example.com' })]),
        createElement('div', { class: 'form-group' }, [createElement('label', { for: 'fer-tickets', textContent: 'Number of Entries' }), createElement('input', { type: 'number', id: 'fer-tickets', required: true, value: '1', min: '1' })]),
        createElement('div', { class: 'modal-actions' }, [
            createElement('button', { type: 'button', class: ['btn', 'btn-secondary'], id: 'modal-cancel-btn' }, ['Cancel']),
            createElement('button', { type: 'submit', class: 'btn' }, ['Add Entry'])
        ])
    ]);
    const content = createElement('div', {}, [
        createElement('h2', { textContent: 'Add Free Entry for:' }),
        createElement('h3', { textContent: comp.title }),
        form
    ]);
    openModal(content);
    form.addEventListener('submit', (e) => handleAddFerSubmit(e, compId));
    document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
}
async function handleAddFerSubmit(e, compId) { 
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const userEmail = form.querySelector('#fer-email').value;
    const ticketsToAdd = parseInt(form.querySelector('#fer-tickets').value);
    try {
        const usersRef = collection(db, 'users');
        const q = query(usersRef, where("email", "==", userEmail), limit(1));
        const userSnapshot = await getDocs(q);
        if (userSnapshot.empty) throw new Error(`User with email ${userEmail} not found.`);
        const userDoc = userSnapshot.docs[0];
        const userId = userDoc.id;
        await runTransaction(db, async (transaction) => {
            const competitionRef = doc(db, 'competitions', compId);
            const userRef = doc(db, 'users', userId);
            const compDoc = await transaction.get(competitionRef);
            if (!compDoc.exists()) throw new Error("Competition not found.");
            const compData = compDoc.data();
            const userData = userDoc.data();
            if (compData.status !== 'live') throw new Error("This competition is no longer live.");
            const userEntryCount = userData.entryCount?.[compId] || 0;
            const entryLimit = compData.userEntryLimit || 75;
            if (userEntryCount + ticketsToAdd > entryLimit) {
                throw new Error(`Entry limit exceeded. User has ${entryLimit - userEntryCount} entries remaining.`);
            }
            const ticketsSoldBefore = compData.ticketsSold || 0;
            if (ticketsSoldBefore + ticketsToAdd > compData.totalTickets) throw new Error("Not enough tickets available.");
            transaction.update(competitionRef, { ticketsSold: ticketsSoldBefore + ticketsToAdd });
            transaction.update(userRef, { [`entryCount.${compId}`]: userEntryCount + ticketsToAdd });
            const entryRef = doc(collection(competitionRef, 'entries'));
            transaction.set(entryRef, {
                userId: userId, 
                userDisplayName: userData.displayName, 
                ticketsBought: ticketsToAdd, 
                ticketStart: ticketsSoldBefore,
                ticketEnd: ticketsSoldBefore + ticketsToAdd -1,
                enteredAt: serverTimestamp(), 
                entryType: 'free_postal'
            });
        });
        alert('Free entry added successfully!');
        closeModal();
        renderView('dashboard');
    } catch (error) {
        console.error("FER Error:", error);
        alert(`Error: ${error.message}`);
        submitBtn.disabled = false;
    }
}
function setupModal() {
    modalContainer.addEventListener('click', (e) => {
        if (e.target === modalContainer) closeModal();
    });
}
function openModal(content) {
    modalBody.innerHTML = '';
    if (typeof content === 'string') {
        modalBody.innerHTML = content;
    } else {
        modalBody.append(content);
    }
    modalContainer.classList.add('show');
}
function closeModal() {
    modalContainer.classList.remove('show');
}
