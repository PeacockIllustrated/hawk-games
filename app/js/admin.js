import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, addDoc, updateDoc, serverTimestamp, Timestamp, getDocs, query, orderBy, where, runTransaction, limit, setDoc } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
import { app } from './auth.js';

const auth = getAuth(app);
const db = getFirestore(app);

// Global State & DOM Elements
let allCompetitions = [];
const mainContentContainer = document.getElementById('admin-main-content');
const modalContainer = document.getElementById('modal-container');
const modalBody = document.getElementById('modal-body');

// HTML Templates for Dynamic Views
const dashboardViewHTML = `
    <div class="content-panel">
        <h2>Manage Competitions</h2>
        <div id="competition-list"><div class="placeholder">Loading competitions...</div></div>
    </div>`;

const createCompViewHTML = `
    <div class="content-panel">
        <h2>Create New Main Competition</h2>
        <form id="create-comp-form" class="admin-form">
            <fieldset><legend>Core Details</legend>
                <div class="form-group"><label for="title">Competition Title</label><input type="text" id="title" required></div>
                <div class="form-group"><label for="prizeImage">Prize Image URL</label><input type="url" id="prizeImage" required></div>
                <div class="form-group-inline">
                    <div class="form-group"><label for="totalTickets">Total Tickets</label><input type="number" id="totalTickets" required></div>
                    <div class="form-group"><label for="userEntryLimit">Max Entries Per User</label><input type="number" id="userEntryLimit" value="75" required></div>
                </div>
                <div class="form-group-inline">
                    <div class="form-group"><label for="cashAlternative">Cash Alternative (£)</label><input type="number" id="cashAlternative" required></div>
                    <div class="form-group"><label for="endDate">End Date & Time</label><input type="datetime-local" id="endDate" required></div>
                </div>
            </fieldset>
            <fieldset><legend>Ticket Pricing</legend><div id="ticket-tiers-container"></div><button type="button" id="add-tier-btn" class="btn btn-secondary btn-small">Add Tier</button></fieldset>
            
            <fieldset><legend>Bonus Spin Tokens</legend>
                <div class="form-group-inline">
                    <label for="enable-spin-tokens" style="display:flex; align-items: center; gap: 10px;">
                        Award 1 Bonus Spin Token per ticket purchased?
                        <input type="checkbox" id="enable-spin-tokens" style="width:auto; height:auto;">
                    </label>
                </div>
                 <p class="form-hint" style="font-size: 0.8rem; color: #888; margin-top: 0.5rem;">
                    Check this to award tokens. The Spinner Game itself is configured in the "Spinner Settings" tab.
                 </p>
            </fieldset>

            <fieldset><legend>Skill Question</legend>
                <div class="form-group"><label for="questionText">Question</label><input type="text" id="questionText" required></div>
                <div class="form-group-inline">
                    <div class="form-group"><label for="correctAnswer">Correct Answer</label><input type="text" id="correctAnswer" required></div>
                    <div class="form-group"><label for="otherAnswers">Incorrect Answers (comma separated)</label><input type="text" id="otherAnswers" required></div>
                </div>
            </fieldset>
            <button type="submit" class="btn btn-primary">Create Competition</button>
        </form>
    </div>`;

const spinnerSettingsViewHTML = `
    <div class="content-panel">
        <h2>Spinner Prize Settings</h2>
        <p>Define the prize pool for the global Spin Wheel game. The odds determine the probability of winning each prize on any given spin. The total RTP (Return to Player) shows the average percentage of revenue paid out as prizes.</p>
        <form id="spinner-settings-form" class="admin-form" style="margin-top: 2rem;">
            <div id="spinner-prizes-container">
                 <!-- JS will populate this -->
            </div>
            <button type="button" id="add-spinner-prize-btn" class="btn btn-secondary btn-small">Add Prize Tier</button>
            <div class="rtp-display">
                Total RTP: <strong id="total-rtp-display">0.00%</strong>
            </div>
            <hr style="border-color: var(--border-color); margin: 1.5rem 0;">
            <button type="submit" class="btn btn-primary">Save Spinner Settings</button>
        </form>
    </div>`;

const spinnerCompsViewHTML = `
    <div class="content-panel">
        <h2>Manage Spinner Competition</h2>
        <p>This is the always-on, low-stakes competition that users enter to receive bonus spin tokens. You only need one active at a time.</p>
        <form id="spinner-comp-form" class="admin-form" style="margin-top: 2rem;">
            <input type="hidden" id="spinner-comp-id" value="active">
            <fieldset>
                <legend>Competition Details</legend>
                <div class="form-group"><label for="spinner-title">Title</label><input type="text" id="spinner-title" required value="Weekly £50 Spinner Draw"></div>
                <div class="form-group"><label for="spinner-prize">Prize Description</label><input type="text" id="spinner-prize" required value="£50 Cash"></div>
            </fieldset>
            <fieldset>
                <legend>Skill Question</legend>
                <div class="form-group"><label for="spinner-questionText">Question</label><input type="text" id="spinner-questionText" required></div>
                <div class="form-group-inline">
                    <div class="form-group"><label for="spinner-correctAnswer">Correct Answer</label><input type="text" id="spinner-correctAnswer" required></div>
                    <div class="form-group"><label for="spinner-otherAnswers">Incorrect Answers (comma separated)</label><input type="text" id="spinner-otherAnswers" required></div>
                </div>
            </fieldset>
            <button type="submit" class="btn btn-primary">Save Spinner Competition</button>
        </form>
    </div>`;


// Admin Gatekeeper and Page Initialization
onAuthStateChanged(auth, user => {
    const authWall = document.getElementById('auth-wall');
    if (user) {
        checkAdminStatus(user);
    } else {
        authWall.innerHTML = `<h2 class="section-title">Access Denied</h2><p style="text-align:center;">You must be logged in as an administrator to view this page.</p>`;
    }
});

const checkAdminStatus = async (user) => {
    const userDocRef = doc(db, 'users', user.uid);
    const userDocSnap = await getDoc(userDocRef);
    if (userDocSnap.exists() && userDocSnap.data().isAdmin) {
        initializeAdminPage();
    } else {
        document.getElementById('auth-wall').innerHTML = `<h2 class="section-title">Access Denied</h2><p style="text-align:center;">You do not have administrative privileges.</p>`;
    }
};

function initializeAdminPage() {
    setupNavigation();
    setupModal();
    renderView('dashboard');
}

function setupNavigation() {
    document.getElementById('admin-nav').addEventListener('click', (e) => {
        e.preventDefault();
        const link = e.target.closest('.admin-nav-link');
        if (!link || link.classList.contains('active')) return;
        document.querySelectorAll('.admin-nav-link').forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        renderView(link.dataset.view);
    });
}

function renderView(viewName) {
    mainContentContainer.innerHTML = '';
    switch (viewName) {
        case 'dashboard':
            mainContentContainer.innerHTML = dashboardViewHTML;
            loadAndRenderCompetitions();
            break;
        case 'create':
            mainContentContainer.innerHTML = createCompViewHTML;
            initializeCreateFormView();
            break;
        case 'spinner-settings':
            mainContentContainer.innerHTML = spinnerSettingsViewHTML;
            initializeSpinnerSettingsView();
            break;
        case 'spinner-comps':
            mainContentContainer.innerHTML = spinnerCompsViewHTML;
            initializeSpinnerCompsView();
            break;
    }
}

async function loadAndRenderCompetitions() {
    const listDiv = document.getElementById('competition-list');
    try {
        const q = query(collection(db, "competitions"), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);
        allCompetitions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        listDiv.innerHTML = allCompetitions.map(comp => renderCompetitionRow(comp)).join('');
        listDiv.addEventListener('click', handleDashboardClick);
    } catch (error) {
        console.error("Error loading competitions:", error);
        listDiv.innerHTML = `<p style="color:red;">Failed to load competitions.</p>`;
    }
}

function renderCompetitionRow(comp) {
    const progress = (comp.ticketsSold / comp.totalTickets) * 100;
    let buttons = '';
    
    if (comp.status === 'live') {
        buttons = `
            <button class="btn btn-small btn-secondary" data-action="end">End Now</button>
            <button class="btn btn-small btn-secondary" data-action="add-fer">Add Free Entry</button>
        `;
    } else if (comp.status === 'ended' && !comp.winnerId) {
        buttons = `<button class="btn btn-small btn-primary" data-action="draw-winner">Draw Winner</button>`;
    } else if (comp.status === 'drawn') {
        buttons = `<div class="status-badge status-won">Winner: ${comp.winnerDisplayName || 'N/A'}</div>`;
    } else {
         buttons = `<span class="status-badge">${comp.status}</span>`;
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

function initializeCreateFormView() {
    const form = document.getElementById('create-comp-form');
    const addTierBtn = document.getElementById('add-tier-btn');
    const tiersContainer = document.getElementById('ticket-tiers-container');
    
    const addTier = () => {
        const tierEl = document.createElement('div');
        tierEl.className = 'form-group-inline ticket-tier-row';
        tierEl.innerHTML = `<div class="form-group"><label>Tickets</label><input type="number" class="tier-amount" required></div><div class="form-group"><label>Price (£)</label><input type="number" step="0.01" class="tier-price" required></div><button type="button" class="btn-remove-tier">×</button>`;
        tiersContainer.appendChild(tierEl);
        tierEl.querySelector('.btn-remove-tier').addEventListener('click', () => tierEl.remove());
    };
    addTierBtn.addEventListener('click', addTier);
    addTier();
    
    form.addEventListener('submit', handleCreateFormSubmit);
}

async function handleCreateFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    try {
        const ticketTiers = Array.from(document.querySelectorAll('.ticket-tier-row')).map(row => ({ amount: parseInt(row.querySelector('.tier-amount').value), price: parseFloat(row.querySelector('.tier-price').value) }));
        const correctAnswer = form.querySelector('#correctAnswer').value.trim();
        const otherAnswers = form.querySelector('#otherAnswers').value.split(',').map(a => a.trim());
        const allAnswers = [correctAnswer, ...otherAnswers].sort(() => Math.random() - 0.5);
        const answers = {};
        let correctKey = '';
        ['A', 'B', 'C', 'D'].slice(0, allAnswers.length).forEach((key, i) => {
             answers[key] = allAnswers[i];
             if (allAnswers[i] === correctAnswer) correctKey = key;
        });

        const competitionData = {
            title: form.querySelector('#title').value,
            prizeImage: form.querySelector('#prizeImage').value,
            totalTickets: parseInt(form.querySelector('#totalTickets').value),
            userEntryLimit: parseInt(form.querySelector('#userEntryLimit').value),
            cashAlternative: parseFloat(form.querySelector('#cashAlternative').value),
            endDate: Timestamp.fromDate(new Date(form.querySelector('#endDate').value)),
            skillQuestion: { text: form.querySelector('#questionText').value, answers, correctAnswer: correctKey },
            ticketTiers,
            ticketsSold: 0,
            status: 'live',
            createdAt: serverTimestamp(),
            winnerId: null,
            instantWinsConfig: { 
                enabled: form.querySelector('#enable-spin-tokens').checked 
            }
        };
        
        await addDoc(collection(db, "competitions"), competitionData);
        alert('Competition created successfully!');
        renderView('dashboard');

    } catch (error) {
        console.error("Error creating competition:", error);
        alert(`Error: ${error.message}`);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Create Competition';
    }
}

function initializeSpinnerSettingsView() {
    const form = document.getElementById('spinner-settings-form');
    const prizesContainer = document.getElementById('spinner-prizes-container');
    const addPrizeBtn = document.getElementById('add-spinner-prize-btn');
    const rtpDisplay = document.getElementById('total-rtp-display');

    const calculateRTP = () => {
        let totalRTP = 0;
        const prizeRows = prizesContainer.querySelectorAll('.spinner-prize-row');
        prizeRows.forEach(row => {
            const value = parseFloat(row.querySelector('.spinner-prize-value').value) || 0;
            const odds = parseInt(row.querySelector('.spinner-prize-odds').value) || 0;
            if (value > 0 && odds > 0) {
                totalRTP += (value / odds);
            }
        });
        const rtpPercentage = (totalRTP / 1.00) * 100; // Assuming £1.00 per spin for calculation
        rtpDisplay.textContent = `${rtpPercentage.toFixed(2)}%`;
    };

    const addPrizeTier = (type = 'credit', value = '', odds = '') => {
        const prizeEl = document.createElement('div');
        prizeEl.className = 'form-group-inline spinner-prize-row';
        prizeEl.innerHTML = `
            <div class="form-group" style="flex: 1;"><label>Prize Type</label><select class="spinner-prize-type"><option value="credit" ${type === 'credit' ? 'selected' : ''}>Credit</option><option value="cash" ${type === 'cash' ? 'selected' : ''}>Cash</option></select></div>
            <div class="form-group" style="flex: 1;"><label>Value (£)</label><input type="number" step="0.01" class="spinner-prize-value" value="${value}" required></div>
            <div class="form-group" style="flex: 1;"><label>Odds (1 in X)</label><input type="number" class="spinner-prize-odds" value="${odds}" required></div>
            <button type="button" class="btn-remove-tier">×</button>`;
        prizesContainer.appendChild(prizeEl);
        prizeEl.querySelector('.btn-remove-tier').addEventListener('click', () => {
            prizeEl.remove();
            calculateRTP();
        });
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

function initializeSpinnerCompsView() {
    const form = document.getElementById('spinner-comp-form');
    const compId = form.querySelector('#spinner-comp-id').value;
    
    const loadData = async () => {
        const compRef = doc(db, 'spinner_competitions', compId);
        const docSnap = await getDoc(compRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            form.querySelector('#spinner-title').value = data.title || '';
            form.querySelector('#spinner-prize').value = data.prize || '';
            form.querySelector('#spinner-questionText').value = data.skillQuestion.text || '';
            
            const answers = data.skillQuestion.answers;
            const correct = data.skillQuestion.correctAnswer;
            form.querySelector('#spinner-correctAnswer').value = answers[correct];
            form.querySelector('#spinner-otherAnswers').value = Object.keys(answers).filter(k => k !== correct).map(k => answers[k]).join(', ');
        }
    };
    loadData();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true; submitBtn.textContent = 'Saving...';
        
        try {
            const correctAnswer = form.querySelector('#spinner-correctAnswer').value.trim();
            const otherAnswers = form.querySelector('#spinner-otherAnswers').value.split(',').map(a => a.trim());
            const allAnswers = [correctAnswer, ...otherAnswers].sort(() => Math.random() - 0.5);
            const answers = {};
            let correctKey = '';
            ['A', 'B', 'C', 'D'].slice(0, allAnswers.length).forEach((key, i) => {
                 answers[key] = allAnswers[i];
                 if (allAnswers[i] === correctAnswer) correctKey = key;
            });

            const compData = {
                title: form.querySelector('#spinner-title').value,
                prize: form.querySelector('#spinner-prize').value,
                skillQuestion: {
                    text: form.querySelector('#spinner-questionText').value,
                    answers,
                    correctAnswer: correctKey
                },
                isActive: true,
            };
            await setDoc(doc(db, 'spinner_competitions', compId), compData);
            alert('Spinner competition saved!');
        } catch (error) {
            console.error(error);
            alert('Error saving spinner competition.');
        } finally {
            submitBtn.disabled = false; submitBtn.textContent = 'Save Spinner Competition';
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
        loadAndRenderCompetitions();
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
        const functions = getFunctions(app);
        const drawWinner = httpsCallable(functions, 'drawWinner');
        const result = await drawWinner({ compId });

        if (result.data.success) {
            alert(`🎉 Winner Drawn! 🎉\n\nWinner: ${result.data.winnerDisplayName}\nTicket: #${result.data.winningTicketNumber}`);
            loadAndRenderCompetitions(); 
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
    
    openModal(`
        <h2>Add Free Entry for:</h2>
        <h3>${comp.title}</h3>
        <form id="fer-form" class="modal-form">
            <div class="form-group"><label for="fer-email">User's Email</label><input type="email" id="fer-email" required placeholder="user@example.com"></div>
            <div class="form-group"><label for="fer-tickets">Number of Entries</label><input type="number" id="fer-tickets" required value="1" min="1"></div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
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
        loadAndRenderCompetitions();

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
    modalBody.innerHTML = content;
    modalContainer.classList.add('show');
}

function closeModal() {
    modalContainer.classList.remove('show');
}
