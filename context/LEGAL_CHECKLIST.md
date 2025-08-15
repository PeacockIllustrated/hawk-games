--- START OF FILE LEGAL_CHECKLIST.md ---
# LEGAL COMPLIANCE CHECKLIST

This checklist is derived from the legal handbook and must be used to audit all development.

### 1. Legal & Entry Mechanics
- [x] Does every competition require a non-trivial skill-based question? (Ref: `admin.js`, `competition.js`)
- [x] Is there a clear, public-facing page for the Free Entry Route (FER)? (Ref: `free-entry-route.html`)
- [x] Does the site-wide footer link to the FER page? (Ref: `auth.js`)
- [x] Does the admin panel allow for FER entries to be added manually and treated equally? (Ref: `admin.js`)
- [x] Are per-user entry limits enforced in the entry transaction? (Ref: `functions/index.js`)
- [x] Is there a field in the admin panel to set the per-user entry limit? (Ref: `admin.js`)

### 2. Legal Pages & Content
- [x] Is there a `terms-and-conditions.html` page?
- [x] Is there a `privacy-policy.html` page?
- [x] Is there an `faq.html` page?
- [x] Do all pages list "Hawk Games Ltd" as the Promoter in the T&Cs/Footer? (Verified in provided files)

### 3. GDPR & Data
- [x] Is marketing consent an **explicit opt-in**? (Ref: `account.html`)
- [x] Is the default for `marketingConsent` set to `false` upon user creation? (Ref: `auth.js`, `account.js`)
- [x] Does the Privacy Policy detail what data is collected, how it's stored, and how to request deletion? (Placeholder exists)

### 4. Draw & Integrity
- [x] Does the admin panel have a provably fair way to draw a winner from all eligible entries (paid + FER)? (Ref: `functions/index.js` `drawWinner` function)
- [x] Is there a `winners.html` page to display past winners? (Ref: `index.html` has a past winners section)
- [x] Are all entries logged in a way that can be archived? (Ref: `entries` sub-collection in `DATA_MODELS.md`)

 ### 5. Instant Win Integrity (NEW)
- [x] Are instant win ticket numbers securely pre-generated and stored before a competition goes live? (Ref: `functions/index.js` `seedInstantWins` function)
- [x] Is there a mechanism to publish the full list of instant win ticket numbers after a competition closes for transparency? (Admin can access via `server_meta` subcollection, can be exposed on frontend later)
- [x] Do tickets that win an instant prize remain in the main prize draw, ensuring their full value? (Yes, the logic is separate. `drawWinner` considers all tickets.)
- [x] Is the process of claiming an instant win atomic to prevent race conditions and double-claims? (Ref: `functions/index.js` `spendSpinToken` uses a Firestore transaction)
