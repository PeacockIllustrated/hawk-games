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
const qtyParam = Number.parseInt(params.get('qty'), 10);
const qty = Number.isFinite(qtyParam) && qtyParam > 0 ? qtyParam : 1;
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

const toNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const cleaned = value.replace(/[^0-9.-]/g, '');
        if (!cleaned) return null;
        const parsed = Number(cleaned);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const resolveCurrencySymbol = (data) => {
    if (typeof data?.currencySymbol === 'string' && data.currencySymbol.trim()) {
        return data.currencySymbol.trim();
    }

    const code = typeof data?.currencyCode === 'string' ? data.currencyCode.toUpperCase() : 'GBP';
    switch (code) {
        case 'USD':
            return '$';
        case 'EUR':
            return '€';
        case 'GBP':
            return '£';
        case 'AUD':
        case 'CAD':
        case 'NZD':
        case 'SGD':
            return '$';
        default:
            return '£';
    }
};

const formatCurrency = (amount, symbol) => {
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    return `${symbol}${safeAmount.toFixed(2)}`;
};

const resolveUnitTicketPrice = (data) => {
    const tiers = Array.isArray(data?.ticketTiers) ? data.ticketTiers : [];
    if (tiers.length > 0) {
        const primaryTier = tiers.find((tier) => {
            const amount = toNumber(tier?.amount);
            if (!amount || amount <= 0) return false;

            if (toNumber(tier?.price) !== null) return true;
            if (typeof tier?.pricePence === 'number') return true;
            return false;
        }) || tiers[0];

        const amount = toNumber(primaryTier?.amount);
        if (amount && amount > 0) {
            const price = toNumber(primaryTier?.price);
            if (price !== null) {
                return price / amount;
            }
            if (typeof primaryTier?.pricePence === 'number') {
                return (primaryTier.pricePence / 100) / amount;
            }
        }
    }

    if (typeof data?.ticketPricePence === 'number') {
        return data.ticketPricePence / 100;
    }
    if (typeof data?.pricePence === 'number') {
        return data.pricePence / 100;
    }

    const ticketPrice = toNumber(data?.ticketPrice);
    if (ticketPrice !== null) return ticketPrice;

    const price = toNumber(data?.price);
    if (price !== null) return price;

    return 0;
};

const resolvePricing = (competitionData, quantity) => {
    const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
    const unitPrice = resolveUnitTicketPrice(competitionData);
    const symbol = resolveCurrencySymbol(competitionData);
    const total = unitPrice * safeQuantity;

    return {
        quantity: safeQuantity,
        total,
        symbol,
        formattedTotal: formatCurrency(total, symbol),
    };
};

function renderSummary(competitionData, pricing) {
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
                <strong>${pricing.quantity}</strong>
            </div>
            <div class="summary-item">
                <span>${STRINGS.totalLabel}</span>
                <strong>${pricing.formattedTotal}</strong>
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
        const pricing = resolvePricing(data, qty);
        renderSummary(data, pricing);

    } catch (error) {
        console.error("Error fetching competition data:", error);
        renderError("Could not load competition details.");
    }
}

init();
