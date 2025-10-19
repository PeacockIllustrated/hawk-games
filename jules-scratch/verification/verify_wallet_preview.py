from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch()
    context = browser.new_context()
    page = context.new_page()

    # Go to the main competitions page
    page.goto("http://localhost:8000/competitions.html")

    # Wait for the first competition card to be loaded and visible
    first_competition_card = page.locator(".hawk-card[href*='competition.html']").first
    first_competition_card.wait_for(state="visible")

    # Get the href to verify navigation later
    comp_href = first_competition_card.get_attribute("href")

    # Click the first competition card
    first_competition_card.click()

    # Wait for the competition page to load
    page.wait_for_url(f"**/{comp_href}")

    # Enable the wallet demo feature flag
    page.evaluate('localStorage.setItem("wallet_demo", "1")')

    # Reload the page to apply the feature flag
    page.reload()

    # Wait for the wallet preview to be visible
    wallet_preview = page.locator("#wallet-demo")
    wallet_preview.wait_for(state="visible")

    # Take a screenshot of the wallet preview
    page.screenshot(path="jules-scratch/verification/wallet_preview.png")

    # Click the Apple Pay button
    page.locator('[data-wallet="apple"]').click()

    # Wait for the confirmation page to load
    page.wait_for_url("**/wallet-confirmation.html**")

    # Take a screenshot of the confirmation page
    page.screenshot(path="jules-scratch/verification/wallet_confirmation.png")

    browser.close()

with sync_playwright() as playwright:
    run(playwright)
