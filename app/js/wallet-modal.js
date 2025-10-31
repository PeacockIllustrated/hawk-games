// app/js/wallet-modal.js
// On-site Wallet modal (Apple Pay / Google Pay) — placeholder integration
// Renders a modal with wallet buttons and routes to confirmation with no redirect off-site.

import { DEMO_WALLETS } from './config.js';

const STRINGS = {
  title: 'Fast Checkout',
  subtitle: 'Pay securely without leaving this page.',
  apple: 'Buy with Pay',
  google: 'Buy with Google Pay',
  disclaimer: 'Apple Pay / Google Pay will process your saved card via a trusted provider.',
};

function ensureModalRoot() {
  let root = document.getElementById('wallet-modal-root');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'wallet-modal-root';
  root.className = 'modal-container';
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Fast Checkout">
      <button class="modal-close" data-wallet-modal-close aria-label="Close">×</button>
      <div class="wallet-modal-body"></div>
    </div>`;
  document.body.appendChild(root);
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.matches('[data-wallet-modal-close]')) {
      root.classList.remove('show');
    }
  });
  return root;
}

function renderModalContent(container, { compId, qty, compTitle }) {
  const body = container.querySelector('.wallet-modal-body');
  body.innerHTML = `
    <h2>${STRINGS.title}</h2>
    <p class="muted">${STRINGS.subtitle}</p>
    <div class="wallet-row" style="margin-top: 1rem; gap: 0.75rem;">
      <button id="applePayBtn" class="wallet-btn wallet-apple">
        <img src="assets/wallet-apple.svg" alt="Apple Pay" style="height:24px"/>
        <span>${STRINGS.apple}</span>
      </button>
      <button id="googlePayBtn" class="wallet-btn wallet-gpay">
        <img src="assets/wallet-gpay.svg" alt="Google Pay" style="height:24px"/>
        <span>${STRINGS.google}</span>
      </button>
    </div>
    <p class="muted" style="margin-top:1rem;">${STRINGS.disclaimer}</p>
  `;

  const goConfirm = (brand) => {
    const params = new URLSearchParams({ compId, qty: String(qty), brand, compTitle: encodeURIComponent(compTitle || '') });
    window.location.href = `wallet-confirmation.html?${params.toString()}`;
  };

  // Placeholder capability checks — replace with real Trust wallet SDK wiring
  const appleBtn = body.querySelector('#applePayBtn');
  const googleBtn = body.querySelector('#googlePayBtn');
  appleBtn.addEventListener('click', () => goConfirm('apple'));
  googleBtn.addEventListener('click', () => goConfirm('google'));
}

export function openWalletModal({ compId, qty, compTitle }) {
  // Allow toggle: if wallets disabled, fall back to demo route
  if (DEMO_WALLETS) {
    const params = new URLSearchParams({ compId, qty: String(qty), compTitle: encodeURIComponent(compTitle || '') });
    window.location.href = `wallet-demo.html?${params.toString()}`;
    return;
  }
  const root = ensureModalRoot();
  renderModalContent(root, { compId, qty, compTitle });
  requestAnimationFrame(() => root.classList.add('show'));
}
