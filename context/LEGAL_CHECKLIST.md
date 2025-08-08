# LEGAL COMPLIANCE CHECKLIST

This checklist is derived from the legal handbook and must be used to audit all development.

### 1. Legal & Entry Mechanics
- [ ] Does every competition require a non-trivial skill-based question? (Ref: `competition.js`, `admin.js`)
- [ ] Is there a clear, public-facing page for the Free Entry Route (FER)? (Ref: `app/free-entry-route.html`)
- [ ] Does the site-wide footer link to the FER page? (Ref: `app/js/auth.js`)
- [ ] Does the admin panel allow for FER entries to be added manually and treated equally? (Ref: `admin.js`)
- [ ] Are per-user entry limits enforced in the entry transaction? (Ref: `competition.js`)
- [ ] Is there a field in the admin panel to set the per-user entry limit? (Ref: `admin.js`)

### 2. Legal Pages & Content
- [ ] Is there a `terms-and-conditions.html` page?
- [ ] Is there a `privacy-policy.html` page?
- [ ] Is there an `faq.html` page?
- [ ] Do all pages list "Hawk Games Ltd" as the Promoter in the T&Cs/Footer?

### 3. GDPR & Data
- [ ] Is marketing consent an **explicit opt-in**? (Ref: `account.html`)
- [ ] Is the default for `marketingConsent` set to `false` upon user creation? (Ref: `auth.js`)
- [ ] Does the Privacy Policy detail what data is collected, how it's stored, and how to request deletion?

### 4. Draw & Integrity
- [ ] Does the admin panel have a provably fair way to draw a winner from all eligible entries (paid + FER)? (Ref: `admin.js`)
- [ ] Is there a `winners.html` page to display past winners?
- [ ] Are all entries logged in a way that can be archived? (Ref: `entries` sub-collection)

 ### 5. Instant Win Integrity (NEW)
- [ ] Are instant win ticket numbers securely pre-generated and stored before a competition goes live? (Ref: `admin.js`)
- [ ] Is there a mechanism to publish the full list of instant win ticket numbers after a competition closes for transparency?
- [ ] Do tickets that win an instant prize remain in the main prize draw, ensuring their full value? (Ref: `competition.js` logic)
- [ ] Is the process of claiming an instant win atomic to prevent race conditions and double-claims? (Ref: `competition.js`)
