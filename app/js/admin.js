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
        case 'spinner-settings': renderSpinnerSettingsView(); break;
    }
}

function renderDashboardView() {
    const listContainer = createElement('div', { id: 'competition-list' }, [
        createElement('div', { class: 'placeholder', textContent: 'Loading competitions...' })
    ]);
    const panel = createElement('div', { class: 'content-panel' }, [
        createElement('h2', { textContent: 'Manage Competitions' }),
        listContainer
    ]);
    mainContentContainer.append(panel);
    loadAndRenderCompetitions(listContainer);
}

function renderCreateCompView() {
    const tiersContainer = createElement('div', { id: 'ticket-tiers-container' });
    const addTierBtn = createElement('button', { type: 'button', id: 'add-tier-btn', class: ['btn', 'btn-secondary', 'btn-small'] }, ['Add Tier']);
    
    const parallaxImageGroup = createElement('div', { id: 'parallax-image-group', style: { display: 'none' } }, [
        createElement('div', { class: 'form-group' }, [createElement('label', { for: 'prizeImageBg', textContent: 'Background Image URL (e.g., storm)' }), createElement('input', { type: 'url', id: 'prizeImageBg' })]),
        createElement('div', { class: 'form-group' }, [createElement('label', { for: 'prizeImageFg', textContent: 'Foreground Image URL (e.g., car)' }), createElement('input', { type: 'url', id: 'prizeImageFg' })]),
        createElement('div', { class: 'form-group' }, [createElement('label', { for: 'prizeImageThumb', textContent: 'Thumbnail URL (for mobile & homepage card)' }), createElement('input', { type: 'url', id: 'prizeImageThumb' })])
    ]);

    const form = createElement('form', { id: 'create-comp-form', class: 'admin-form' }, [
        createElement('fieldset', {}, [
            createElement('legend', { textContent: 'Core Details' }),
            createElement('div', { class: 'form-group' }, [createElement('label', { for: 'title', textContent: 'Competition Title' }), createElement('input', { type: 'text', id: 'title', required: true })])
        ]),
        createElement('fieldset', {}, [
            createElement('legend', { textContent: 'Image Setup' }),
            createElement('div', { class: 'form-group', id: 'main-image-group' }, [createElement('label', { for: 'prizeImage', textContent: 'Main Image URL' }), createElement('input', { type: 'url', id: 'prizeImage' })]),
            createElement('div', { class: 'form-group-inline' }, [
                createElement('label', { for: 'hasParallax', style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [ 'Use Parallax Hero Image?', createElement('input', { type: 'checkbox', id: 'hasParallax', style: { width: 'auto', height: 'auto' } })])
            ]),
            parallaxImageGroup
        ]),
        createElement('fieldset', {}, [
            createElement('legend', { textContent: 'Competition Details' }),
            createElement('div', { class: 'form-group-inline' }, [
                createElement('div', { class: 'form-group' }, [createElement('label', { for: 'totalTickets', textContent: 'Total Tickets' }), createElement('input', { type: 'number', id: 'totalTickets', required: true })]),
                createElement('div', { class: 'form-group' }, [createElement('label', { for: 'userEntryLimit', textContent: 'Max Entries Per User' }), createElement('input', { type: 'number', id: 'userEntryLimit', value: '75', required: true })])
            ]),
            createElement('div', { class: 'form-group-inline' }, [
                createElement('div', { class: 'form-group' }, [createElement('label', { for: 'cashAlternative', textContent: 'Cash Alternative (£)' }), createElement('input', { type: 'number', id: 'cashAlternative', required: true })]),
                createElement('div', { class: 'form-group', id: 'end-date-group' }, [createElement('label', { for: 'endDate', textContent: 'End Date & Time' }), createElement('input', { type: 'datetime-local', id: 'endDate', required: true })])
            ]),
             createElement('div', { id: 'token-comp-notice', class: 'form-hint', style: { display: 'none', marginTop: '1rem', color: '#888' }, textContent: "End date is not required. Token competitions run weekly and are managed automatically by the system."})
        ]),
        createElement('fieldset', {}, [createElement('legend', { textContent: 'Ticket Pricing' }), tiersContainer, addTierBtn]),
        createElement('fieldset', {}, [
            createElement('legend', { textContent: 'Competition Type' }),
            createElement('div', { class: 'admin-radio-group' }, [
                createElement('label', {}, [ createElement('input', { type: 'radio', name: 'competitionType', value: 'main', checked: true }), 'Main Prize Competition' ]),
                createElement('label', {}, [ createElement('input', { type: 'radio', name: 'competitionType', value: 'instant' }), 'Main Prize + Instant Win Tokens' ]),
                createElement('label', {}, [ createElement('input', { type: 'radio', name: 'competitionType', value: 'hero' }), 'Hero Competition (+ Instant Win Tokens)' ]),
                createElement('label', {}, [ createElement('input', { type: 'radio', name: 'competitionType', value: 'token' }), 'Token Competition (Weekly Recurring)' ])
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
        createElement('button', { type: 'submit', class: ['btn', 'btn-primary'] }, ['Create Competition'])
    ]);

    const panel = createElement('div', { class: 'content-panel' }, [
        createElement('h2', { textContent: 'Create New Competition' }),
        form
    ]);

    mainContentContainer.append(panel);
    initializeCreateFormListeners();
}

function renderSpinnerSettingsView() {
    const prizesContainer = createElement('div', { id: 'spinner-prizes-container' });
    const addPrizeBtn = createElement('button', { type: 'button', id: 'add-spinner-prize-btn', class: ['btn', 'btn-secondary', 'btn-small'] }, ['Add Prize Tier']);
    const rtpDisplay = createElement('div', { class: 'rtp-display' }, ['Total RTP: ', createElement('strong', { id: 'total-rtp-display', textContent: '0.00%' })]);
    const saveBtn = createElement('button', { type: 'submit', class: ['btn', 'btn-primary'] }, ['Save Spinner Settings']);

    const form = createElement('form', { id: 'spinner-settings-form', class: 'admin-form', style: { marginTop: '2rem' } }, [
        prizesContainer,
        addPrizeBtn,
        rtpDisplay,
        createElement('hr', { style: { borderColor: 'var(--border-color)', margin: '1.5rem 0' } }),
        saveBtn
    ]);

    const panel = createElement('div', { class: 'content-panel' }, [
        createElement('h2', { textContent: 'Spinner Prize Settings' }),
        createElement('p', { style: { padding: '1.5rem', borderBottom: '1px solid var(--border-color)' }, textContent: 'Define the prize pool for the global Spin Wheel game. The odds determine the probability of winning each prize on any given spin. The total RTP (Return to Player) shows the average percentage of revenue paid out as prizes.'}),
        form
    ]);

    mainContentContainer.append(panel);
    initializeSpinnerSettingsListeners();
}

// --- Data Fetching & Rendering Logic ---
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
    const type = comp.competitionType || 'main'; // Default to 'main' for legacy comps
    switch(type) {
        case 'hero':
            titleBadges.push(createElement('span', { class: ['title-badge', 'title-badge-hero'], textContent: '⭐ Hero Comp' }));
            break;
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

// --- Event Listener Initialization ---
function initializeCreateFormListeners() {
    const form = document.getElementById('create-comp-form');
    const addTierBtn = document.getElementById('add-tier-btn');
    const tiersContainer = document.getElementById('ticket-tiers-container');
    const hasParallaxCheck = document.getElementById('hasParallax');
    const endDateGroup = document.getElementById('end-date-group');
    const totalTicketsInput = document.getElementById('totalTickets');
    const tokenCompNotice = document.getElementById('token-comp-notice');

    form.elements.competitionType.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const isTokenComp = e.target.value === 'token';
            endDateGroup.style.display = isTokenComp ? 'none' : 'block';
            endDateGroup.querySelector('input').required = !isTokenComp;
            tokenCompNotice.style.display = isTokenComp ? 'block' : 'none';
            if (isTokenComp) {
                totalTicketsInput.value = 1000000;
            }
        });
    });
    
    hasParallaxCheck.addEventListener('change', (e) => {
        const mainImageGroup = document.getElementById('main-image-group');
        const parallaxImageGroup = document.getElementById('parallax-image-group');
        mainImageGroup.style.display = e.target.checked ? 'none' : 'block';
        parallaxImageGroup.style.display = e.target.checked ? 'block' : 'none';
    });

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
    
    form.addEventListener('submit', handleCreateFormSubmit);
}

async function handleCreateFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
        const competitionType = form.querySelector('input[name="competitionType"]:checked').value;
        
        let status = 'queued';
        // If this is the VERY FIRST token comp, make it live immediately.
        if (competitionType === 'token') {
            const q = query(collection(db, 'competitions'), where('competitionType', '==', 'token'), where('status', '==', 'live'), limit(1));
            const liveTokenComps = await getDocs(q);
            if (liveTokenComps.empty) {
                status = 'live';
            }
        } else {
             status = 'live'; // All other comps go live immediately
        }

        const title = form.querySelector('#title').value;
        const totalTickets = parseInt(form.querySelector('#totalTickets').value);
        const userEntryLimit = parseInt(form.querySelector('#userEntryLimit').value);
        const cashAlternative = parseFloat(form.querySelector('#cashAlternative').value);
        const isHeroComp = competitionType === 'hero';
        const instantWinsEnabled = ['instant', 'hero', 'token'].includes(competitionType);
        
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
            prizeImage: form.querySelector('#prizeImage').value || null,
        };
        
        if (competitionType !== 'token') {
             competitionPayload.endDate = Timestamp.fromDate(new Date(form.querySelector('#endDate').value));
        }

        const docRef = await addDoc(collection(db, 'competitions'), competitionPayload);
        
        alert(`Competition "${title}" created successfully with ID: ${docRef.id}`);
        form.reset();
        renderView('dashboard');

    } catch (error) {
        console.error("Error creating competition:", error);
        alert(`Failed to create competition: ${error.message}`);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Competition';
    }
}

function initializeSpinnerSettingsListeners() {
    const form = document.getElementById('spinner-settings-form');
    const prizesContainer = document.getElementById('spinner-prizes-container');
    const addPrizeBtn = document.getElementById('add-spinner-prize-btn');
    const rtpDisplay = document.getElementById('total-rtp-display');

    const calculateRTP = () => {
        let totalRTP = 0;
        prizesContainer.querySelectorAll('.spinner-prize-row').forEach(row => {
            const value = parseFloat(row.querySelector('.spinner-prize-value').value) || 0;
            const odds = parseInt(row.querySelector('.spinner-prize-odds').value) || 0;
            if (value > 0 && odds > 0) totalRTP += (value / odds);
        });
        rtpDisplay.textContent = `${((totalRTP / 1.00) * 100).toFixed(2)}%`;
    };

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
        removeBtn.addEventListener('click', () => { prizeEl.remove(); calculateRTP(); });
    };

    prizesContainer.addEventListener('input', calculateRTP);
    addPrizeBtn.addEventListener('click', () => addPrizeTier());

    const loadSettings = async () => { 
        const defaultsRef = doc(db, 'admin_settings', 'spinnerPrizes');
        const docSnap = await getDoc(defaultsRef);
        prizesContainer.innerHTML = '';
        if (docSnap.exists() && docSnap.data().prizes) {
            docSnap.data().prizes.forEach(p => addPrizeTier(p.type, p.value, p.odds));
        }
        if (prizesContainer.children.length === 0) addPrizeTier();
        calculateRTP();
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

// --- Event Handlers & Modal Logic ---
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
