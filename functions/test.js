/*
=================================================================
== TEST PLAN: TECH LOYALTY FEATURE
=================================================================

This file outlines the manual and semi-automated steps required
to test the new Tech Loyalty feature using the Firebase Local Emulator Suite.

-----------------------------------------------------------------
-- I. SETUP
-----------------------------------------------------------------

1. **Start the Emulator:**
   - Run the following command from your terminal in the project root:
     `firebase emulators:start`
   - This will start the Functions, Firestore, and Hosting emulators.

2. **Create Test Data:**
   - You will need to use the Admin UI and Firebase Console (or scripts) to create the following:
     a. **Test Users:** Create 3-4 unique user accounts via the app's signup process.
     b. **Run Migration:** From the Admin Panel, navigate to a temporary button/link that calls the `backfillCompetitionSchema` function. Verify in the function logs that it ran successfully.
     c. **Tech Competitions:** Create at least FOUR competitions with the following settings:
        - Category: "Tech"
        - Loyalty -> Eligible for Tech Unlock: CHECKED
     d. **Loyalty Competition:** Create ONE competition with the following settings:
        - Title: "Loyalty Prize Draw"
        - Loyalty -> Is the Loyalty Draw Prize: CHECKED
        - Loyalty -> Requires Unlock to Enter: CHECKED
     e. **Configure Global Settings:**
        - In the Admin Panel, go to "Loyalty Settings".
        - Enable Tech Loyalty Feature: CHECKED
        - Set "Unlock Threshold" to 3.
        - Copy the ID of the "Loyalty Prize Draw" competition and paste it into the "Target Loyalty Competition ID" field.
        - Set the "Current Window ID" to a relevant value (e.g., "2025-08").
        - Save the settings.

-----------------------------------------------------------------
-- II. TEST CASES
-----------------------------------------------------------------

Perform these tests using the web application and by inspecting the
Firestore Emulator UI (http://localhost:4000).

---
### Test Case 1: Successful Unlock & Bonus Grant
---
- **User:** Test User 1
- **Action:**
  1. Log in as User 1.
  2. Enter THREE of the "Tech" competitions created in the setup phase.
- **Verification:**
  1. **User Document:** In the Firestore Emulator, navigate to `users/{user_1_id}`.
     - Check that the `loyalty` map exists.
     - Check that a field named `unlocked_2025-08` (or your window ID) is set to `true`.
  2. **Bonus Ticket:** Navigate to `competitions/{loyalty_comp_id}/entries`.
     - Find the entry document for User 1. It should have `entryType: 'bonus_loyalty_tech'`.
  3. **Audit Trail:** Navigate to the `audits` collection.
     - Look for two new documents:
       - One with `eventType: 'loyalty_unlocked'`.
       - One with `eventType: 'bonus_ticket_granted'`.

---
### Test Case 2: Purchase Gate (Locked User)
---
- **User:** Test User 2 (who has NOT entered any tech comps)
- **Action:**
  1. Log in as User 2.
  2. Attempt to purchase a ticket for the "Loyalty Prize Draw" competition.
- **Verification:**
  1. **UI:** The application should display an error message like "You must unlock this competition...".
  2. **Function Logs:** The Firebase Functions emulator logs should show the `allocateTicketsAndAwardTokens` function failing with a 'failed-precondition' HttpsError.
  3. **Audit Trail:** In the `audits` collection, find a new document with `eventType: 'purchase_denied_loyalty'`.

---
### Test Case 3: Purchase Gate (Unlocked User)
---
- **User:** Test User 1 (who is now unlocked)
- **Action:**
  1. Log in as User 1.
  2. Purchase a paid ticket for the "Loyalty Prize Draw" competition.
- **Verification:**
  1. **UI:** The purchase should succeed.
  2. **Firestore:** A new entry should exist in `competitions/{loyalty_comp_id}/entries` for User 1 with `entryType: 'paid'`.

---
### Test Case 4: Postal Entry (Success & Limit)
---
- **User:** Test User 3
- **Action:**
  1. Log in as an Admin.
  2. In the Admin Panel, find one of the tech competitions and use the "Add Free Entry" button (or a new UI for postal entries) to submit a postal entry for Test User 3.
  3. Repeat the process for the SAME user and SAME competition.
- **Verification:**
  1. **First Attempt:**
     - A `free_postal` entry is created for User 3 in the competition.
     - An audit log for `postal_entry_submitted` is created.
  2. **Second Attempt:**
     - The UI should show an error.
     - The `submitPostalEntry` function logs should show a 'failed-precondition' error about the limit being reached.
     - No new entry should be created in Firestore.

*/
