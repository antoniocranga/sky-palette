import AxeBuilder from "@axe-core/playwright";
import { test, expect, gotoGallery, gotoHome, openFirstDay } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousViolations(page: import("@playwright/test").Page, label: string): Promise<void> {
  await page.waitForTimeout(350);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  const description = blocking
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.help}\n${violation.nodes.map((node) => node.target.join(" ")).slice(0, 5).join("\n")}`)
    .join("\n\n");
  expect(blocking, `${label} accessibility violations:\n${description}`).toEqual([]);
}

test.describe("accessibility", () => {
  test("home has no serious or critical axe violations", async ({ page }) => {
    await gotoHome(page);
    await expectNoSeriousViolations(page, "home");
  });

  test("gallery has no serious or critical axe violations", async ({ page }) => {
    await gotoGallery(page);
    await expectNoSeriousViolations(page, "gallery");
  });

  test("day detail has no serious or critical axe violations", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    await expectNoSeriousViolations(page, "detail");
  });

  test("dialogs trap focus and expose accessible names", async ({ page }) => {
    await gotoHome(page);
    await page.locator('#screen-home [data-action="open-info"]').click();
    const dialog = page.getByRole("dialog", { name: "Sky Palette" });
    await expect(dialog).toBeVisible();

    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
    }
    const inside = await page.evaluate(() => Boolean(document.activeElement?.closest("#info-modal")));
    expect(inside).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
