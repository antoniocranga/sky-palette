import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect, gotoGallery, gotoHome } from "./fixtures";

const REVIEW_DEVICES = new Set(["iphone-se", "iphone-15-pro", "ipad-mini", "desktop"]);

test("review screenshots", async ({ page }, testInfo) => {
  test.skip(!REVIEW_DEVICES.has(testInfo.project.name), "screenshot device");
  test.setTimeout(60_000);

  const root = join("docs", "assets", "review", "devices", testInfo.project.name);
  mkdirSync(root, { recursive: true });

  const capture = async (screen: string): Promise<void> => {
    const file = join(root, `${screen}.png`);
    await page.screenshot({ path: file, fullPage: false });
    expect(statSync(file).size, `${file} should not be blank`).toBeGreaterThan(5 * 1024);
  };

  await gotoHome(page);
  await page.waitForTimeout(350);
  await capture("home");

  await page.locator('#screen-home [data-action="open-info"]').click();
  await expect(page.locator("#info-modal")).toHaveClass(/is-open/);
  await page.waitForTimeout(350);
  await capture("info");
  await page.keyboard.press("Escape");
  await expect(page.locator("#info-modal")).not.toHaveClass(/is-open/);
  await page.waitForTimeout(300);

  await gotoGallery(page);
  await page.waitForTimeout(350);
  await capture("gallery");

  await page.locator("#day-cards-grid .day-tile").first().dispatchEvent("click");
  await page.waitForTimeout(120);
  await capture("gallery-to-detail");
  await expect(page.locator("#screen-detail")).toHaveClass(/active/);
  await expect(page.locator("#swatch-zenith")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.waitForTimeout(450);
  await capture("detail");

  await page.locator("#nav-btn-submit").click();
  await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
  await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
  await page.waitForTimeout(350);
  await capture("submit");

  await page.locator("#submit-location-input").fill("Tok");
  await expect(page.locator('#submit-location-dropdown [role="option"]').first()).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(200);
  await capture("submit-search");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.locator("#dock-share-btn").click();
  await expect(page.locator("#share-modal")).toHaveClass(/is-open/);
  await expect(page.locator("#studio-city")).not.toHaveText("—");
  await page.waitForTimeout(350);
  await capture("share");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Directory contains a stable, reviewable set for this device.
  expect(join(root, "home.png")).toContain(testInfo.project.name);
});
