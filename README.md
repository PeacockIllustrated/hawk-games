The Hawk Games - Project Summary & Technical Overview
![alt text](https://img.shields.io/badge/status-build_ready-success)
Version: 1.0 (Pre-Launch)
Status: Core functionality is complete and stable. All known bugs are resolved. The platform is ready for the integration of a payment gateway (e.g., Trust Payments) before its public launch.
Table of Contents
Project Overview
Live Staging URL
Technology Stack
Architecture & File Structure
Core Features (Current State)
Security Overview
Firestore Data Model
Local Setup & Deployment
Immediate Roadmap (Next Steps)
Legal & Compliance Notes
1. Project Overview
The Hawk Games is a sophisticated, legally compliant, online platform for skill-based prize competitions, specifically tailored to the UK market. The business model is a Hybrid Competition System designed to maximize player engagement and retention while operating strictly within the guidelines of the UK Gambling Act 2005.
The platform is built on three distinct tiers of competitions:
Hero Competition: A single, high-value "main event" prize (e.g., a luxury car) that serves as the primary promotional focus of the site.
Main Competitions: Standard prize draws for valuable items (e.g., tech, holidays, cash).
Instant Win Competitions: These competitions award a Bonus Spin Token for every ticket purchased, driving engagement with the platform's spinner game.
This system is supported by the Instant Win Spinner Game, a game of chance where players spend their earned Spin Tokens for an opportunity to win cash or site credit, creating a compelling re-engagement loop.
2. Live Staging URL
The application is currently deployed and functional at:
https://the-hawk-games.co.uk/app/
3. Technology Stack
Frontend:
HTML5
CSS3 (Single Master Stylesheet)
Vanilla JavaScript (ES6 Modules)
Backend & Cloud Services:
Firebase:
Firestore: NoSQL database for all application data.
Cloud Functions for Firebase (Node.js 20): Secure, server-side environment for all critical business logic.
Firebase Authentication: Manages all user accounts via Google Sign-In.
Firebase Hosting: Hosts the static frontend application.
Firebase App Check: Secures backend APIs using the reCAPTCHA Enterprise provider.
Key Libraries:
Zod: Used in Cloud Functions for strict, schema-based input validation.
4. Architecture & File Structure
The project is structured for a clear separation of concerns between the public-facing landing page, the application itself, and the secure backend.
/ (Root Directory):
index.html: The legacy "Coming Soon" page.
firebase.json: Firebase deployment configuration.
firestore.rules: Critical database security rules.
/app: Contains the entire user-facing application.
index.html: The main dashboard/homepage for logged-in users.
/js/auth.js: The most important frontend file. It initializes Firebase and App Check, manages the global authentication state, and dynamically renders the shared header and footer on all pages.
/js/*.js: Each page has a corresponding JS file that controls its specific logic (e.g., competition.js, account.js).
/css/hawk-games.css: The single source of truth for all application styling.
/functions: The Node.js backend environment.
index.js: Contains all the Cloud Functions for processing entries, drawing winners, and managing the spinner game.
package.json: Defines backend dependencies.
5. Core Features (Current State)
The platform is feature-complete, pending payment integration.
✅ Hybrid Competition System: All three competition types can be created and managed via the admin panel and are correctly displayed to users.
✅ Compliant Token Economy: Users correctly earn Spin Tokens from designated competitions and can spend them on the Instant Win Spinner. The prize outcomes are determined securely on the server.
✅ Complete User Journey: Full user flow from registration/login (Google Auth), viewing competitions, answering skill questions, entering draws (via simulated calls), viewing their complete entry history on the Account page, and playing the spinner game.
✅ Functional Admin Panel: A secure, admin-only SPA that allows for:
Viewing and managing all competitions.
Manually ending competitions and drawing winners.
Creating new competitions of all types.
Managing the prize pool and odds for the Instant Win Spinner.
Managing the Spinner Competition, including its dynamic ticket bundle pricing.
✅ Enhanced UX: The Instant Win spinner features a faster, 3-second spin time and an impactful, modal-based celebration for wins, complete with a "Spin Again" feature.
✅ Polished UI: A sleek, on-brand, and fully compliant custom footer has replaced the default reCAPTCHA badge.
6. Security Overview
Security has been a primary focus of the recent refactor. The platform is built on a zero-trust model where the client is untrusted and all critical logic is enforced on the server.
Firebase App Check: All Cloud Function endpoints are protected by App Check with the reCAPTCHA Enterprise provider, ensuring requests can only come from the legitimate web application.
Secure Cloud Functions:
Transactions: All database operations that involve multiple documents (e.g., creating an entry, updating ticket counts) are wrapped in atomic Firestore Transactions to prevent race conditions.
Input Validation: All incoming data from the client is rigorously validated against a Zod schema before any logic is executed.
Hardened Firestore Rules: The security rules enforce the principle of least privilege. Clients cannot write or modify critical data directly; all mutations must go through a validated Cloud Function. The rules are specifically configured to allow the necessary queries for the Admin and Account pages to function securely.
Frontend Security: All innerHTML usage has been eliminated and replaced with programmatic DOM creation using textContent for data rendering, mitigating all Cross-Site Scripting (XSS) vulnerabilities.
7. Firestore Data Model
The data is structured as follows:
competitions/{compId}: Main, Hero, and Instant Win competitions.
spinner_competitions/active: The always-on competition for earning tokens.
ticketBundles (Array): Stores the dynamically editable pricing (e.g., [{ amount: 5, price: 4.50 }]).
users/{uid}: User profiles.
spinTokens (Array), creditBalance (Number).
admin_settings/spinnerPrizes: Defines the prize pool and odds for the spinner game.
{competitionCollection}/{id}/entries/{entryId}: Secure log of all user entries.
spin_wins/{winId}: Secure, server-written log of all spinner prizes won.
pastWinners/{compId}: Public-facing list of competition winners.
8. Local Setup & Deployment
Prerequisites
Node.js (v20 or later)
Firebase CLI (npm install -g firebase-tools)
Local Setup
Clone the repository.
Navigate to the functions directory: cd functions
Install backend dependencies: npm install
Navigate back to the root: cd ..
Start the Firebase Local Emulator Suite: firebase emulators:start
Deployment
Deploy Backend Functions: firebase deploy --only functions
Deploy Security Rules: firebase deploy --only firestore:rules
Deploy Frontend App: firebase deploy --only hosting
9. Immediate Roadmap (Next Steps)
The platform is ready for the final pre-launch development phase.
[HIGH PRIORITY] Payment Gateway Integration:
Task: Integrate a payment provider (e.g., Trust Payments, Stripe) to handle real transactions.
Implementation: Create a createPaymentIntent Cloud Function and implement the provider's frontend SDK on the competition and instant-win pages.
[HIGH PRIORITY] 3x Spin Feature:
Task: Implement the planned multi-spin feature to enhance user engagement.
Implementation: Create a spendMultipleSpinTokens Cloud Function and add the "Spin 3x" button and UI logic to instant-games.js.
[MEDIUM PRIORITY] Finalize Content & SEO:
Task: Replace all placeholder text in faq.html, terms-and-conditions.html, etc., with finalized, legally-reviewed content.
Implementation: Add <meta> tags, a favicon.ico, and Open Graph tags to all HTML pages.
10. Legal & Compliance Notes
The platform's architecture is built to be compliant with UK law. The following are non-negotiable pillars of the system:
Skill Question: All competitions require a skill-based question for paid entry.
Free Entry Route (FER): A postal FER is available and treated equally to paid entries.
No Direct Payment for Chance: Users never pay directly for a spin. Tokens are a promotional bonus for entering a skill-based competition.
