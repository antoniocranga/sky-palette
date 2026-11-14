import { test, gotoHome } from "./fixtures";
test("focus dbg", async ({ page }) => {
  await gotoHome(page);
  await page.locator("#nav-btn-submit").click();
  const hour=page.locator("[data-time-hour]");
  await hour.click();
  console.log("after click", await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,120)));
  await page.keyboard.press("Tab");
  console.log("after tab", await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,160)));
});
