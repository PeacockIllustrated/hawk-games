# AI AGENT INSTRUCTIONS: THE HAWK GAMES

This document is the master source-of-truth for building The Hawk Games platform.

## 1. Brand Identity
- **Primary Color (Gold):** `#e0a94a`
- **Secondary Color (White):** `#f0f0f0`
- **Background Color (Dark):** `#121212`
- **Heading Font:** 'Oswald', sans-serif
- **Body Font:** 'Roboto', sans-serif
- **Aesthetic:** Premium, modern, sleek, and serious. No retro or multi-theme elements.

## 2. Technology Stack
- **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES6 Modules).
- **Backend:** Firebase (Authentication, Firestore, Cloud Functions).
- **Styling:** A single, master stylesheet (`app/css/hawk-games.css`). No other CSS files should be used.

## 3. Architecture
- **Root Domain (`the-hawk-games.co.uk`):** Hosts the `index.html` "Coming Soon" landing page.
- **Application Subdomain (`app.the-hawk-games.co.uk`):** Hosts the full competition application, which lives in the `/app` directory. All application links must be relative to the `app` folder.

## 4. Core Business Logic
- **Model:** Skill-based prize competitions, compliant with the UK Gambling Act 2005.
- **Key Differentiator:** Every competition MUST have a non-trivial skill question. This is NOT a lottery or raffle site.
- **Compliance:** All development must strictly adhere to `LEGAL_CHECKLIST.md`.