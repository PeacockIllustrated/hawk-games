import asyncio
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # Listen for console errors
        error_messages = []
        page.on("console", lambda msg: error_messages.append(msg.text) if msg.type == "error" else None)

        # Navigate to the competition page
        # The app is hosted at the root, so we need to navigate to competition.html
        await page.goto("http://127.0.0.1:5000/app/competition.html?id=test-comp-1")

        # Wait for the DOM to be ready
        await page.wait_for_load_state("domcontentloaded")

        # Check for console errors
        if any("FirebaseError" in error for error in error_messages):
            print("FirebaseError found in console!")
            print("\n".join(error_messages))
            await browser.close()
            exit(1)

        # Execute the smoke test from the problem description
        smoke_test_ok = await page.evaluate("""
            async () => {
                try {
                    const { getFirestore, collection, doc } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js");
                    const { getApps, getApp } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js");
                    const db = getFirestore(getApp());
                    collection(db, 'competitions');
                    collection(db, 'competitions', 'TEST_ID', 'entries');
                    collection(doc(db, 'competitions', 'TEST_ID'), 'entries');
                    return 'OK';
                } catch (e) {
                    console.error('Smoke test failed:', e);
                    return e.message;
                }
            }
        """)

        if smoke_test_ok != 'OK':
             print(f"Smoke test failed with message: {smoke_test_ok}")
             await browser.close()
             exit(1)

        print("Smoke test passed!")

        # Take a screenshot
        await page.screenshot(path="jules-scratch/verification/verification.png")
        print("Screenshot taken.")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
