from playwright.sync_api import sync_playwright
import os

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        # Get the absolute path to the HTML file
        file_path = os.path.abspath('jules-scratch/verification/verify.html')

        # Navigate to the local HTML file
        page.goto(f'file://{file_path}')

        # Take a screenshot of the section
        glance_section = page.locator("#prize-at-a-glance")
        glance_section.screenshot(path="jules-scratch/verification/verification.png")

        browser.close()

run()
