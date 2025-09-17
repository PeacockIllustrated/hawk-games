# Implementation Notes: Secure Email/Password Authentication

This document outlines the changes made to add email/password authentication and the email verification gate.

## Changes Made

1.  **Authentication UI (`app/login.html`)**:
    *   The login page was updated to include a unified form for both email/password sign-in and registration.
    *   A toggle was added to switch between "Sign In" and "Register" modes.
    *   A "Forgot Password?" link was added to the sign-in form.

2.  **Authentication Logic (`app/js/auth.js`)**:
    *   Implemented Firebase functions for email/password authentication:
        *   `createUserWithEmailAndPassword` for registration.
        *   `signInWithEmailAndPassword` for sign-in.
        *   `sendPasswordResetEmail` for password recovery.
    *   Upon successful registration, a verification email is automatically sent to the user via `sendEmailVerification`.
    *   Added client-side validation for password strength.
    *   Implemented a simple rate-limiting mechanism to temporarily disable the login button after 3 failed attempts in 60 seconds.

3.  **Verification Page (`app/verify-email.html`, `app/js/verify-email.js`)**:
    *   A new page was created to instruct users to check their email for a verification link.
    *   This page includes a button to allow users to resend the verification email.

4.  **Verification Gate**:
    *   A UI gate was implemented in `app/js/auth.js` via the `requireVerifiedEmail` function.
    *   This gate is applied on the competition page (`app/js/competition.js`) before a user can proceed to enter a competition. It checks if `auth.currentUser.emailVerified` is `true`.
    *   If a user is not verified, an overlay is displayed, preventing further action and prompting them to check their email or resend the verification link.

5.  **Security Rules (`firestore.rules`)**:
    *   The Firestore security rules were updated to enforce email verification at the backend.
    *   The `create` rules for the `orders` and `entries` collections now require `request.auth.token.email_verified == true`. This ensures that even if client-side checks are bypassed, no unverified user can create an order or an entry.

## How to Toggle the Verification Gate

The verification gate is currently active on the competition entry flow. To disable it, you can comment out or remove the call to `requireVerifiedEmail` in `app/js/competition.js`:

```javascript
// In app/js/competition.js, inside the entryButton.addEventListener('click', ...)
// const isVerified = await requireVerifiedEmail(); // <-- Comment out this line
// if (!isVerified) {                             // <-- Comment out this block
//     return;
// }
```

## Rollback Plan

To revert all changes and return to the previous Google-only authentication system:

1.  **Revert `app/login.html`**:
    *   Restore the original `app/login.html` file from git history.

2.  **Revert `app/js/auth.js`**:
    *   Restore the original `app/js/auth.js` file from git history.

3.  **Revert `app/js/competition.js`**:
     *   Restore the original `app/js/competition.js` file from git history.

4.  **Delete New Files**:
    *   Delete `app/verify-email.html`.
    *   Delete `app/js/verify-email.js`.

5.  **Revert `firestore.rules`**:
    *   Restore the original `firestore.rules` file from git history, removing the `&& request.auth.token.email_verified == true` conditions.

This will effectively remove all traces of the new email/password authentication system and restore the application to its previous state.
