import { test, expect, gotoGallery, gotoHome, openFirstDay, makePng, makePngWithGps } from "./fixtures";
import { contrastRatio, relativeLuminance } from "../src/shared/color";

const GOOD_PNG = makePng(800, 600);
const GPS_TOKYO_PNG = makePngWithGps(800, 600, 35.6762, 139.6503);

function rgbToHex(value: string): string {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (!match) throw new Error(`Unexpected rgb: ${value}`);
  return `#${[match[1], match[2], match[3]].map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

async function checkViewport(page: import("@playwright/test").Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);

  const dock = page.locator("#app-dock");
  await expect(dock).toBeVisible();
  const box = await dock.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(metrics.innerHeight + 1);
}


type ShareProbe = {
  calls: number;
  files: Array<{ name: string; type: string; size: number; width: number; height: number }>;
  title: string;
  text: string;
  openedUrl: string;
};

async function stubShareApi(
  page: import("@playwright/test").Page,
  options: { canShare?: boolean; abort?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ canShare, abort }) => {
      const probe = {
        calls: 0,
        files: [] as Array<{ name: string; type: string; size: number; width: number; height: number }>,
        title: "",
        text: "",
        openedUrl: "",
      };
      (window as Window & { __shareProbe?: typeof probe }).__shareProbe = probe;
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: (data: { files?: File[] }) => Boolean(canShare && data && data.files && data.files.length > 0),
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: { files?: File[]; title?: string; text?: string }) => {
          probe.calls += 1;
          probe.title = data.title ?? "";
          probe.text = data.text ?? "";
          const file = data.files?.[0];
          if (file) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const view = new DataView(bytes.buffer);
            probe.files.push({
              name: file.name,
              type: file.type,
              size: file.size,
              width: view.getUint32(16),
              height: view.getUint32(20),
            });
          }
          if (abort) throw new DOMException("Share cancelled", "AbortError");
        },
      });
      Object.defineProperty(window, "open", {
        configurable: true,
        value: (url?: string | URL | null) => {
          probe.openedUrl = String(url ?? "");
          return null;
        },
      });
    },
    { canShare: options.canShare ?? true, abort: options.abort ?? false },
  );
}

async function readShareProbe(page: import("@playwright/test").Page): Promise<ShareProbe> {
  return page.evaluate(() => {
    const probe = (window as Window & { __shareProbe?: ShareProbe }).__shareProbe;
    return probe ?? { calls: 0, files: [], title: "", text: "", openedUrl: "" };
  });
}

test.describe("Sky Palette app", () => {
  // Every assertion is written against this fixed instant, so a CI run at
  // midnight cannot change the live step, clock or date-derived URL.
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-14T14:15:00Z"));
  });

  test("home renders real palette, solar and weather values", async ({ page }) => {
    await gotoHome(page);

    await expect(page.locator("#home-city-label")).toHaveText("Bucharest");
    await expect(page.locator("#home-elevation")).toHaveText(/^[+-]\d+\.\d°$/);
    await expect(page.locator("#home-azimuth")).toHaveText(/^\d{1,3}°$/);
    await expect(page.locator("#home-phase")).toHaveText(/Solar Day|Afternoon|Golden Hour|Sunset|Dusk|Night/);
    await expect(page.locator("#home-sunrise")).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator("#home-sunset")).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator("#home-clouds")).toHaveText(/^\d{1,3}%\/\d{1,3}%\/\d{1,3}%$/);
    await expect(page.locator("#bucharest-clock")).toHaveText(/^\d{2}:\d{2}/);
    await expect(page.locator("#ruler-time-display")).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator("#home-mode-badge")).toHaveText("live");
    await expect(page.locator("#home-mode-badge")).toBeVisible();
    await expect(page.locator("#screen-home")).not.toContainText(/forecast/i);
    await expect(page.locator("#ruler-live-dot")).toBeVisible();

    const background = await page.locator("#sky-backdrop").evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(background).toContain("gradient");
  });

  test("live clock stays put while the scrubber moves and the live dot renders", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("#city-search-input")).toHaveAttribute(
      "placeholder",
      "Search the location of your sky",
    );
    const clock = await page.locator("#bucharest-clock").textContent();
    expect(clock).toMatch(/^\d{2}:\d{2}/);
    await expect(page.locator("#home-mode-badge")).toBeVisible();
    expect(await page.locator("#ruler-live-dot").evaluate((element) => element.parentElement?.classList.contains("is-live"))).toBe(true);
    expect(
      await page.locator("#ruler-live-dot").evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration)),
    ).toBeGreaterThan(0.1);

    const display = page.locator("#ruler-time-display");
    const before = await display.textContent();
    await page.locator("#ruler-viewport").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(display).not.toHaveText(before ?? "");
    await expect(page.locator("#bucharest-clock")).toHaveText(clock ?? "");
    await expect(page.locator("#home-mode-badge")).toBeHidden();
    await expect(page.locator("#ruler-live-dot")).toBeVisible();
    await expect(page.locator("#screen-home")).not.toContainText(/forecast/i);
  });

  test("first paint uses a neutral backdrop and an empty clock", async ({ page, api }) => {
    api.delayPalette(600);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const state = await page.evaluate(() => {
      const backdrop = document.querySelector<HTMLElement>("#sky-backdrop");
      const screen = document.querySelector<HTMLElement>("#screen-home");
      const hero = document.querySelector<HTMLElement>("#main-home");
      const clock = document.querySelector<HTMLElement>("#bucharest-clock");
      return {
        backdropImage: backdrop ? getComputedStyle(backdrop).backgroundImage : "",
        backdropColour: backdrop ? getComputedStyle(backdrop).backgroundColor : "",
        screenImage: screen ? getComputedStyle(screen).backgroundImage : "",
        clock: clock?.textContent?.trim() ?? "",
        ready: hero?.dataset.skyReady ?? "",
      };
    });
    const allBackgrounds = `${state.backdropImage} ${state.backdropColour} ${state.screenImage}`.toLowerCase();
    expect(allBackgrounds).not.toContain("e06038");
    expect(allBackgrounds).not.toContain("rgb(224, 96, 56)");
    expect(state.backdropImage).toBe("none");
    expect(state.clock).not.toMatch(/\d{2}:\d{2}/);
    expect(state.ready).toBe("false");

    const shell = await page.evaluate(() => {
      const visible = (selector: string): boolean => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      };
      const search = document.querySelector<HTMLElement>("#city-search-input")?.getBoundingClientRect();
      return {
        location: visible("#home-city-label"),
        search: visible("#city-search-input"),
        suggestions: visible("#screen-home .home-suggest"),
        info: visible('#screen-home [data-action="open-info"]'),
        searchTop: search?.top ?? 0,
        booting: document.body.hasAttribute("data-booting"),
      };
    });
    expect(shell).toMatchObject({ location: true, search: true, suggestions: true, info: true, booting: false });

    await expect(page.locator("#bucharest-clock")).toHaveText(/\d{2}:\d{2}/, { timeout: 5000 });
    const settledTop = await page.locator("#city-search-input").evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(settledTop - shell.searchTop)).toBeLessThanOrEqual(1);
  });

  test("WebKit submit modal is populated and scrolls to the action", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webkit-iphone-15-pro", "WebKit-only regression");
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    const modal = page.locator("#submit-modal");
    await expect(modal).toHaveClass(/is-open/);
    const card = modal.locator(".modal-card");
    await expect(card).toContainText("Share a photo of your sky");
    const cardBox = await card.boundingBox();
    expect(cardBox?.height ?? 0).toBeGreaterThan(300);
    await expect(page.locator("#upload-dropzone")).toBeVisible();
    await expect(page.locator("#submit-location-input")).toBeVisible();
    await expect(page.locator("#turnstile-box")).toBeVisible();
    await page.locator("#submit-btn").scrollIntoViewIfNeeded();
    await expect(page.locator("#submit-btn")).toBeVisible();
    const buttonBox = await page.locator("#submit-btn").boundingBox();
    expect(buttonBox).not.toBeNull();
    if (buttonBox) expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(852 + 1);
  });

  test("scrubbing the day detail changes the swatch hex", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);

    const hex = page.locator("#zenith-hex");
    const before = await hex.textContent();
    expect(before).toMatch(/^#[0-9A-F]{6}$/);

    const viewport = page.locator("#detail-ruler-viewport");
    await viewport.scrollIntoViewIfNeeded();
    const box = await viewport.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 190, y, { steps: 12 });
    await page.mouse.up();

    await expect(hex).not.toHaveText(before ?? "", { timeout: 5000 });
    await expect(hex).toHaveText(/^#[0-9A-F]{6}$/);
    await expect(page.locator("#hud-solar-metrics")).toHaveText(/Sun elevation: [+-]\d+\.\d° · Azimuth: \d{1,3}°/);
    await expect(page.locator("#detail-ruler-time-display")).toHaveText(/^\d{2}:\d{2}$/);
  });

  test("city search picks a city and updates the URL and palette", async ({ page }) => {
    await gotoHome(page);

    const input = page.locator("#city-search-input");
    await input.focus();
    const focusStyle = await page.locator(".search-pill-dark").evaluate((element) => {
      const style = getComputedStyle(element);
      const field = element.querySelector("input");
      return {
        shadow: style.boxShadow,
        inputOutline: field ? getComputedStyle(field).outlineStyle : "missing",
      };
    });
    expect(focusStyle.shadow).not.toBe("none");
    expect(focusStyle.inputOutline).toBe("none");
    await input.fill("Tokyo");
    const option = page.getByRole("option", { name: /Tokyo/ });
    await expect(option).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#city-dropdown [role="option"]').first()).toHaveAttribute("aria-selected", "false");
    await expect(option).toContainText("Tokyo · Japan");
    await expect(option).not.toContainText(/\d+(\.\d+)?k|\d+(\.\d+)?M/);
    await expect(option.locator("svg")).toHaveCount(2);
    await option.click();

    await expect(page).toHaveURL(/city=tokyo-japan/);
    await expect(page.locator("#home-city-label")).toHaveText("Tokyo");
    await expect(page.locator("#home-elevation")).not.toHaveText("—", { timeout: 10_000 });
    await expect(page.locator("#home-sunrise")).toHaveText(/^\d{2}:\d{2}$/);

    const toast = page.locator("#toast");
    await expect(toast).toHaveClass(/is-visible/);
    await page.waitForTimeout(120);
    const toastBox = await toast.boundingBox();
    const viewport = page.viewportSize();
    expect(toastBox).not.toBeNull();
    if (toastBox && viewport) {
      expect(Math.abs(toastBox.x + toastBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
    }

    const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    expect(storage).toEqual({ "sky-palette.city": "tokyo-japan" });

    await page.goto("/");
    await expect(page.locator("#home-city-label")).toHaveText("Tokyo", { timeout: 10_000 });

    await page.goto("/?city=paris-france");
    await expect(page.locator("#home-city-label")).toHaveText("Paris", { timeout: 10_000 });
    // A URL slug wins for this load but hydration must not overwrite the preference.
    expect(await page.evaluate(() => localStorage.getItem("sky-palette.city"))).toBe("tokyo-japan");
  });

  test("chosen city survives a bare reload and clearing storage restores Bucharest", async ({ page }) => {
    await gotoHome(page);
    const input = page.locator("#city-search-input");
    await input.fill("Tokyo");
    const option = page.getByRole("option", { name: /Tokyo/ });
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();
    await expect(page.locator("#home-city-label")).toHaveText("Tokyo");
    await expect(page.locator("#home-elevation")).not.toHaveText("—", { timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem("sky-palette.city"))).toBe("tokyo-japan");

    await page.goto("/");
    await expect(page.locator("#home-city-label")).toHaveText("Tokyo", { timeout: 10_000 });

    await page.evaluate(() => {
      localStorage.clear();
      window.history.replaceState({}, "", "/");
    });
    await page.reload();
    await expect(page.locator("#home-city-label")).toHaveText("Bucharest", { timeout: 10_000 });
    await expect(page.locator("#home-elevation")).not.toHaveText("—", { timeout: 10_000 });
  });

  test("deep link hydrates detail day, time and five swatches", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&view=detail&day=2026-11-14&time=16%3A49&interval=15");
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator("#detail-title")).toHaveText("Nov 14 · Bucharest");
    await expect(page.locator("#detail-ruler-time-display")).toHaveText("16:49");
    for (const name of ["zenith", "midsky", "horizon", "sunglow", "cloudtint"]) {
      await expect(page.locator(`#${name}-hex`)).toHaveText(/^#[0-9A-F]{6}$/);
    }
    const url = new URL(page.url());
    expect(url.searchParams.get("view")).toBe("detail");
    expect(url.searchParams.get("day")).toBe("2026-11-14");
    expect(url.searchParams.get("time")).toBe("16:49");
  });

  test("browser Back restores gallery then home", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-gallery").click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("gallery");
    await openFirstDay(page);
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("detail");
    await page.goBack();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await page.goBack();
    await expect(page.locator("#screen-home")).toHaveClass(/active/);
  });

  test("detail to home clears day and time and reload stays home", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&view=detail&day=2026-11-14&time=16%3A49&interval=15");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await page.locator("#nav-btn-home").click();
    await expect(page.locator("#screen-home")).toHaveClass(/active/);
    await expect.poll(() => new URL(page.url()).searchParams.get("view"), { timeout: 2000 }).toBe("home");
    const url = new URL(page.url());
    expect(url.searchParams.has("day")).toBe(false);
    expect(url.searchParams.has("time")).toBe(false);
    expect(url.searchParams.has("interval")).toBe(false);

    await page.reload();
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#screen-home")).toHaveClass(/active/);
    await expect(page.locator("#screen-detail")).not.toHaveClass(/active/);
    const reloaded = new URL(page.url());
    expect(reloaded.searchParams.get("view")).toBe("home");
    expect(reloaded.searchParams.has("day")).toBe(false);
    expect(reloaded.searchParams.has("time")).toBe(false);
  });

  test("detail to gallery clears day and time but keeps interval", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&view=detail&day=2026-11-14&time=16%3A49&interval=15");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await page.locator('#screen-detail [data-action="nav"][data-screen="gallery"]').click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect.poll(() => new URL(page.url()).searchParams.get("view"), { timeout: 2000 }).toBe("gallery");
    const url = new URL(page.url());
    expect(url.searchParams.has("day")).toBe(false);
    expect(url.searchParams.has("time")).toBe(false);
    expect(url.searchParams.get("interval")).toBe("15");

    await page.reload();
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get("interval")).toBe("15");
  });

  test("home to gallery to detail walks Back through all three screens", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-gallery").click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("gallery");
    await openFirstDay(page);
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("detail");
    await expect(new URL(page.url()).searchParams.get("view")).toBe("detail");

    await page.goBack();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get("view")).toBe("gallery");
    expect(new URL(page.url()).searchParams.has("day")).toBe(false);

    await page.goBack();
    await expect(page.locator("#screen-home")).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get("view")).toBe("home");
    expect(new URL(page.url()).searchParams.has("time")).toBe(false);
  });

  test("deep link with day and time but no view opens detail", async ({ page }) => {
    await page.goto("/?day=2026-11-10&time=16%3A55");
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator("#detail-ruler-time-display")).toHaveText("16:55");
    await expect.poll(() => new URL(page.url()).searchParams.get("view"), { timeout: 2000 }).toBe("detail");
    expect(new URL(page.url()).searchParams.get("day")).toBe("2026-11-10");
    expect(new URL(page.url()).searchParams.get("time")).toBe("16:55");
  });

  test("gallery interval survives reload but resets on the next gallery entry from home", async ({ page }) => {
    await gotoGallery(page);
    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-30").click();
    await expect(page.locator("#current-interval-label")).toHaveText("30-Day Mosaic");
    await expect.poll(() => new URL(page.url()).searchParams.get("interval")).toBe("30");

    await page.reload();
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect(page.locator("#current-interval-label")).toHaveText("30-Day Mosaic");
    expect(new URL(page.url()).searchParams.get("interval")).toBe("30");

    await page.locator("#nav-btn-home").click();
    await expect(page.locator("#screen-home")).toHaveClass(/active/);
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("home");
    expect(new URL(page.url()).searchParams.has("interval")).toBe(false);

    await page.locator("#nav-btn-gallery").click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect.poll(() => new URL(page.url()).searchParams.get("interval")).toBe("15");
    await expect(page.locator("#current-interval-label")).toHaveText("15-Day Mosaic");
  });

  test("scrubbing updates the URL time only after settle", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&view=detail&day=2026-11-14&time=16%3A49&interval=15");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await page.waitForTimeout(350);
    const before = new URL(page.url()).searchParams.get("time");
    await page.locator("#detail-ruler-viewport").focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => new URL(page.url()).searchParams.get("time"), { timeout: 2000 }).not.toBe(before);
    const after = new URL(page.url()).searchParams.get("time");
    expect(after).toMatch(/^\d{2}:\d{2}$/);
    expect(new URL(page.url()).searchParams.get("view")).toBe("detail");
    expect(new URL(page.url()).searchParams.get("day")).toBe("2026-11-14");
  });

  test("Copy link shares the current deep link", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&view=detail&day=2026-11-14&time=16%3A49&interval=15");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await page.evaluate(() => {
      (window as Window & { __copied?: string }).__copied = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { (window as Window & { __copied?: string }).__copied = text; } },
      });
    });
    await page.locator("#dock-share-btn").click();
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect.poll(async () => page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? "")).not.toBe("");
    const copied = new URL(await page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? ""));
    expect(copied.searchParams.get("city")).toBe("bucharest-romania");
    expect(copied.searchParams.get("view")).toBe("detail");
    expect(copied.searchParams.get("day")).toBe("2026-11-14");
    expect(copied.searchParams.get("time")).toBe("16:49");
    expect(copied.searchParams.get("interval")).toBe("15");
  });

  test("interval changes update the URL", async ({ page }) => {
    await gotoGallery(page);
    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-30").click();
    await expect(page.locator("#day-cards-grid .day-tile")).toHaveCount(30);
    await expect.poll(() => new URL(page.url()).searchParams.get("interval")).toBe("30");
    expect(new URL(page.url()).searchParams.get("view")).toBe("gallery");
  });

  test("home boots from a ?city= deep link", async ({ page }) => {
    await page.goto("/?city=tokyo-japan");
    await expect(page.locator("#home-city-label")).toHaveText("Tokyo", { timeout: 10_000 });
    await expect(page.locator("#home-elevation")).not.toHaveText("—", { timeout: 10_000 });
    await expect(page).toHaveURL(/city=tokyo-japan/);
  });

  test("gallery first tile centre is not intercepted by fixed controls", async ({ page }) => {
    await gotoGallery(page);
    const tile = page.locator("#day-cards-grid .day-tile").first();
    const box = await tile.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const hit = await page.evaluate(
      ({ x, y }) => {
        const target = document.elementFromPoint(x, y) as HTMLElement | null;
        const first = document.querySelector<HTMLElement>("#day-cards-grid .day-tile");
        return {
          isTile: Boolean(first && target && (target === first || first.contains(target))),
          tag: target?.tagName ?? null,
          action: target?.closest<HTMLElement>("[data-action]")?.dataset.action ?? null,
        };
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit.isTile, `centre hit ${hit.tag} (${hit.action}) instead of the tile`).toBe(true);

    await tile.click();
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
  });

  test("gallery location and interval share one top row", async ({ page }) => {
    await gotoGallery(page);
    const location = page.locator("#gallery-location-btn");
    const interval = page.locator("#interval-trigger-btn");
    const locationBox = await location.boundingBox();
    const intervalBox = await interval.boundingBox();
    expect(locationBox).not.toBeNull();
    expect(intervalBox).not.toBeNull();
    if (!locationBox || !intervalBox) return;
    expect(Math.abs(locationBox.y - intervalBox.y)).toBeLessThanOrEqual(40);
    expect(Math.round(locationBox.height)).toBeGreaterThanOrEqual(44);
    expect(Math.round(intervalBox.height)).toBeGreaterThanOrEqual(44);
    await expect(location).toHaveCSS("border-top-width", "0px");
    await expect(location).toHaveCSS("box-shadow", "none");
    await expect(location).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(location).toHaveCSS("background-color", "rgba(0, 0, 0, 0.8)");
  });

  test("safe-area scrims fade every screen above content and below controls", async ({ page }) => {
    const assertScrims = async (label: string): Promise<void> => {
      for (const id of ["safe-top-scrim", "safe-bottom-scrim"]) {
        const scrim = page.locator(`#${id}`);
        await expect(scrim, `${label} ${id}`).toHaveCount(1);
        await expect(scrim).toHaveCSS("pointer-events", "none");
        await expect(scrim).toHaveCSS("z-index", "35");
        const styles = await scrim.evaluate((element) => {
          const style = getComputedStyle(element);
          return { backgroundImage: style.backgroundImage, height: element.getBoundingClientRect().height };
        });
        expect(styles.backgroundImage, `${label} ${id} gradient`).toContain("linear-gradient");
        expect(styles.height, `${label} ${id} fade height`).toBeGreaterThan(0);
      }
    };

    await gotoHome(page);
    await assertScrims("home");
    await gotoGallery(page);
    await assertScrims("gallery");
    await openFirstDay(page);
    await assertScrims("detail");
  });

  test("gallery loads 15 days and toggles 7 / 30", async ({ page }) => {
    await gotoGallery(page);

    const tiles = page.locator("#day-cards-grid .day-tile");
    await expect(tiles).toHaveCount(15);
    await expect(page.locator("#current-interval-label")).toHaveText("15-Day Mosaic");

    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-7").click();
    await expect(tiles).toHaveCount(7);
    await expect(page.locator("#current-interval-label")).toHaveText("7-Day Mosaic");

    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-30").click();
    await expect(tiles).toHaveCount(30);
    await expect(page.locator("#current-interval-label")).toHaveText("30-Day Mosaic");
  });

  test("day detail opens with swatches, metrics and community photos", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);

    await expect(page.locator("#detail-title")).toContainText("Bucharest");
    await expect(page.locator("#detail-title")).toHaveText(/^[A-Z][a-z]{2} \d{1,2} · Bucharest$/);
    await expect(page.locator("#hud-time")).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator("#detail-sunrise")).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator("#detail-golden")).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator("#detail-sunset")).toHaveText(/^\d{2}:\d{2}$/);

    for (const name of ["zenith", "midsky", "horizon", "sunglow", "cloudtint"]) {
      await expect(page.locator(`#${name}-hex`)).toHaveText(/^#[0-9A-F]{6}$/);
    }

    await expect(page.locator("#detail-photos-section")).toBeVisible();
    const photos = page.locator("#detail-photos .photo-tile");
    await expect(photos).toHaveCount(2);
    const images = page.locator("#detail-photos .photo-tile img");
    await expect(images).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      const image = images.nth(index);
      expect(await image.getAttribute("src")).toContain("/photos/thumb-");
      await expect(image).toHaveAttribute("loading", "lazy");
      expect(Number(await image.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(await image.getAttribute("height"))).toBeGreaterThan(0);
      await expect(image).toHaveAttribute("alt", /Sky photo by @sky-bucharest-/);
    }

    await page.locator("#detail-photos .photo-tile").first().click();
    await expect(page.locator("#ref-photo-overlay")).toHaveClass(/is-visible/);
    await expect(page.locator("#ref-photo-author")).toHaveText("@sky-bucharest-48b");
    await page.locator('#ref-photo-overlay [data-action="clear-reference"]').click();
    await expect(page.locator("#ref-photo-overlay")).not.toHaveClass(/is-visible/);
  });

  test("detail renders a designed empty community state", async ({ page, api }) => {
    api.emptyGallery();
    await gotoGallery(page);
    await openFirstDay(page);

    await expect(page.locator("#detail-photos-section")).toBeVisible();
    await expect(page.locator("#detail-photos-empty")).toBeVisible();
    await expect(page.locator("#detail-photos-empty-title")).toHaveText(
      "No community captures for this day yet — be the first",
    );
    await expect(page.locator("#detail-photos-section")).toContainText(
      "Contribute with the Submit button in the bottom navigation.",
    );
    await expect(page.locator("#detail-photos-empty button, #detail-photos-empty a")).toHaveCount(0);
    await expect(page.locator("#detail-photos .photo-tile")).toHaveCount(0);
  });

  test("submit happy path shows the handle and pending review", async ({ page, api }) => {
    await gotoHome(page);
    await page.locator('#nav-btn-submit').click();

    const modal = page.locator("#submit-modal");
    await expect(modal).toHaveClass(/is-open/);
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
    await expect(page.locator("#submit-time-stepper")).toBeVisible();
    await expect(page.locator('input[type="time"]')).toHaveCount(0);
    await expect(page.locator("#submit-palette-empty")).toBeVisible();
    const appearance = await page.evaluate(
      () => (window as Window & { __turnstileOptions?: { appearance?: string; size?: string } }).__turnstileOptions,
    );
    expect(appearance?.appearance).toBe("interaction-only");
    expect(appearance?.size).toBe("compact");
    await expect(page.locator("#bot-status-label")).toHaveText("Protected");
    expect(await page.locator("#bot-status").getAttribute("title")).toContain("Cloudflare Turnstile");
    await expect(page.locator("#turnstile-spinner")).toBeHidden();
    await expect(page.locator("#turnstile-box")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator("#submit-location-input")).toHaveAttribute(
      "placeholder",
      "Search the location of your sky",
    );
    await expect(page.locator("#submit-modal")).toContainText("Photos are reviewed before publication");

    await page.locator("#sky-file-input").setInputFiles({
      name: "sky.png",
      mimeType: "image/png",
      buffer: GOOD_PNG,
    });

    await expect(page.locator("#submit-file-meta")).toContainText("WebP");
    await expect(page.locator("#submit-location-input")).toHaveValue("Bucharest, Romania");
    await expect(page.locator("#from-photo-badge")).toBeHidden();
    await expect(page.locator("#photo-location-hint")).toBeHidden();
    await expect(page.locator("#submit-palette-result")).toBeVisible();
    await expect(page.locator("#submit-palette-empty")).toBeHidden();
    await expect(page.locator("#submit-color-status")).toBeHidden();
    await expect(page.locator("#submit-btn")).toBeEnabled();
    await page.locator("#submit-btn").click();

    await expect(page.locator("#submit-success")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#submit-success-handle")).toHaveText("sky-bucharest-48b");
    await expect(page.locator("#submit-success")).toContainText("pending review");
    expect(api.requests.some((request) => request.startsWith("POST /api/submit"))).toBe(true);
    expect(api.lastSubmitBody).toContain('name="thumb"');
    expect(api.lastSubmitBody).toContain("sky-thumb-");
    console.log(`[submit] multipart body ${api.lastSubmitBody?.length ?? 0} chars; thumb part ${api.lastThumbBytes ?? 0} bytes`);
  });

  test("photo GPS fills the location and shows the From photo badge", async ({ page, api }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
    await expect(page.locator("#submit-modal")).toContainText(
      "If your photo includes GPS, we use it to suggest the location. It is removed before upload.",
    );

    const input = page.locator("#submit-location-input");
    await expect(input).toHaveValue("Bucharest, Romania");
    await page.locator("#sky-file-input").setInputFiles({
      name: "gps.png",
      mimeType: "image/png",
      buffer: GPS_TOKYO_PNG,
    });

    await expect(input).toHaveValue("Tokyo, Japan", { timeout: 8000 });
    const badge = page.locator("#from-photo-badge");
    await expect(badge).toBeVisible();
    expect(await badge.getAttribute("title")).toContain("removed before upload");
    await expect(page.locator("#submit-btn")).toBeEnabled();
    await page.locator("#submit-btn").click();
    await expect(page.locator("#submit-success")).toBeVisible({ timeout: 10_000 });
    expect(api.lastSubmitBody).toContain("35.6762");
  });

  test("a deliberate location is not clobbered by photo GPS", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
    const input = page.locator("#submit-location-input");
    await input.fill("My observatory");
    await page.locator("#sky-file-input").setInputFiles({
      name: "gps.png",
      mimeType: "image/png",
      buffer: GPS_TOKYO_PNG,
    });

    await expect(input).toHaveValue("My observatory");
    const hint = page.locator("#photo-location-hint");
    await expect(hint).toBeVisible({ timeout: 8000 });
    const usePhoto = page.locator('[data-action="use-photo-location"]');
    await expect(page.locator("#submit-location-dropdown")).toBeHidden();
    const firstBox = await usePhoto.boundingBox();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const secondBox = await usePhoto.boundingBox();
    expect(secondBox).toEqual(firstBox);
    await usePhoto.click();
    await expect(input).toHaveValue("Tokyo, Japan");
    await expect(page.locator("#from-photo-badge")).toBeVisible();
    await expect(hint).toBeHidden();
  });

  test("submit rejects an image that is too small before upload", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });

    await page.locator("#sky-file-input").setInputFiles({
      name: "tiny.png",
      mimeType: "image/png",
      buffer: makePng(300, 300),
    });

    await expect(page.locator("#submit-error")).toBeVisible();
    await expect(page.locator("#submit-error-text")).toContainText("300×300");
    await expect(page.locator("#submit-error-text")).toContainText("400 px");
    await expect(page.locator("#submit-btn")).toBeDisabled();
    await expect(page.locator("#upload-preview")).toBeHidden();
  });

  test("submit fields share one geometry and the time stepper stays keyboard accessible", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);

    const fields = page.locator("#submit-modal .field-shell");
    await expect(fields).toHaveCount(3);
    const geometry = await fields.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          radius: style.borderRadius,
          border: style.borderTopWidth,
        };
      }),
    );
    for (const item of geometry) {
      expect(item.height).toBeCloseTo(geometry[0]!.height, 1);
      expect(item.paddingLeft).toBe(geometry[0]!.paddingLeft);
      expect(item.paddingRight).toBe(geometry[0]!.paddingRight);
      expect(item.radius).toBe(geometry[0]!.radius);
      expect(item.border).toBe(geometry[0]!.border);
      expect(item.border).toBe("0px");
    }

    const hour = page.locator("[data-time-hour]");
    const minute = page.locator("[data-time-minute]");
    const beforeHour = Number(await hour.textContent());
    await hour.click();
    await expect(hour).toHaveClass(/is-selected/);
    await expect(hour).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.keyboard.press("ArrowUp");
    await expect(hour).toHaveText(String((beforeHour + 1) % 24).padStart(2, "0"));
    await page.keyboard.press("Tab");
    await expect(minute).toBeFocused();
    await expect(minute).toHaveClass(/is-selected/);
    const beforeMinute = Number(await minute.textContent());
    await page.keyboard.press("ArrowUp");
    await expect(minute).toHaveText(String((beforeMinute + 1) % 60).padStart(2, "0"));
    for (const locator of [hour, minute, page.locator("[data-time-decrease]"), page.locator("[data-time-increase]")]) {
      const box = await locator.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    const regen = await page.locator('[data-action="randomize-handle"]').boundingBox();
    const hourBox = await hour.boundingBox();
    expect(regen?.height).toBeCloseTo(hourBox?.height ?? 0, 0);
  });

  test("submit location searches cities without moving the app city", async ({ page, api }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    const input = page.locator("#submit-location-input");
    await expect(input).toHaveAttribute("placeholder", "Search the location of your sky");
    await input.click();
    await page.waitForTimeout(220);
    expect(await page.locator(".search-field--form").evaluate((element) => getComputedStyle(element).boxShadow)).toContain(
      "rgb(0, 0, 0)",
    );
    await input.fill("Tok");
    await expect(page.locator('#submit-location-dropdown [role="option"]').first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#submit-location-dropdown")).toBeHidden();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(input).toBeFocused();
    await input.fill("Tokyo");
    const option = page.locator('#submit-location-dropdown [role="option"]').first();
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();
    await expect(input).toHaveValue("Tokyo, Japan");
    await expect(input).toBeFocused();
    await expect(page.locator("#home-city-label")).toHaveText("Bucharest");

    await page.locator("#sky-file-input").setInputFiles({ name: "sky.png", mimeType: "image/png", buffer: GOOD_PNG });
    await expect(page.locator("#submit-btn")).toBeEnabled();
    await page.locator("#submit-btn").click();
    await expect(page.locator("#submit-success")).toBeVisible({ timeout: 10_000 });
    expect(api.lastSubmitBody).toContain("tokyo-japan");
    expect(api.lastSubmitBody).toContain("35.6762");
  });

  test("clickable controls use pointer and disabled controls use not-allowed", async ({ page }) => {
    await gotoHome(page);
    const cursors = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? getComputedStyle(element).cursor : "missing";
      };
      return {
        suggested: read(".home-suggest-link"),
        share: read("#dock-share-btn"),
        info: read('#screen-home [data-action="open-info"]'),
      };
    });
    expect(cursors.suggested).toBe("pointer");
    expect(cursors.share).toBe("pointer");
    expect(cursors.info).toBe("pointer");

    await gotoGallery(page);
    await expect(page.locator(".day-tile").first()).toHaveCSS("cursor", "pointer");
    await expect(page.locator("#interval-trigger-btn")).toHaveCSS("cursor", "pointer");

    await openFirstDay(page);
    await expect(page.locator(".copy-swatch").first()).toHaveCSS("cursor", "pointer");

    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-btn")).toBeDisabled();
    await expect(page.locator("#submit-btn")).toHaveCSS("cursor", "not-allowed");
  });

  test("dock and info controls have no borders", async ({ page }) => {
    await gotoHome(page);
    for (const selector of ["#app-dock nav", "#dock-share-btn", '#screen-home [data-action="open-info"]']) {
      await expect(page.locator(selector)).toHaveCSS("border-top-width", "0px");
    }
    await gotoGallery(page);
    await expect(page.locator('#screen-gallery [data-action="open-info"]')).toHaveCSS("border-top-width", "0px");
    await openFirstDay(page);
    await expect(page.locator('#screen-detail [data-action="open-info"]')).toHaveCSS("border-top-width", "0px");
  });

  test("the home hero has no light card at 16:15", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-14T14:15:00Z"));
    await gotoHome(page);
    await expect(page.locator("#ruler-time-display")).toHaveText("16:15");

    const result = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("#main-home");
      if (!main) return { pseudo: "missing", light: [] as string[] };
      const pseudo = getComputedStyle(main, "::before");
      const light: string[] = [];
      for (const element of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
        // The search pill intentionally inverts to a light surface in dark tone.
        if (element.closest(".search-pill")) continue;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(style.backgroundColor);
        if (!match) continue;
        const alpha = match[4] === undefined ? 1 : Number(match[4]);
        const rect = element.getBoundingClientRect();
        if (alpha < 0.08 || rect.width * rect.height < 1500) continue;
        light.push(style.backgroundColor);
      }
      return { pseudoContent: pseudo.content, pseudoBackground: pseudo.backgroundColor, light };
    });

    expect(result.pseudoContent, "hero should not draw a pseudo card").toBe("none");
    for (const background of result.light) {
      const hex = rgbToHex(background);
      expect(relativeLuminance(hex), `${background} is a light card`).toBeLessThan(0.45);
    }
  });

  test("home scrubber stops at live, springs back, and never selects the future", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-14T14:15:00Z"));
    await gotoHome(page);
    const viewport = page.locator("#ruler-viewport");
    const display = page.locator("#ruler-time-display");
    await expect(display).toHaveText("16:15");
    expect(await viewport.getAttribute("aria-valuenow")).toBe(String(65 * 15));
    await expect(page.locator('#ruler-live-dot')).toHaveCount(1);
    expect(await page.locator("#ruler-live-dot").evaluate((el) => el.parentElement?.classList.contains("is-current"))).toBe(true);

    await viewport.focus();
    await page.keyboard.press("End");
    await expect(display).toHaveText("16:15");
    await page.keyboard.press("ArrowRight");
    await expect(display).toHaveText("16:15");

    await page.locator('#ruler-viewport .ruler-tick[data-index="70"]').evaluate((element) => (element as HTMLElement).click());
    await page.waitForTimeout(150);
    await expect(display).toHaveText("16:15");

    const box = await viewport.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator("#ruler-viewport").dispatchEvent("wheel", { deltaX: 0, deltaY: 600 });
    await page.waitForTimeout(600);
    await expect(display).toHaveText("16:15");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 350, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    await expect(display).toHaveText("16:15");
    const now = Number(await viewport.getAttribute("aria-valuenow"));
    expect(now).toBeLessThanOrEqual(65 * 15);

    const centred = await page.evaluate(() => {
      const dot = document.querySelector<HTMLElement>("#ruler-live-dot");
      const viewportElement = document.querySelector<HTMLElement>("#ruler-viewport");
      if (!dot?.parentElement || !viewportElement) return false;
      const tick = dot.parentElement.getBoundingClientRect();
      const shoot = viewportElement.getBoundingClientRect();
      return Math.abs(tick.left + tick.width / 2 - (shoot.left + shoot.width / 2)) < 2;
    });
    expect(centred, "live step should be centred after the spring").toBe(true);
  });

  test("gallery tile expands into detail with a FLIP overlay", async ({ page }) => {
    await gotoGallery(page);
    await page.locator("#day-cards-grid .day-tile").first().dispatchEvent("click");
    await expect(page.locator(".detail-flip")).toHaveCount(1);
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator(".detail-flip")).toHaveCount(0, { timeout: 2000 });
    await expect
      .poll(async () => Number(await page.locator("#screen-detail").evaluate((element) => getComputedStyle(element).opacity)))
      .toBe(1);
  });

  test("detail back reverses the transition without a gallery scroll jump", async ({ page }) => {
    await gotoGallery(page);
    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-30").click();
    await expect(page.locator("#day-cards-grid .day-tile")).toHaveCount(30);
    const scrollable = await page.evaluate(() => {
      const gallery = document.querySelector<HTMLElement>("#gallery-main");
      return gallery ? gallery.scrollHeight > gallery.clientHeight + 2 : false;
    });
    if (!scrollable) return;

    await page.evaluate(() => {
      const gallery = document.querySelector<HTMLElement>("#gallery-main");
      if (gallery) gallery.scrollTop = 320;
    });
    const before = await page.locator("#gallery-main").evaluate((element) => element.scrollTop);
    const clicked = await page.evaluate(() => {
      const target = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      const tile = target?.closest<HTMLElement>(".day-tile");
      if (!tile) return false;
      tile.click();
      return true;
    });
    expect(clicked).toBe(true);
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await page.waitForTimeout(500);
    await page.locator('#screen-detail [data-action="nav"][data-screen="gallery"]').click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await page.waitForTimeout(600);
    const after = await page.locator("#gallery-main").evaluate((element) => element.scrollTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  });

  test("share style chips stay legible when selected and hovered", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveClass(/is-open/);
    for (const style of ["studio", "telemetry", "horizon", "monolith"]) {
      const chip = page.locator(`#btn-style-${style}`);
      await chip.click();
      await chip.hover();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(220);
      const colors = await chip.evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });
      const ratio = contrastRatio(rgbToHex(colors.color), rgbToHex(colors.background));
      expect(ratio, `${style} chip contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("submit maps a 429 rate limit error", async ({ page, api }) => {
    api.setSubmitStatus(429);
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });

    await page.locator("#sky-file-input").setInputFiles({
      name: "sky.png",
      mimeType: "image/png",
      buffer: GOOD_PNG,
    });
    await expect(page.locator("#submit-btn")).toBeEnabled();
    await page.locator("#submit-btn").click();

    await expect(page.locator("#submit-error")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#submit-error-text")).toContainText("Too many submissions");
    await expect(page.locator("#submit-success")).toBeHidden();
  });

  test("share modal composes and downloads a PNG", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#studio-city")).not.toHaveText("—");
    await page.evaluate(() => {
      (window as Window & { __copied?: string }).__copied = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { (window as Window & { __copied?: string }).__copied = text; } },
      });
    });
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.locator("#toast")).toHaveClass(/is-visible/);
    await expect(page.locator("#toast-msg")).toHaveText("Sky link copied");
    await expect(page.locator("#share-status")).toHaveClass(/sr-only/);
    await expect(page.locator("#share-status")).toHaveText("Link copied");
    for (const id of ["share-x", "share-facebook", "share-whatsapp", "share-telegram"]) {
      const button = page.locator(`#${id}`);
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("data-action", "share-social");
      expect(await button.getAttribute("aria-label")).toMatch(/^Share on /);
    }
    await expect(page.locator("#share-native")).toBeEnabled({ timeout: 10_000 });

    await page.getByRole("button", { name: "Telemetry" }).click();
    await expect(page.locator("#card-variant-telemetry")).toBeVisible();
    await expect(page.locator("#card-variant-studio")).toBeHidden();
    await page.getByRole("button", { name: "Studio" }).click();

    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: "Save PNG" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^sky-palette-bucharest-romania-\d{4}-\d{2}-\d{2}\.png$/);
  });

  test("share modal has an icon-only export row and no dimension caption", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#share-status")).toHaveText("");
    await expect(page.getByRole("button", { name: /^Share…$/ })).toHaveCount(0);
    await expect(page.locator("#share-x")).toBeVisible();
    await expect(page.locator("#share-facebook")).toBeVisible();
    await expect(page.locator("#share-whatsapp")).toBeVisible();
    await expect(page.locator("#share-telegram")).toBeVisible();
    await expect(page.locator("#share-primary-btn")).toHaveCount(0);
    const row = page.locator("#share-social-row");
    await expect(row).toBeVisible();
    const order = await row.locator(":scope > *").evaluateAll((elements) => elements.map((element) => element.id));
    expect(order).toEqual([
      "share-x",
      "share-facebook",
      "share-whatsapp",
      "share-telegram",
      "share-instagram",
      "share-divider",
      "share-native",
    ]);
    const names: Array<[string, string]> = [
      ["share-x", "Share on X"],
      ["share-facebook", "Share on Facebook"],
      ["share-whatsapp", "Share on WhatsApp"],
      ["share-telegram", "Share on Telegram"],
      ["share-instagram", "Share Story card to Instagram"],
      ["share-native", "Share card with device"],
    ];
    for (const [id, name] of names) {
      const button = page.locator(`#${id}`);
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("aria-label", name);
      expect(Math.round((await button.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(48);
      expect(Math.round((await button.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(48);
    }
    const gap = await row.evaluate((element) => getComputedStyle(element).gap);
    expect(gap).toBe("8px");
    const divider = await page.locator("#share-divider").boundingBox();
    expect(divider).not.toBeNull();
    if (divider) {
      expect(Math.round(divider.width)).toBeLessThanOrEqual(1);
      expect(Math.round(divider.height)).toBeGreaterThanOrEqual(18);
      expect(Math.round(divider.height)).toBeLessThanOrEqual(22);
    }
    const save = page.getByRole("button", { name: "Save PNG" });
    await expect(save).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const box = await save.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(47.5);
  });

  test("share card sends the 4:5 PNG file to the native sheet", async ({ page }) => {
    await stubShareApi(page, { canShare: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    const primary = page.locator("#share-native");
    await expect(primary).toBeEnabled({ timeout: 10_000 });
    await primary.click();
    await expect.poll(async () => (await readShareProbe(page)).files.length).toBe(1);
    const probe = await readShareProbe(page);
    expect(probe.calls).toBe(1);
    expect(probe.files[0]?.type).toBe("image/png");
    expect(probe.files[0]?.name).toMatch(/^sky-palette-bucharest-romania-\d{4}-\d{2}-\d{2}\.png$/);
    expect(probe.files[0]?.width).toBe(1080);
    expect(probe.files[0]?.height).toBe(1350);
    expect(probe.title).toContain("Sky above Bucharest");
    expect(probe.text).toContain("view=");
  });

  test("Instagram sends a 1080x1920 story PNG to the native sheet", async ({ page }) => {
    await stubShareApi(page, { canShare: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    const instagram = page.getByRole("button", { name: "Share Story card to Instagram" });
    await expect(instagram).toBeEnabled({ timeout: 10_000 });
    await instagram.click();
    await expect.poll(async () => (await readShareProbe(page)).files.length).toBe(1);
    const probe = await readShareProbe(page);
    expect(probe.calls).toBe(1);
    expect(probe.files[0]?.name).toMatch(/-story\.png$/);
    expect(probe.files[0]?.type).toBe("image/png");
    expect(probe.files[0]?.width).toBe(1080);
    expect(probe.files[0]?.height).toBe(1920);
    expect(probe.text).toBe("My sky right now — Sky Palette");
  });

  test("share fallback downloads the card and toasts when file sharing is unavailable", async ({ page }) => {
    await stubShareApi(page, { canShare: false });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    const primary = page.locator("#share-native");
    await expect(primary).toBeEnabled({ timeout: 10_000 });
    const downloadPromise = page.waitForEvent("download");
    await primary.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^sky-palette-bucharest-romania-\d{4}-\d{2}-\d{2}\.png$/);
    await expect(page.locator("#toast-msg")).toHaveText("Card saved — share it from your photos.");
    const probe = await readShareProbe(page);
    expect(probe.calls).toBe(0);
  });

  test("Instagram fallback saves the 9:16 story card and toasts", async ({ page }) => {
    await stubShareApi(page, { canShare: false });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    const instagram = page.getByRole("button", { name: "Share Story card to Instagram" });
    await expect(instagram).toBeEnabled({ timeout: 10_000 });
    const downloadPromise = page.waitForEvent("download");
    await instagram.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-story\.png$/);
    await expect(page.locator("#toast-msg")).toHaveText(
      "Story card saved — open Instagram and add it to your Story.",
    );
  });

  test("social fallback downloads the card before opening the composer", async ({ page }) => {
    await stubShareApi(page, { canShare: false });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    const x = page.locator("#share-x");
    await expect(x).toBeEnabled({ timeout: 10_000 });
    const downloadPromise = page.waitForEvent("download");
    await x.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    await expect(page.locator("#toast-msg")).toHaveText("Card downloaded — attach it to your post.");
    const probe = await readShareProbe(page);
    expect(probe.calls).toBe(0);
    expect(probe.openedUrl).toContain("twitter.com/intent/tweet");
    expect(decodeURIComponent(probe.openedUrl)).toContain("view=home");
  });

  test("cancelling the native share sheet is silent", async ({ page }) => {
    await stubShareApi(page, { canShare: true, abort: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    const primary = page.locator("#share-native");
    await expect(primary).toBeEnabled({ timeout: 10_000 });
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    await primary.click();
    await expect(primary).toBeEnabled();
    await page.waitForTimeout(400);
    expect(downloads).toBe(0);
    await expect(page.locator("#toast")).not.toHaveClass(/is-visible/);
    await expect(page.locator("#share-status")).toHaveText("");
  });

  test("info modal opens and closes with Escape", async ({ page }) => {
    await gotoHome(page);
    const infoButton = page.locator('#screen-home [data-action="open-info"]');
    await expect(infoButton).toHaveAttribute("aria-label", "About Sky Palette");
    const icon = await infoButton.locator("svg").boundingBox();
    expect(icon).not.toBeNull();
    if (icon) {
      expect(icon.width).toBeGreaterThan(8);
      expect(icon.height).toBeGreaterThan(8);
    }
    await infoButton.click();
    await expect(page.locator("#info-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#info-modal")).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator("#info-modal")).toContainText("reviewed before publication");
    await expect(page.locator("#info-modal")).not.toContainText("human review");
    await expect(page.locator('#info-modal a[href*="/privacy-policy"]')).toHaveCount(0);
    await expect(page.locator('#info-modal a[href*="/terms-of-service"]')).toHaveCount(0);
    await expect(page.locator("#info-modal [data-doc]")).toHaveCount(2);
    const privacyToggle = page.locator('#info-modal [data-doc="privacy"]');
    await privacyToggle.click();
    await expect(privacyToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#legal-doc-privacy")).toBeVisible();
    await expect(page.locator("#legal-doc-privacy")).toContainText(
      "Your chosen city is remembered in this browser (one key, no identifiers, no tracking).",
    );
    await expect(page.locator('#info-modal a[href*="issues/new"]')).toHaveCount(1);
    expect(await page.locator('#info-modal a[href*="issues/new"]').getAttribute("href")).toContain(
      "template=bug_report.yml",
    );

    await page.keyboard.press("Escape");
    await expect(page.locator("#info-modal")).not.toHaveClass(/is-open/);
    await expect(page.locator("#info-modal")).toHaveAttribute("aria-hidden", "true");
  });

  test("home controls invert with the sky tone", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-14T10:00:00Z"));
    await gotoHome(page);
    const screen = page.locator("#screen-home");
    const pill = page.locator("#screen-home .search-pill-dark");
    const input = page.locator("#city-search-input");
    const info = page.locator("#screen-home .info-button");
    const suggest = page.locator("#screen-home .home-suggest-link").first();
    const viewport = page.locator("#ruler-viewport");

    await viewport.focus();
    await page.keyboard.press("Home");
    await expect(screen).toHaveAttribute("data-tone", "dark");
    await expect(pill).toHaveCSS("background-color", "rgb(245, 245, 247)");
    await expect(input).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(info).toHaveCSS("background-color", "rgb(245, 245, 247)");
    await expect(info).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(suggest).toHaveCSS("color", "rgb(255, 255, 255)");

    await page.keyboard.press("End");
    await expect(screen).toHaveAttribute("data-tone", "light");
    await expect(pill).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(input).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(info).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(info).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(suggest).toHaveCSS("color", "rgb(0, 0, 0)");
  });

  test("modals reopen three times with painted content", async ({ page }) => {
    await gotoHome(page);
    const cases = [
      { open: () => page.locator("#nav-btn-submit").click(), modal: "#submit-modal", text: "Share a photo of your sky" },
      { open: () => page.locator("#dock-share-btn").click(), modal: "#share-modal", text: "Share sky card" },
      {
        open: () => page.locator('#screen-home [data-action="open-info"]').click(),
        modal: "#info-modal",
        text: "Physical sky colour engine",
      },
    ];
    for (const item of cases) {
      const modal = page.locator(item.modal);
      const card = modal.locator(".modal-card");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await item.open();
        await expect(modal).toHaveClass(/is-open/);
        await expect(card).toContainText(item.text);
        const measured = await card.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            height: rect.height,
            transform: getComputedStyle(element).transform,
            inside: Boolean(hit && element.contains(hit)),
          };
        });
        expect(measured.height, `${item.modal} height on open ${attempt + 1}`).toBeGreaterThan(300);
        expect(measured.transform, `${item.modal} transform`).toBe("none");
        expect(measured.inside, `${item.modal} centre hit`).toBe(true);
        await page.keyboard.press("Escape");
        await expect(modal).not.toHaveClass(/is-open/);
      }
    }

    await gotoGallery(page);
    const galleryModal = page.locator("#gallery-search-modal");
    const galleryCard = galleryModal.locator(".modal-card");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.locator("#gallery-location-btn").click();
      await expect(galleryModal).toHaveClass(/is-open/);
      await expect(galleryCard).toContainText("Search location");
      const measured = await galleryCard.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
          height: rect.height,
          transform: getComputedStyle(element).transform,
          inside: Boolean(hit && element.contains(hit)),
        };
      });
      expect(measured.height, `gallery search height on open ${attempt + 1}`).toBeGreaterThan(300);
      expect(measured.transform, "gallery search transform").toBe("none");
      expect(measured.inside, "gallery search centre hit").toBe(true);
      await page.keyboard.press("Escape");
      await expect(galleryModal).not.toHaveClass(/is-open/);
    }
  });

  test("all screens navigate", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("#screen-home")).toHaveClass(/active/);

    await page.locator("#nav-btn-gallery").click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect(page.locator("#screen-home")).not.toHaveClass(/active/);

    await openFirstDay(page);
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);

    await page.locator('#screen-detail [data-action="nav"][data-screen="gallery"]').click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);

    await page.locator("#nav-btn-home").click();
    await expect(page.locator("#screen-home")).toHaveClass(/active/);
  });

  test("no horizontal overflow and the dock stays inside the viewport", async ({ page }) => {
    await gotoHome(page);
    await checkViewport(page);

    await gotoGallery(page);
    await checkViewport(page);

    await openFirstDay(page);
    await checkViewport(page);

    await page.locator("#detail-ruler-viewport").scrollIntoViewIfNeeded();
    await checkViewport(page);
  });

  test("gallery failure shows a retry that recovers", async ({ page, api }) => {
    api.failHistoryOnce();
    await page.goto("/");
    await page.locator("#nav-btn-gallery").click();
    await expect(page.locator("#gallery-error")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#gallery-error-text")).toContainText(/unreachable|timed out|could not/i);

    await page.locator('[data-action="retry-gallery"]').click();
    await expect(page.locator("#gallery-error")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#day-cards-grid .day-tile")).toHaveCount(15);
  });

  test("palette failure shows a retryable model state", async ({ page, api }) => {
    api.failPaletteOnce();
    await page.goto("/");
    await expect(page.locator("#home-error")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#home-error-text")).toContainText(/clear-sky model/i);
    await expect(page.locator("#home-elevation")).not.toHaveText("—");

    await page.locator('[data-action="retry-home"]').click();
    await expect(page.locator("#home-error")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#home-elevation")).not.toHaveText("—");
  });
});
