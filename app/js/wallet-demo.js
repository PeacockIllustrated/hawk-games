// app/js/wallet-demo.js
import { DEMO_WALLETS } from "./config.js";

// Centralized strings for easy localization
const STRINGS = {
    title: "Fast Checkout (Preview)",
    applePayLabel: "Buy with Pay (Preview)",
    googlePayLabel: "Buy with Google Pay (Preview)",
    comingSoon: "Coming Soon — no payment taken",
};

const getSafeQty = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 1;
    }
    return Math.floor(parsed);
};

/**
 * Mounts the wallet preview UI into a specified container.
 * @param {object} options
 * @param {string} options.containerSelector - The CSS selector for the container element.
 * @param {string} options.compId - The competition ID.
 * @param {number} options.qty - The initial quantity of tickets.
 * @param {string} options.compTitle - The title of the competition.
 * @returns {object|null} An object with an updateQty method, or null if demo wallets are disabled.
 */
export function mountWalletPreview({ containerSelector, compId, qty, compTitle }) {
    const container = document.querySelector(containerSelector);
    if (!container) {
        console.error(`Wallet preview container not found: ${containerSelector}`);
        return null;
    }

    container.classList.add("wallet-preview");
    if (!container.hasAttribute("aria-live")) {
        container.setAttribute("aria-live", "polite");
    }

    if (!DEMO_WALLETS) {
        container.innerHTML = `
            <div class="error-message" style="padding: 2rem; text-align: center; color: #ff6b6b;">
                <h3>Wallet Preview Disabled</h3>
                <p>To enable wallet preview, run in console:</p>
                <code style="display: block; background: #2c2c2c; padding: 1rem; margin: 1rem 0; border-radius: 4px;">
                    localStorage.setItem("wallet_demo", "1"); location.reload();
                </code>
            </div>
        `;
        return null;
    }

    let currentQty = getSafeQty(qty);

    const render = () => {
        container.innerHTML = `
            <h3>${STRINGS.title}</h3>
            <div class="wallet-row">
                <button class="wallet-btn wallet-apple" data-wallet="apple" aria-label="${STRINGS.applePayLabel}">
                    <img src="assets/wallet-apple.svg" alt="Apple Pay" style="height: 24px;">
                    <span>${STRINGS.applePayLabel.replace(' (Preview)', '')}</span>
                </button>
                <button class="wallet-btn wallet-gpay" data-wallet="google" aria-label="${STRINGS.googlePayLabel}">
                    <img src="assets/wallet-gpay.svg" alt="Google Pay" style="height: 24px;">
                    <span>${STRINGS.googlePayLabel.replace(' (Preview)', '')}</span>
                </button>
            </div>
            <div class="wallet-badge">${STRINGS.comingSoon}</div>
        `;
    };

    const buildConfirmationUrl = (brand) => {
        const params = new URLSearchParams({
            compId,
            qty: currentQty,
            brand,
            compTitle: encodeURIComponent(compTitle)
        });
        return `wallet-confirmation.html?${params.toString()}`;
    };

    const handleClick = (event) => {
        const button = event.target.closest(".wallet-btn");
        if (!button) return;

        const brand = button.dataset.wallet;
        if (!brand) return;

        // PREVIEW ONLY - analytics placeholder
        console.log({
            event: "wallet_preview_click",
            brand,
            compId,
            qty: currentQty
        });

        // PREVIEW ONLY — replace with real wallet flow later.
        window.location.href = buildConfirmationUrl(brand);
    };

    render();
    container.addEventListener("click", handleClick);

    return {
        updateQty: (newQty) => {
            currentQty = getSafeQty(newQty);
            // No need to re-render, URL is built on click
        },
        destroy: () => {
            container.removeEventListener("click", handleClick);
            container.innerHTML = "";
        }
    };
}
