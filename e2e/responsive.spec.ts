import { test, expect, gotoGallery, gotoHome, openFirstDay } from "./fixtures";
import { contrastRatio } from "../src/shared/color";
import { homeBackdropColor } from "../src/client/lib/contrast";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function assertNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  expect(metrics.scrollWidth, "horizontal overflow").toBeLessThanOrEqual(metrics.innerWidth + 1);
}

async function assertDockInside(page: import("@playwright/test").Page): Promise<Box> {
  const dock = page.locator("#app-dock");
  await expect(dock).toBeVisible();
  const box = await dock.boundingBox();
  expect(box, "dock has no box").not.toBeNull();
  if (!box) throw new Error("dock not measurable");
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  expect(box.y + box.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  return box;
}

async function assertPrimaryActionInside(page: import("@playwright/test").Page, selector: string): Promise<void> {
  const action = page.locator(selector).first();
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  expect(box, `${selector} has no box`).not.toBeNull();
  if (!box) return;
  const viewport = page.viewportSize();
  expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${selector} top`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
}

async function assertTapTargets(page: import("@playwright/test").Page, rootSelector: string): Promise<void> {
  const undersized = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [{ detail: "missing root", selector }];
    const elements = Array.from(
      root.querySelectorAll<HTMLElement>("button, [role=button], input, select, a[href]"),
    );
    const failures: string[] = [];
    for (const element of elements) {
      if (element.classList.contains("sr-only") || element.closest(".sr-only")) continue;
      if (element.closest("[hidden]")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < 43.5 || rect.height < 43.5) {
        const label = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 24) ?? element.id;
        failures.push(`${element.tagName.toLowerCase()}#${element.id || "-"}[${label}] ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
    }
    return failures;
  }, rootSelector);
  expect(undersized, `tap targets under 44px in ${rootSelector}`).toEqual([]);
}

async function assertFullBleed(page: import("@playwright/test").Page): Promise<void> {
  // Let the 250 ms screen transform settle before measuring the fixed box.
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    const active = document.querySelector<HTMLElement>(".app-screen.active");
    const top = document.querySelector<HTMLElement>("#safe-top-scrim");
    const bottom = document.querySelector<HTMLElement>("#safe-bottom-scrim");
    const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
    const rect = active?.getBoundingClientRect();
    const styleOf = (element: HTMLElement | null) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        pointerEvents: style.pointerEvents,
      };
    };
    return {
      top: rect?.top ?? Number.NaN,
      bottom: rect?.bottom ?? Number.NaN,
      innerHeight: window.innerHeight,
      meta,
      topScrim: styleOf(top),
      bottomScrim: styleOf(bottom),
    };
  });

  expect(data.top, "active screen should start at/above the top edge").toBeLessThanOrEqual(0);
  expect(data.bottom, "active screen should reach the bottom edge").toBeGreaterThanOrEqual(data.innerHeight);
  expect(data.meta).toContain("viewport-fit=cover");
  for (const scrim of [data.topScrim, data.bottomScrim]) {
    expect(scrim, "safe-area scrim should exist").not.toBeNull();
    expect(`${scrim?.backgroundImage} ${scrim?.backgroundColor}`).toContain("gradient");
    expect(scrim?.pointerEvents).toBe("none");
  }
}

async function assertHomeOverlap(page: import("@playwright/test").Page): Promise<void> {
  const dock = await page.locator("#app-dock").boundingBox();
  const ruler = await page.locator("#ruler-viewport").boundingBox();
  if (!dock || !ruler) return;
  const overlap =
    dock.x < ruler.x + ruler.width &&
    dock.x + dock.width > ruler.x &&
    dock.y < ruler.y + ruler.height &&
    dock.y + dock.height > ruler.y;
  expect(overlap, "dock overlaps ruler").toBe(false);
}

function parseColor(value: string): { color: string; alpha: number } {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value);
  if (!match) throw new Error(`Unexpected colour: ${value}`);
  const [, r, g, b, alpha] = match;
  const hex = `#${[r, g, b].map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return { color: hex, alpha: alpha === undefined ? 1 : Number(alpha) };
}

async function assertHeroContrast(page: import("@playwright/test").Page): Promise<void> {
  const data = await page.evaluate(() => {
    const screen = document.querySelector<HTMLElement>("#screen-home");
    if (!screen) return null;
    const styles = getComputedStyle(screen);
    const items = ["#home-city-label", ".home-suggest-strong", ".home-suggest-link"].map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        color: style.color,
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number(style.fontWeight),
        centerFraction: (rect.top + rect.height / 2 - screen.getBoundingClientRect().top) / screen.getBoundingClientRect().height,
      };
    });
    return {
      sky: {
        zenith: styles.getPropertyValue("--sky-zenith").trim() || "#121734",
        midsky: styles.getPropertyValue("--sky-midsky").trim() || "#2A1F42",
        horizon: styles.getPropertyValue("--sky-horizon").trim() || "#943440",
        sunglow: styles.getPropertyValue("--sky-sunglow").trim() || "#E06038",
      },
      items,
    };
  });

  expect(data).not.toBeNull();
  if (!data) return;
  for (const item of data.items) {
    if (!item) continue;
    const effective = homeBackdropColor(data.sky, item.centerFraction);
    const ink = parseColor(item.color).color;
    const ratio = contrastRatio(ink, effective);
    const large = item.fontSize >= 24 || (item.fontWeight >= 700 && item.fontSize >= 18.66);
    expect(ratio, `${item.selector} contrast ${ratio.toFixed(2)} on ${effective}`).toBeGreaterThanOrEqual(large ? 3 : 4.5);
  }
}

test.describe("responsive layout", () => {
  test("every screen: no overflow, dock and modal actions fit, 44px targets", async ({ page }) => {
    await gotoHome(page);
    await assertNoHorizontalOverflow(page);
    await assertFullBleed(page);
    await assertDockInside(page);
    await assertHomeOverlap(page);
    await assertTapTargets(page, "#screen-home");

    await gotoGallery(page);
    await assertNoHorizontalOverflow(page);
    await assertFullBleed(page);
    await assertDockInside(page);
    await assertTapTargets(page, "#screen-gallery");

    await openFirstDay(page);
    await assertNoHorizontalOverflow(page);
    await assertFullBleed(page);
    await assertDockInside(page);
    await assertTapTargets(page, "#screen-detail");
    await page.locator("#nav-btn-home").click();

    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await assertDockInside(page);
    await assertPrimaryActionInside(page, "#submit-btn");
    await assertTapTargets(page, "#submit-modal .modal-card");
    await page.keyboard.press("Escape");

    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveClass(/is-open/);
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await assertDockInside(page);
    await assertPrimaryActionInside(page, '#share-modal [data-action="download-card"]');
    await assertTapTargets(page, "#share-modal .modal-card");
    await page.keyboard.press("Escape");

    await page.locator('#screen-home [data-action="open-info"]').click();
    await expect(page.locator("#info-modal")).toHaveClass(/is-open/);
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await assertDockInside(page);
    await assertPrimaryActionInside(page, '#info-modal [data-action="close-info"]');
    await assertTapTargets(page, "#info-modal .modal-card");
    await page.keyboard.press("Escape");
  });

  test("home hero contrast and 200% text", async ({ page }) => {
    await gotoHome(page);
    await page.waitForTimeout(200);
    await assertHeroContrast(page);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(120);
    await assertNoHorizontalOverflow(page);
    const dock = await assertDockInside(page);
    expect(dock.width).toBeGreaterThan(0);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
  });

  test("WebKit modal scrim is static and the card appears immediately", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webkit-iphone-15-pro", "WebKit timing regression");
    await gotoGallery(page);
    const card = page.locator("#gallery-search-modal .modal-card");
    const visibleMs = await page.evaluate(async () => {
      const trigger = document.querySelector<HTMLElement>("#gallery-location-btn");
      const dialog = document.querySelector<HTMLElement>("#gallery-search-modal");
      const modalCard = dialog?.querySelector<HTMLElement>(".modal-card");
      if (!trigger || !dialog || !modalCard) return 999;
      const started = performance.now();
      trigger.click();
      while (performance.now() - started < 500) {
        const style = getComputedStyle(modalCard);
        const rect = modalCard.getBoundingClientRect();
        if (dialog.classList.contains("is-open") && style.visibility !== "hidden" && Number(style.opacity) > 0.05 && rect.height > 0) {
          return performance.now() - started;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return 999;
    });
    await expect(card).toBeVisible();
    console.log(`[webkit] gallery search card visible in ${visibleMs.toFixed(1)}ms`);

    const styles = await page.evaluate(() => {
      const backdrop = document.querySelector<HTMLElement>("#gallery-search-modal .modal-backdrop");
      const cardElement = document.querySelector<HTMLElement>("#gallery-search-modal .modal-card");
      if (!backdrop || !cardElement) return null;
      const backdropStyle = getComputedStyle(backdrop);
      return {
        filter: backdropStyle.backdropFilter,
        transition: backdropStyle.transitionDuration,
        cardOpacity: Number(getComputedStyle(cardElement).opacity),
        hoverNone: window.matchMedia("(hover: none)").matches,
      };
    });
    expect(styles).not.toBeNull();
    if (!styles) return;
    if (styles.hoverNone) expect(styles.filter === "none" || styles.filter === "").toBe(true);
    expect(styles.transition.split(",").every((value) => value.trim() === "0s")).toBe(true);
    expect(visibleMs).toBeLessThan(150);
  });

  test("gallery and detail content scroll clear of the dock", async ({ page }) => {
    await gotoGallery(page);
    const dockTop = async (): Promise<number> => {
      const dock = await page.locator("#app-dock").boundingBox();
      expect(dock).not.toBeNull();
      return dock?.y ?? 0;
    };
    const scrollGalleryToBottom = async (): Promise<void> => {
      await page.locator("#gallery-main").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(120);
    };
    const assertLastTileClears = async (label: string): Promise<void> => {
      const last = page.locator("#day-cards-grid .day-tile").last();
      await last.scrollIntoViewIfNeeded();
      await scrollGalleryToBottom();
      const tile = await last.boundingBox();
      expect(tile, `${label} last tile`).not.toBeNull();
      if (!tile) return;
      expect(tile.y + tile.height, `${label} last tile must clear the dock`).toBeLessThanOrEqual(
        (await dockTop()) - 1,
      );
    };

    await expect(page.locator("#day-cards-grid .day-tile")).toHaveCount(15, { timeout: 10_000 });
    await assertLastTileClears("15-day");

    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-30").click();
    await expect(page.locator("#day-cards-grid .day-tile")).toHaveCount(30, { timeout: 10_000 });
    await assertLastTileClears("30-day");

    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-7").click();
    await expect(page.locator("#day-cards-grid .day-tile")).toHaveCount(7, { timeout: 10_000 });
    await assertLastTileClears("7-day");

    await openFirstDay(page);
    await page.locator("#screen-detail").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(180);
    const photos = await page.locator("#detail-photos-section").boundingBox();
    expect(photos, "detail community section").not.toBeNull();
    if (!photos) return;
    expect(photos.y + photos.height, "detail community section must clear the dock").toBeLessThanOrEqual(
      (await dockTop()) - 1,
    );
  });

  test("detail scrolls on short screens and reduced motion is respected", async ({ page }) => {
    const viewport = page.viewportSize();
    await gotoGallery(page);
    await openFirstDay(page);

    if ((viewport?.height ?? 0) < 500) {
      const scrollable = await page.evaluate(() => {
        const detail = document.querySelector<HTMLElement>("#screen-detail");
        return detail ? detail.scrollHeight > detail.clientHeight + 1 : false;
      });
      expect(scrollable, "detail should scroll on a short viewport").toBe(true);

      await page.locator("#swatch-cloudtint").evaluate((element) => element.scrollIntoView({ block: "center" }));
      const swatches = page.locator("#screen-detail .copy-swatch");
      await expect(swatches).toHaveCount(5);
      for (let index = 0; index < 5; index += 1) {
        const box = await swatches.nth(index).boundingBox();
        expect(box).not.toBeNull();
        if (!box) continue;
        expect(box.y).toBeGreaterThanOrEqual(-1);
        expect(box.y + box.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
      }
      await assertDockInside(page);
    }

    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoHome(page);
    const timing = await page.evaluate(() => {
      const screen = document.querySelector<HTMLElement>("#screen-home");
      const skeleton = document.querySelector<HTMLElement>(".skeleton-tile");
      const dot = document.querySelector<HTMLElement>("#ruler-live-dot");
      return {
        durations: screen ? getComputedStyle(screen).transitionDuration.split(",").map((value) => value.trim()) : [],
        dotDuration: dot ? getComputedStyle(dot).transitionDuration.split(",").map((value) => value.trim()) : [],
        skeletonAnimation: skeleton ? getComputedStyle(skeleton).animationName : "none",
        animating: document.querySelectorAll(".is-animating").length,
      };
    });
    expect(timing.durations.every((value) => value === "0s")).toBe(true);
    expect(timing.dotDuration.every((value) => value === "0s")).toBe(true);
    expect(timing.animating).toBe(0);
    expect(timing.skeletonAnimation).toBe("none");
  });
});
