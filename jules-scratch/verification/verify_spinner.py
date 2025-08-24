import asyncio
from playwright.async_api import async_playwright, expect
import os

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        # Mock the spendSpinToken function
        await page.route("**/spendSpinToken", lambda route: asyncio.ensure_future(route.fulfill(
            status=200,
            content_type="application/json",
            body='{"data": {"won": true, "prizeType": "credit", "value": 5}}'
        )))

        # Prevent navigation to login page
        await page.route("**/login.html", lambda route: route.abort())

        await page.goto("http://localhost:8000/app/instant-games.html")

        # Mock user state by executing script on the page
        await page.evaluate("""() => {
            // Mock firebase auth
            window.getAuth = () => ({
                onAuthStateChanged: (callback) => {
                    callback({ uid: 'test-user' }); // Immediately call with a mock user
                    return () => {}; // Return an unsubscribe function
                }
            });

            window.userTokens = [
                { tokenId: '1', earnedAt: { seconds: new Date().getTime() / 1000 } },
                { tokenId: '2', earnedAt: { seconds: new Date().getTime() / 1000 } },
                { tokenId: '3', earnedAt: { seconds: new Date().getTime() / 1000 } },
                { tokenId: '4', earnedAt: { seconds: new Date().getTime() / 1000 } },
                { tokenId: '5', earnedAt: { seconds: new Date().getTime() / 1000 } },
            ];
            window.isSpinning = false;
        }""")

        # Re-run updateUI to reflect the mocked state
        await page.evaluate("window.updateUI()")

        # Click the spin x5 button
        await page.locator("#spin-x5-button").click()

        # Wait for the multi-win modal to appear
        multi_win_modal = page.locator(".multi-win-modal")
        await expect(multi_win_modal).to_be_visible(timeout=10000)

        # Take a screenshot of the modal
        await page.screenshot(path="jules-scratch/verification/verification.png")

        await browser.close()

asyncio.run(main())
