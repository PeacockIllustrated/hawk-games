// /app/js/app-config.js
// This file defines global configuration variables for the application.

// App Check for Firebase
// IMPORTANT: This key is tied to the domain and is public.
// It is safe to be in client-side code.
window.__APP_CHECK_KEY__ = "6LdkDqgrAAAAAAuWtoK941myjHGZd8vka_Q3JhKg";
// Temporary: enable wallet demo (Apple Pay / Google Pay preview)
window.__DEMO_WALLETS__ = true;
// On-site wallets (Trust Payments) feature flag
window.__WALLETS_ONSITE__ = true;

// Placeholder wallet config (replace with Trust-provided values)
window.__GOOGLE_PAY_MERCHANT_ID__ = "TBD_GOOGLE_PAY_MERCHANT_ID";
window.__GOOGLE_PAY_GATEWAY__ = "trustpayments";
window.__GOOGLE_PAY_GATEWAY_MERCHANT_ID__ = "TBD_TRUST_GATEWAY_MERCHANT_ID";

// If using Trust-managed Apple Pay, domain must be verified. If using own merchant, set your merchant identifier below.
window.__APPLE_PAY_MERCHANT_ID__ = "TBD_APPLE_MERCHANT_ID_OR_TRUST";