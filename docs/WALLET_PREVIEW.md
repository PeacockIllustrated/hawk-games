# Wallet Preview Feature

This document outlines the implementation of the temporary wallet preview feature.

## How to Enable/Disable

The feature is controlled by a feature flag `DEMO_WALLETS` in `app/js/config.js`. It can be enabled for testing in the browser's developer console:

```javascript
localStorage.setItem("wallet_demo", "1");
```

To disable the feature, remove the `localStorage` item:

```javascript
localStorage.removeItem("wallet_demo");
```

## Code Locations

-   **HTML:**
    -   `app/wallet-confirmation.html`: The new confirmation page.
    -   `app/competition.html`: Modified to include the wallet preview container.
-   **CSS:**
    -   `app/css/wallet-demo.css`: All styles for the new feature.
-   **JavaScript:**
    -   `app/js/config.js`: Contains the `DEMO_WALLETS` feature flag.
    -   `app/js/wallet-demo.js`: Renders the wallet buttons on the competition page.
    -   `app/js/wallet-confirmation.js`: Logic for the confirmation page.
    -   `app/js/competition.js`: Modified to mount the wallet preview.
-   **Assets:**
    -   `app/assets/wallet-apple.svg`: Apple Pay logo.
    -   `app/assets/wallet-gpay.svg`: Google Pay logo.

## How to Remove Later

1.  Remove the `mountWalletPreview` call and related imports from `app/js/competition.js`.
2.  Remove the wallet preview container from `app/competition.html`.
3.  Delete the following files:
    -   `app/wallet-confirmation.html`
    -   `app/css/wallet-demo.css`
    -   `app/js/wallet-demo.js`
    -   `app/js/wallet-confirmation.js`
    -   `app/assets/wallet-apple.svg`
    -   `app/assets/wallet-gpay.svg`
4.  The `app/js/config.js` file can be removed if no other feature flags are using it.

## Intentionally Non-Functional

-   **No Payment Processing:** Clicking the "Place Order (Preview)" button does **not** initiate any payment. It simulates a short delay and then shows a success message.
-   **No Ticket Allocation:** No tickets are created or assigned in the database.
-   **Read-Only Data:** The confirmation page only reads competition data from Firestore; it performs no write operations.
-   **No Apple Pay Association:** The `.well-known` directory has not been modified. This is a UI preview only.
