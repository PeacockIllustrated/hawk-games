// app/js/wallet-confirmation.js
import { DEMO_WALLETS } from './config.js';
import { db } from './auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// Centralized strings
const STRINGS = {
    summaryTitle: "Order Summary (Preview)",
    competitionLabel: "Competition",
    quantityLabel: "Quantity",
    totalLabel: "Estimated Total",
    placeOrder: "Place Order (Preview)",
    backButton: "Back to Competition",
    footerNote: "Apple Pay / Google Pay coming soon. This is a design preview.",
    successTitle: "Preview Complete",
    successBody: "No payment was taken. This is a design preview of the fast-checkout flow.",
    returnButton: "Return to Competition",
    securityNote: "When enabled, Apple Pay / Google Pay will charge your saved card via a secure provider.",
};

const container = document.getElementById("confirmation-container");
const params = new URLSearchParams(window.location.search);
const compId = params.get('compId');
const qty = parseInt(params.get('qty'), 10) || 1;
const brand = params.get('brand');
const compTitle = decodeURIComponent(params.get('compTitle') || '');

function hardGuard() {
    if (!DEMO_WALLETS) {
        window.location.replace(`competition.html?id=${compId}`);
        return true;
    }
    return false;
}

function renderError(message) {
    container.innerHTML = `<p class="muted">${message}</p>`;
}

function renderSummary(competitionData, estimatedTotal) {
    const brandIcon = brand === 'apple'
        ? `<img src="assets/wallet-apple.svg" alt="Apple Pay" style="height: 24px;">`
        : `<img src="assets/wallet-gpay.svg" alt="Google Pay" style="height: 24px;">`;

    container.innerHTML = `
        <div class="summary">
            <h2>${STRINGS.summaryTitle}</h2>
            <div class="summary-item">
                <span>${STRINGS.competitionLabel}</span>
                <strong>${competitionData.title || compTitle}</strong>
            </div>
            <div class="summary-item">
                <span>${STRINGS.quantityLabel}</span>
                <strong>${qty}</strong>
            </div>
            <div class="summary-item">
                <span>${STRINGS.totalLabel}</span>
                <strong>£${estimatedTotal.toFixed(2)}</strong>
            </div>
        </div>
        <div class="pill">${brandIcon}</div>
        <div class="wallet-row" style="margin-top: 2rem;">
            <button id="place-order-btn" class="btn">${STRINGS.placeOrder}</button>
            <a href="competition.html?id=${compId}" class="btn btn-secondary">${STRINGS.backButton}</a>
        </div>
        <p class="muted" style="margin-top: 2rem;">${STRINGS.footerNote}</p>
        <p class="muted">${STRINGS.securityNote}</p>
    `;

    document.getElementById('place-order-btn').addEventListener('click', handlePlaceOrder);
}

function renderSuccess() {
    const fakeRef = `HPV-${Date.now().toString().slice(-6)}`;
    container.innerHTML = `
        <div style="text-align: center;">
            <h2>${STRINGS.successTitle}</h2>
            <p>${STRINGS.successBody}</p>
            <p class="muted">Ref: ${fakeRef}</p>
            <div class="wallet-row" style="margin-top: 2rem;">
                <a href="competition.html?id=${compId}" class="btn">${STRINGS.returnButton}</a>
            </div>
        </div>
    `;
}

async function handlePlaceOrder() {
    const button = document.getElementById('place-order-btn');
    button.disabled = true;
    button.innerHTML = '<div class="loader" style="width: 20px; height: 20px; border-width: 2px;"></div>';

    // PREVIEW ONLY — replace with real wallet flow later.
    // No network calls.
    await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 400));

    renderSuccess();
}

async function init() {
    if (hardGuard()) return;
    if (!compId || !brand) {
        renderError("Missing competition details.");
        return;
    }

    try {
        const compRef = doc(db, 'competitions', compId);
        const compSnap = await getDoc(compRef);

        if (!compSnap.exists()) {
            renderError("Competition not found.");
            return;
        }

        const data = compSnap.data();
        let price = data.ticketPricePence || data.pricePence || 0;

        if (data.ticketTiers && data.ticketTiers.length > 0) {
            price = data.ticketTiers[0].price; // Use cheapest tier for estimate
        }

        const estimatedTotal = (qty * price) / 100;
        renderSummary(data, estimatedTotal);

    } catch (error) {
        console.error("Error fetching competition data:", error);
        renderError("Could not load competition details.");
    }
}

init();
