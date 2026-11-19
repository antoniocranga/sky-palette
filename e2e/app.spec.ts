import sharp from "sharp";
import { test, expect, gotoGallery, gotoHome, openFirstDay, makePng, makePngWithGps, makePngWithTakenAt } from "./fixtures";
import { contrastRatio, relativeLuminance } from "../src/shared/color";

const GOOD_PNG = makePng(800, 600);
const GPS_TOKYO_PNG = makePngWithGps(800, 600, 35.6762, 139.6503);
const TAKEN_AT_PNG = makePngWithTakenAt(800, 600, "2026:11:10 18:42:07");

function rgbToHex(value: string): string {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (!match) throw new Error(`Unexpected rgb: ${value}`);
  return `#${[match[1], match[2], match[3]].map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}


type Rgb = [number, number, number];

async function screenshotRaw(page: import("@playwright/test").Page): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const shot = await page.screenshot();
  const { data, info } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function assertNoPinkBand(page: import("@playwright/test").Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} must be laid out`).not.toBeNull();
  if (!box) return 0;
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!viewport) return 0;
  const raw = await screenshotRaw(page);
  const sx = raw.width / viewport.width;
  const sy = raw.height / viewport.height;
  const left = Math.max(0, Math.floor(box.x * sx));
  const right = Math.min(raw.width, Math.ceil((box.x + box.width) * sx));
  const top = Math.max(0, Math.floor(box.y * sy));
  const bottom = Math.min(raw.height, Math.ceil((box.y + box.height) * sy));
  let pink = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * raw.width + x) * raw.channels;
      const r = raw.data[index] ?? 0;
      const g = raw.data[index + 1] ?? 0;
      const b = raw.data[index + 2] ?? 0;
      if (r > 150 && b > 150 && g < Math.min(r, b) - 25) pink += 1;
    }
  }
  return pink;
}

async function edgeAverage(page: import("@playwright/test").Page): Promise<{ top: Rgb; bottom: Rgb }> {
  const raw = await screenshotRaw(page);
  const sample = (row: number): Rgb => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let x = 0; x < raw.width; x += 1) {
      const index = (row * raw.width + x) * raw.channels;
      r += raw.data[index] ?? 0;
      g += raw.data[index + 1] ?? 0;
      b += raw.data[index + 2] ?? 0;
    }
    return [Math.round(r / raw.width), Math.round(g / raw.width), Math.round(b / raw.width)];
  };
  const average = (start: number, end: number): Rgb => {
    let r = 0;
    let g = 0;
    let b = 0;
    let rows = 0;
    for (let y = start; y < end; y += 1) {
      const [rr, gg, bb] = sample(y);
      r += rr;
      g += gg;
      b += bb;
      rows += 1;
    }
    return [Math.round(r / rows), Math.round(g / rows), Math.round(b / rows)];
  };
  return { top: average(0, Math.min(3, raw.height)), bottom: average(Math.max(0, raw.height - 3), raw.height) };
}


function minutesFromClock(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
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
  url: string;
  openedUrl: string;
  openedUrls: string[];
  openDuringClick: boolean[];
};

async function stubShareApi(
  page: import("@playwright/test").Page,
  options: { canShare?: boolean; abort?: boolean; hold?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ canShare, abort, hold }) => {
      const probe = {
        calls: 0,
        files: [] as Array<{ name: string; type: string; size: number; width: number; height: number }>,
        title: "",
        text: "",
        url: "",
        openedUrl: "",
        openedUrls: [] as string[],
        openDuringClick: [] as boolean[],
      };
      (window as Window & { __shareProbe?: typeof probe; __shareFiles?: File[] }).__shareProbe = probe;
      (window as Window & { __shareFiles?: File[] }).__shareFiles = [];
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: (data: { files?: File[] }) => Boolean(canShare && data && data.files && data.files.length > 0),
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: { files?: File[]; title?: string; text?: string; url?: string }) => {
          probe.calls += 1;
          probe.title = data.title ?? "";
          probe.text = data.text ?? "";
          probe.url = data.url ?? "";
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
            (window as Window & { __shareFiles?: File[] }).__shareFiles?.push(file);
          }
          if (hold) await new Promise<void>((resolve) => { (window as Window & { __releaseShare?: () => void }).__releaseShare = resolve; });
          if (abort) throw new DOMException("Share cancelled", "AbortError");
        },
      });
      const clickState = window as Window & { __shareInClick?: boolean };
      clickState.__shareInClick = false;
      document.addEventListener(
        "click",
        () => {
          clickState.__shareInClick = true;
          setTimeout(() => {
            clickState.__shareInClick = false;
          }, 0);
        },
        true,
      );
      Object.defineProperty(window, "open", {
        configurable: true,
        value: (url?: string | URL | null) => {
          const value = String(url ?? "");
          probe.openedUrl = value;
          probe.openedUrls.push(value);
          probe.openDuringClick.push(Boolean(clickState.__shareInClick));
          return null;
        },
      });
    },
    { canShare: options.canShare ?? true, abort: options.abort ?? false, hold: options.hold ?? false },
  );
}

async function readShareProbe(page: import("@playwright/test").Page): Promise<ShareProbe> {
  return page.evaluate(() => {
    const probe = (window as Window & { __shareProbe?: ShareProbe }).__shareProbe;
    return probe ?? { calls: 0, files: [], title: "", text: "", url: "", openedUrl: "", openedUrls: [], openDuringClick: [] };
  });
}

/** Records clipboard writes into `window.__copied` before the app boots. */
async function stubClipboard(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    (window as Window & { __copied?: string }).__copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { __copied?: string }).__copied = text;
        },
      },
    });
  });
}

async function readCopied(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? "");
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
    await expect(page.locator("#home-live-dot")).toBeVisible();
    await expect(page.locator("#screen-home")).not.toContainText(/forecast/i);
    await expect(page.locator("#ruler-live-dot")).toBeVisible();

    const background = await page.locator("#sky-backdrop").evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(background).toContain("gradient");
    const line = await page.locator("#screen-home .home-ink > *").evaluateAll((elements) => elements.map((element) => element.id));
    expect(line.slice(-2)).toEqual(["bucharest-clock", "home-live-dot"]);
  });

  test("live clock stays put while the scrubber moves and the live dot renders", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("#city-search-input")).toHaveAttribute(
      "placeholder",
      "Search the location of your sky",
    );
    const clock = await page.locator("#bucharest-clock").textContent();
    expect(clock).toMatch(/^\d{2}:\d{2}/);
    await expect(page.locator("#home-live-dot")).toBeVisible();
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
    await expect(page.locator("#home-live-dot")).toBeHidden();
    await expect(page.locator("#ruler-live-dot")).toBeVisible();
    await expect(page.locator("#screen-home")).not.toContainText(/forecast/i);
  });

  test("cold first paint paints the clear-sky model immediately", async ({ page, api }) => {
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
    expect(state.backdropImage).toContain("gradient");
    expect(state.backdropColour).not.toBe("rgb(9, 11, 16)");
    expect(state.clock).toMatch(/\d{2}:\d{2}/);
    expect(state.ready).toBe("true");

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
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
    const solvedBox = await page.locator("#turnstile-box").evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    expect(solvedBox.height).toBeLessThanOrEqual(1);
    expect(solvedBox.ariaHidden).toBe("true");
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
    await page.mouse.move(box.x + box.width / 2 + 190, y, { steps: 12 });
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
    expect(focusStyle.shadow).toBe("none");
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

  test("a suggested city survives reload through the exact slug endpoint", async ({ page }) => {
    await gotoHome(page);
    await page.locator('[data-action="suggest-city"][data-query="Tokyo"]').click();
    await expect(page.locator("#home-city-label")).toHaveText("Tokyo", { timeout: 10_000 });
    await expect.poll(() => new URL(page.url()).searchParams.get("city")).toBe("tokyo-japan");
    expect(await page.evaluate(() => localStorage.getItem("sky-palette.city"))).toBe("tokyo-japan");

    await page.reload();
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#home-city-label")).toHaveText("Tokyo", { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("city")).toBe("tokyo-japan");
  });

  test("a gallery-selected city survives reload", async ({ page }) => {
    await gotoGallery(page);
    await page.locator("#gallery-location-btn").click();
    await expect(page.locator("#gallery-search-modal")).toHaveClass(/is-open/);
    const search = page.locator("#modal-city-search-input");
    await search.fill("Paris");
    const option = page.getByRole("option", { name: /Paris/ });
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();
    await expect(page.locator("#gallery-city-badge")).toContainText("Paris", { timeout: 10_000 });
    await expect.poll(() => new URL(page.url()).searchParams.get("city")).toBe("paris-france");
    expect(await page.evaluate(() => localStorage.getItem("sky-palette.city"))).toBe("paris-france");

    await page.reload();
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect(page.locator("#gallery-city-badge")).toContainText("Paris", { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("city")).toBe("paris-france");
  });

  test("home repaints its backdrop and tone after leaving other screens", async ({ page }) => {
    const readHome = () =>
      page.evaluate(() => {
        const backdrop = document.querySelector<HTMLElement>("#sky-backdrop");
        const screen = document.querySelector<HTMLElement>("#screen-home");
        const pill = document.querySelector<HTMLElement>("#screen-home .search-pill-dark");
        const input = document.querySelector<HTMLElement>("#city-search-input");
        return {
          gradient: backdrop ? getComputedStyle(backdrop).backgroundImage : "none",
          tone: screen?.dataset.tone ?? "",
          pill: pill ? getComputedStyle(pill).backgroundColor : "",
          ink: input ? getComputedStyle(input).color : "",
        };
      });
    const assertHome = async (label: string): Promise<void> => {
      await expect(page.locator("#screen-home")).toHaveClass(/active/);
      await page.waitForTimeout(220);
      const state = await readHome();
      expect(state.gradient, `${label} backdrop`).toContain("gradient");
      expect(state.gradient, `${label} must not be the neutral layer`).not.toBe("none");
      expect(["dark", "light"], `${label} tone`).toContain(state.tone);
      expect(contrastRatio(rgbToHex(state.ink), rgbToHex(state.pill)), `${label} pill contrast`).toBeGreaterThanOrEqual(4.5);
      if (state.tone === "dark") {
        expect(state.pill).toBe("rgb(245, 245, 247)");
        expect(state.ink).toBe("rgb(0, 0, 0)");
      } else {
        expect(state.pill).toBe("rgb(0, 0, 0)");
        expect(state.ink).toBe("rgb(255, 255, 255)");
      }
    };

    await gotoGallery(page);
    await page.locator("#nav-btn-home").click();
    await assertHome("Gallery to home");

    await gotoGallery(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#submit-modal")).not.toHaveClass(/is-open/);
    await page.locator("#nav-btn-home").click();
    await assertHome("Submit to home");
  });

  test("deep link hydrates detail day, time and five swatches", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&view=detail&day=2026-11-14&time=16%3A49&interval=15");
    await expect(page.locator("body")).not.toHaveAttribute("data-booting", "true");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator("#detail-title")).toHaveText("Nov 14 · Bucharest");
    await expect(page.locator("#detail-ruler-time-display")).toHaveText("16:15");
    for (const name of ["zenith", "midsky", "horizon", "sunglow", "cloudtint"]) {
      await expect(page.locator(`#${name}-hex`)).toHaveText(/^#[0-9A-F]{6}$/);
    }
    const url = new URL(page.url());
    expect(url.searchParams.get("view")).toBe("detail");
    expect(url.searchParams.get("day")).toBe("2026-11-14");
    expect(url.searchParams.get("time")).toBe("16:15");
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
    expect(copied.searchParams.get("time")).toBe("16:15");
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
    const readPill = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          radius: style.borderRadius,
        };
      });
    const locationStyle = await readPill("#gallery-location-btn");
    for (const pill of [location, interval]) {
      await expect(pill).toHaveCSS("border-top-width", "0px");
      await expect(pill).toHaveCSS("box-shadow", "none");
      await pill.hover();
      await page.waitForTimeout(180);
      const hover = await pill.evaluate((element) => {
        const style = getComputedStyle(element);
        return { image: style.backgroundImage, color: style.color, border: style.borderTopWidth };
      });
      expect(hover.image).toContain("linear-gradient");
      expect(hover.color).toBe("rgb(255, 255, 255)");
      expect(hover.border).toBe("0px");
    }
    const intervalStyle = await readPill("#interval-trigger-btn");
    expect(intervalStyle.height).toBeCloseTo(locationStyle.height, 1);
    expect(intervalStyle.fontSize).toBe(locationStyle.fontSize);
    expect(intervalStyle.fontWeight).toBe(locationStyle.fontWeight);
    expect(intervalStyle.letterSpacing).toBe(locationStyle.letterSpacing);
    expect(intervalStyle.paddingLeft).toBe(locationStyle.paddingLeft);
    expect(intervalStyle.paddingRight).toBe(locationStyle.paddingRight);
    expect(intervalStyle.radius).toBe(locationStyle.radius);
    await interval.click();
    const optionStyle = await readPill("#int-btn-15");
    expect(optionStyle.height).toBeCloseTo(locationStyle.height, 1);
    expect(optionStyle.fontSize).toBe(locationStyle.fontSize);
    expect(optionStyle.fontWeight).toBe(locationStyle.fontWeight);
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
          return {
            display: style.display,
            backgroundImage: style.backgroundImage,
            backgroundColor: style.backgroundColor,
            height: element.getBoundingClientRect().height,
          };
        });
        // Some screens intentionally hide a scrim under floating browser chrome.
        if (styles.display === "none") {
          expect(styles.height, `${label} ${id} hidden height`).toBe(0);
          continue;
        }
        // A scrim either fades with a gradient or carries the solid chrome
        // colour Safari 26+ samples (home's bottom strip, for example).
        const paints = styles.backgroundImage.includes("linear-gradient") || !/rgba\(0, 0, 0, 0\)/.test(styles.backgroundColor);
        expect(paints, `${label} ${id} paint`).toBe(true);
        expect(styles.height, `${label} ${id} fade height`).toBeGreaterThan(0);
      }
    };

    await gotoHome(page);
    await assertScrims("home");
    await gotoGallery(page);
    await assertScrims("gallery");
    await openFirstDay(page);
    await assertScrims("detail");
    for (const id of ["safe-top-scrim", "safe-bottom-scrim"]) {
      const detailScrim = await page.locator(`#${id}`).evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(detailScrim, `${id} detail fade`).toContain("255, 255, 255");
    }
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
    const photoCount = await photos.count();
    expect(photoCount).toBeGreaterThanOrEqual(6);
    const images = page.locator("#detail-photos .photo-tile img");
    await expect(images).toHaveCount(photoCount);
    for (let index = 0; index < 2; index += 1) {
      const image = images.nth(index);
      expect(await image.getAttribute("src")).toContain("/photos/thumb-");
      await expect(image).toHaveAttribute("loading", "lazy");
      expect(Number(await image.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(await image.getAttribute("height"))).toBeGreaterThan(0);
      await expect(image).toHaveAttribute("alt", /Sky photo by @sky-bucharest-/);
    }

    await page.locator("#detail-photos .photo-tile").first().click();
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#photo-modal-handle")).toHaveText("@sky-bucharest-48b");
    await expect(page.locator("#photo-modal-city")).toContainText("Bucharest");
    await expect(page.locator("#photo-modal-swatches > *")).toHaveCount(5);
    const modalPadding = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>("#photo-modal-header")!;
      const body = document.querySelector<HTMLElement>("#photo-modal-body")!;
      return {
        headerLeft: getComputedStyle(header).paddingLeft,
        bodyLeft: getComputedStyle(body).paddingLeft,
        headerBottom: getComputedStyle(header).borderBottomWidth,
      };
    });
    expect(modalPadding.headerLeft).toBe(modalPadding.bodyLeft);
    expect(modalPadding.headerBottom).toBe("0px");
    await page.keyboard.press("Escape");
    await expect(page.locator("#photo-modal")).not.toHaveClass(/is-open/);
  });

  test("community grid is three columns and paginates to every page", async ({ page, api }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    const grid = page.locator("#detail-photos");
    for (const width of [375, 393, 820, 1440]) {
      await page.setViewportSize({ width, height: 852 });
      const columns = await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      expect(columns, `columns at ${width}`).toBe(3);
      await expect(grid).toHaveCSS("column-gap", "0px");
    }
    const tiles = page.locator("#detail-photos .photo-tile");
    expect(await tiles.count()).toBeGreaterThanOrEqual(6);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await tiles.count()) >= 24) break;
      await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(300);
    }
    await expect(tiles).toHaveCount(24, { timeout: 10_000 });
    const ids = await tiles.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-photo-id")));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(24);

    const cursors = api.requests
      .filter((request) => request.startsWith("GET /api/gallery?"))
      .map((request) => new URL(request.slice(4), "http://local").searchParams.get("cursor"))
      .filter((cursor): cursor is string => Boolean(cursor));
    expect(cursors.length).toBeGreaterThanOrEqual(3);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  test("community append keeps loaded tiles and fades in only the new page", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    const grid = page.locator("#detail-photos");
    const tiles = grid.locator(".photo-tile");
    const first = tiles.first();
    await expect(first.locator("img")).toHaveClass(/is-loaded/);
    await expect(grid).toBeVisible();
    await first.evaluate((element) => {
      (element as HTMLElement).dataset.probe = "kept";
    });
    const firstSrc = await first.locator("img").getAttribute("src");
    const firstTime = await first.locator(".photo-tile-time").textContent();
    const firstGeometry = await first.evaluate((element) => {
      const tile = element as HTMLElement;
      return { offsetTop: tile.offsetTop, offsetLeft: tile.offsetLeft, offsetWidth: tile.offsetWidth, offsetHeight: tile.offsetHeight };
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if ((await tiles.count()) > 6) break;
      await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(300);
    }
    await expect.poll(async () => tiles.count(), { timeout: 10_000 }).toBeGreaterThan(6);

    // The first tile is the same element, not a rebuilt one, and its bitmap
    // never went back through the skeleton/white state.
    await expect(first).toHaveAttribute("data-probe", "kept");
    await expect(grid).toBeVisible();
    const probe = await first.evaluate((element) => {
      const image = element.querySelector<HTMLImageElement>("img");
      if (!image) return null;
      return {
        connected: element.isConnected,
        src: image.getAttribute("src"),
        opacity: getComputedStyle(image).opacity,
        classes: image.className,
        time: element.querySelector(".photo-tile-time")?.textContent ?? "",
      };
    });
    expect(probe).not.toBeNull();
    if (!probe) return;
    expect(probe.connected).toBe(true);
    expect(probe.src).toBe(firstSrc);
    expect(probe.opacity).toBe("1");
    expect(probe.classes).toContain("is-loaded");
    expect(probe.time).toBe(firstTime);
    const afterGeometry = await first.evaluate((element) => {
      const tile = element as HTMLElement;
      return { offsetTop: tile.offsetTop, offsetLeft: tile.offsetLeft, offsetWidth: tile.offsetWidth, offsetHeight: tile.offsetHeight };
    });
    expect(afterGeometry).toEqual(firstGeometry);

    // Every tile after the first page is present exactly once.
    const ids = await tiles.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-photo-id")));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("community sort offers four orders and paginates with the selected one", async ({ page, api }) => {
    await gotoGallery(page);
    await openFirstDay(page);

    const button = page.locator("#photo-sort-btn");
    await expect(button).toContainText("Newest uploads");
    const buttonBox = await button.boundingBox();
    expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // The button and the section label share one optical centre line, and the
    // row keeps justify-between so the label can truncate first.
    const header = page.locator("#detail-photos-section > div").first();
    const alignment = await header.evaluate((row) => {
      const label = row.querySelector("span");
      const trigger = row.querySelector<HTMLElement>("#photo-sort-btn");
      if (!label || !trigger) return null;
      const labelRect = label.getBoundingClientRect();
      const buttonRect = trigger.getBoundingClientRect();
      return {
        labelCentre: labelRect.top + labelRect.height / 2,
        buttonCentre: buttonRect.top + buttonRect.height / 2,
        justifyContent: getComputedStyle(row).justifyContent,
      };
    });
    expect(alignment).not.toBeNull();
    if (alignment) {
      expect(Math.abs(alignment.labelCentre - alignment.buttonCentre)).toBeLessThanOrEqual(1);
      expect(alignment.justifyContent).toBe("space-between");
    }

    await button.click();
    const popover = page.locator("#photo-sort-popover");
    await expect(popover).toBeVisible();
    const options = popover.locator(".photo-sort-option");
    await expect(options).toHaveCount(4);
    await expect(options).toHaveText(["Newest uploads", "Oldest uploads", "Newest captures", "Oldest captures"]);
    for (let index = 0; index < 4; index += 1) {
      const option = options.nth(index);
      const box = await option.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      const radius = await option.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius));
      expect(radius).toBeGreaterThanOrEqual(999);
    }
    const [activeStyle, idleStyle] = await options.evaluateAll((elements) =>
      elements.slice(0, 2).map((element) => {
        const style = getComputedStyle(element);
        const lightness = (value: string): number | null => {
          const oklch = value.match(/oklch\(([\d.]+)/);
          if (oklch) return Number(oklch[1]);
          const oklab = value.match(/oklab\(([\d.]+)/);
          if (oklab) return Number(oklab[1]);
          const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          return rgb ? (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 765 : null;
        };
        return { background: style.backgroundColor, color: style.color, lightness: lightness(style.backgroundColor) };
      }),
    );
    await page.mouse.move(0, 0);
    await page.waitForTimeout(80);
    expect(activeStyle?.background).toBe("rgb(0, 0, 0)");
    expect(activeStyle?.color).toBe("rgb(255, 255, 255)");
    expect(idleStyle?.background).not.toBe(activeStyle?.background);
    expect(idleStyle?.color).not.toBe(activeStyle?.color);
    expect(idleStyle?.lightness).toBeGreaterThan(0.9);
    if ((page.viewportSize()?.width ?? 0) >= 1000) {
      const idleColour = idleStyle?.background;
      await options.nth(1).hover();
      await expect
        .poll(async () => options.nth(1).evaluate((element) => getComputedStyle(element).backgroundColor))
        .not.toBe(idleColour);
    }

    // Escape closes only the popover; the detail screen stays open.
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator("#photo-modal")).not.toHaveClass(/is-open/);

    // Keyboard open lands on the active option, arrows move the roving focus.
    await button.press("ArrowDown");
    await expect(popover).toBeVisible();
    await expect(page.locator("#photo-sort-upload-desc")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#photo-sort-upload-asc")).toBeFocused();

    await page.locator("#photo-sort-captured-asc").click();
    await expect(popover).toBeHidden();
    await expect(button).toContainText("Oldest captures");
    await expect(button).toHaveAttribute("aria-expanded", "false");

    // The reset loads page 1 of the new order: oldest capture first.
    const tiles = page.locator("#detail-photos .photo-tile");
    await expect(tiles.first()).toHaveAttribute("data-photo-id", "photo-24");
    expect(await tiles.count()).toBeGreaterThanOrEqual(6);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if ((await tiles.count()) >= 24) break;
      await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(300);
    }
    await expect(tiles).toHaveCount(24, { timeout: 10_000 });

    const pages = api.requests
      .filter((request) => request.startsWith("GET /api/gallery?"))
      .map((request) => new URL(request.slice(4), "http://local").searchParams);
    const selected = pages.filter((params) => params.get("sort") === "captured");
    expect(selected.length).toBeGreaterThanOrEqual(2);
    for (const params of selected) expect(params.get("order")).toBe("asc");
    const cursors = selected.map((params) => params.get("cursor")).filter((cursor): cursor is string => Boolean(cursor));
    expect(new Set(cursors).size).toBe(cursors.length);

    // Switching again reuses the same contract for the default order.
    await button.click();
    await page.locator("#photo-sort-upload-desc").click();
    await expect(button).toContainText("Newest uploads");
    await expect(tiles.first()).toHaveAttribute("data-photo-id", "photo-1");
  });

  test("community end line replaces the loader once every page lands", async ({ page, api }) => {
    api.setGallerySize(12);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowNextPage = async (route: import("@playwright/test").Route): Promise<void> => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("cursor")) await gate;
      await route.fallback();
    };
    await page.route("**/api/gallery**", slowNextPage);
    await gotoGallery(page);
    await openFirstDay(page);
    const tiles = page.locator("#detail-photos .photo-tile");
    const loading = page.locator("#detail-photos-sentinel");
    const end = page.locator("#detail-photos-end");

    await expect(tiles).toHaveCount(6);
    await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    // The loader is only on screen while the second page is in flight.
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText("Loading more skies…");
    await expect(end).toBeHidden();

    release();
    await expect(tiles).toHaveCount(12, { timeout: 10_000 });
    await expect(loading).toBeHidden();
    await expect(end).toBeVisible();
    await expect(end).toHaveText("You've seen all the skies.");
    await expect(end).toHaveAttribute("role", "status");
    await expect(page.locator("#detail-photos-end")).toHaveCount(1);
    await page.unroute("**/api/gallery**", slowNextPage);
  });

  test("a single-page community result shows the end line only after it settles", async ({ page, api }) => {
    api.setGallerySize(3);
    await gotoGallery(page);
    await openFirstDay(page);
    await expect(page.locator("#detail-photos .photo-tile")).toHaveCount(3);
    await expect(page.locator("#detail-photos-sentinel")).toBeHidden();
    await expect(page.locator("#detail-photos-end")).toBeVisible();
    await expect(page.locator("#detail-photos-end")).toHaveText("You've seen all the skies.");
  });

  test("changing sort hides the end line for page 1 and restores it at the end", async ({ page, api }) => {
    api.setGallerySize(12);
    await gotoGallery(page);
    await openFirstDay(page);
    const tiles = page.locator("#detail-photos .photo-tile");
    const loading = page.locator("#detail-photos-sentinel");
    const end = page.locator("#detail-photos-end");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if ((await tiles.count()) >= 12) break;
      await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(300);
    }
    await expect(tiles).toHaveCount(12, { timeout: 10_000 });
    await expect(end).toBeVisible();

    // Hold the new sort's first page so the reset state is observable.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowSort = async (route: import("@playwright/test").Route): Promise<void> => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("sort") === "captured") await gate;
      await route.fallback();
    };
    await page.route("**/api/gallery**", slowSort);
    await page.locator("#photo-sort-btn").click();
    await page.locator("#photo-sort-captured-desc").click();

    await expect(end).toBeHidden();
    await expect(loading).toBeHidden();
    release();
    await expect(tiles.first()).toHaveAttribute("data-photo-id", "photo-1");

    // Scroll until the second page of the new sort has been appended; the end
    // line only becomes correct after the cursor is exhausted.
    await expect
      .poll(
        async () => {
          await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
          return tiles.count();
        },
        { timeout: 15_000, intervals: [300, 500, 800] },
      )
      .toBe(12);
    await expect(end).toBeVisible();
    await page.unroute("**/api/gallery**", slowSort);
  });

  test("sort popover opens clear of the dock", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#photo-sort-btn").click();
    const popover = await page.locator("#photo-sort-popover").boundingBox();
    const dock = await page.locator("#app-dock").boundingBox();
    expect(popover).not.toBeNull();
    expect(dock).not.toBeNull();
    if (popover && dock) {
      expect(popover.y + popover.height).toBeLessThanOrEqual(dock.y);
      expect(popover.y).toBeGreaterThanOrEqual(0);
    }
    // Every option is reachable and clickable.
    await page.locator("#photo-sort-captured-asc").click();
    await expect(page.locator("#photo-sort-label")).toHaveText("Oldest captures");
  });

  test("community tile shows the hour then the full tag, with no city line", async ({ page }) => {
    await gotoGallery(page);
    await page.setViewportSize({ width: 393, height: 852 });
    await openFirstDay(page);
    const tile = page.locator("#detail-photos .photo-tile").filter({ hasText: "@sky-bucharest-extra8" }).first();
    await expect(tile).toBeVisible();
    await expect(tile.locator(".photo-tile-city")).toHaveCount(0);

    const read = () =>
      tile.evaluate((element) => {
        const time = element.querySelector<HTMLElement>(".photo-tile-time");
        const tag = element.querySelector<HTMLElement>(".photo-tile-tag");
        if (!time || !tag) return null;
        const tileRect = element.getBoundingClientRect();
        const timeRect = time.getBoundingClientRect();
        const tagRect = tag.getBoundingClientRect();
        return {
          time: time.textContent,
          tag: tag.textContent,
          tagScrollWidth: tag.scrollWidth,
          tagClientWidth: tag.clientWidth,
          tagLeft: tagRect.left,
          tagRight: tagRect.right,
          tileLeft: tileRect.left,
          tileRight: tileRect.right,
          timeBottom: timeRect.bottom,
          tagTop: tagRect.top,
          tagFontSize: Number.parseFloat(getComputedStyle(tag).fontSize),
          timeFontSize: Number.parseFloat(getComputedStyle(time).fontSize),
        };
      });

    const phone = await read();
    expect(phone).not.toBeNull();
    if (!phone) return;
    expect(phone.time).toMatch(/^\d{2}:\d{2}$/);
    expect(phone.tag).toBe("@sky-bucharest-extra8");
    expect(phone.tagScrollWidth).toBeLessThanOrEqual(phone.tagClientWidth);
    expect(phone.tagLeft).toBeGreaterThanOrEqual(phone.tileLeft - 1);
    expect(phone.tagRight).toBeLessThanOrEqual(phone.tileRight + 1);
    expect(phone.tagTop).toBeGreaterThanOrEqual(phone.timeBottom - 1);
    expect(phone.timeFontSize).toBeGreaterThanOrEqual(14);
    expect(phone.timeFontSize).toBeLessThanOrEqual(15);
    expect(phone.tagFontSize).toBe(9);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);
    const wide = await read();
    expect(wide).not.toBeNull();
    if (!wide) return;
    expect(wide.tag).toBe("@sky-bucharest-extra8");
    expect(wide.tagScrollWidth).toBeLessThanOrEqual(wide.tagClientWidth);
    expect(wide.tagRight).toBeLessThanOrEqual(wide.tileRight + 1);
    expect(wide.tagTop).toBeGreaterThanOrEqual(wide.timeBottom - 1);
  });

  test("detail uses one vertical rhythm and breathes around the community row", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    for (const width of [393, 820, 1440]) {
      await page.setViewportSize({ width, height: width === 393 ? 852 : width === 820 ? 1180 : 900 });
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".detail-content");
        if (!content) return null;
        const rects = Array.from(content.children)
          .filter((element) => !(element as HTMLElement).hidden && getComputedStyle(element).display !== "none")
          .map((element) => element.getBoundingClientRect());
        const gaps: number[] = [];
        for (let index = 1; index < rects.length; index += 1) {
          gaps.push(Math.round((rects[index]!.top - rects[index - 1]!.bottom) * 100) / 100);
        }
        const row = document.querySelector<HTMLElement>("#detail-photos-section > div");
        const grid = document.querySelector<HTMLElement>("#detail-photos");
        const screen = document.querySelector<HTMLElement>("#screen-detail");
        return {
          rowGap: Number.parseFloat(getComputedStyle(content).rowGap),
          gaps,
          rowToGrid: row && grid ? Math.round((grid.getBoundingClientRect().top - row.getBoundingClientRect().bottom) * 100) / 100 : null,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          scrollable: screen ? screen.scrollHeight > screen.clientHeight : false,
        };
      });
      expect(metrics).not.toBeNull();
      if (!metrics) return;
      const expected = width < 640 ? 20 : 24;
      expect(metrics.rowGap, `section gap at ${width}`).toBe(expected);
      for (const gap of metrics.gaps) {
        expect(gap, `every section gap at ${width}`).toBeGreaterThanOrEqual(expected - 0.5);
        expect(gap, `every section gap at ${width}`).toBeLessThanOrEqual(expected + 0.5);
      }
      expect(metrics.rowToGrid, `community row to grid at ${width}`).toBeGreaterThanOrEqual(10);
      expect(metrics.rowToGrid, `community row to grid at ${width}`).toBeLessThanOrEqual(12);
      expect(metrics.overflowX, `horizontal overflow at ${width}`).toBe(0);
      expect(metrics.scrollable, `detail scrolls at ${width}`).toBe(true);
    }
  });

  test("community tiles brighten on hover and the scroll-top button works", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    const tile = page.locator("#detail-photos .photo-tile").first();
    await expect(tile).toHaveCSS("filter", "brightness(0.86)");
    await tile.hover();
    await expect(tile).toHaveCSS("filter", "brightness(1.06)");
    const transform = await tile.evaluate((element) => getComputedStyle(element).transform);
    expect(transform).toBe("none");

    const detail = page.locator("#screen-detail");
    await page.setViewportSize({ width: 393, height: 500 });
    await detail.evaluate((element) => {
      element.scrollTop = 600;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator("#detail-scroll-top")).toBeVisible();
    await page.locator("#detail-scroll-top").click();
    await expect.poll(() => detail.evaluate((element) => element.scrollTop), { timeout: 2000 }).toBe(0);
    await expect(page.locator("#detail-scroll-top")).toBeHidden();
  });

  test("photo deep link opens the info modal and closing removes it", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&photo=photo-1");
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/, { timeout: 10_000 });
    await expect(page.locator("#photo-modal-handle")).toHaveText("@sky-bucharest-48b");
    expect(new URL(page.url()).searchParams.get("photo")).toBe("photo-1");
    await page.keyboard.press("Escape");
    await expect(page.locator("#photo-modal")).not.toHaveClass(/is-open/);
    expect(new URL(page.url()).searchParams.has("photo")).toBe(false);
  });

  test("handle deep link resolves the photo and keeps tag in the URL", async ({ page }) => {
    await page.goto("/?city=bucharest-romania&tag=sky-bucharest-extra8");
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/, { timeout: 10_000 });
    await expect(page.locator("#photo-modal-handle")).toHaveText("@sky-bucharest-extra8");
    await expect(page.locator("#photo-modal-city")).toContainText("Bucharest");
    expect(new URL(page.url()).searchParams.get("tag")).toBe("sky-bucharest-extra8");

    await page.locator('#photo-modal button[data-action="close-photo"]').click();
    await expect(page.locator("#photo-modal")).not.toHaveClass(/is-open/);
    expect(new URL(page.url()).searchParams.has("tag")).toBe(false);
    expect(new URL(page.url()).searchParams.has("photo")).toBe(false);
  });

  test("photo modal has no visible title but stays announced as a sky photo", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#detail-photos .photo-tile").first().click();
    const modal = page.locator("#photo-modal");
    await expect(modal).toHaveClass(/is-open/);
    await expect(modal).toHaveAttribute("aria-label", "Sky photo");
    await expect(modal).not.toHaveAttribute("aria-labelledby", /.+/);
    await expect(page.locator("#photo-modal-title")).toHaveText("");
    await expect(modal).toHaveAccessibleName("Sky photo");
    expect(new URL(page.url()).searchParams.get("tag")).toBe("sky-bucharest-48b");
    expect(new URL(page.url()).searchParams.has("photo")).toBe(false);
  });

  test("photo share opens the native sheet with a handle link and never downloads", async ({ page }) => {
    await stubShareApi(page, { canShare: true });
    await stubClipboard(page);
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#detail-photos .photo-tile").first().click();
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/);

    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });

    await page.locator('[data-action="share-photo"]').click();
    await expect.poll(async () => (await readShareProbe(page)).calls).toBe(1);
    const probe = await readShareProbe(page);
    expect(probe.url).toBe("http://localhost:4173/?tag=sky-bucharest-48b");
    expect(probe.title).toBe("Sky photo by @sky-bucharest-48b");
    expect(probe.text).toContain("Bucharest");
    expect(probe.files).toHaveLength(0);
    await page.waitForTimeout(300);
    expect(downloads).toBe(0);
    expect(await readCopied(page)).toBe("");
    await expect(page.locator("#toast")).not.toHaveClass(/is-visible/);
  });

  test("photo share fallback copies the handle link and toasts, with no file", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    });
    await stubClipboard(page);
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#detail-photos .photo-tile").first().click();
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/);

    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    await page.locator('[data-action="share-photo"]').click();
    await expect(page.locator("#toast-msg")).toHaveText("Link copied");
    expect(await readCopied(page)).toBe("http://localhost:4173/?tag=sky-bucharest-48b");
    await page.waitForTimeout(300);
    expect(downloads).toBe(0);
  });

  test("cancelling the photo share sheet is silent and copies nothing", async ({ page }) => {
    await stubShareApi(page, { canShare: true, abort: true });
    await stubClipboard(page);
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#detail-photos .photo-tile").first().click();
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/);

    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    await page.locator('[data-action="share-photo"]').click();
    await expect.poll(async () => (await readShareProbe(page)).calls).toBe(1);
    await expect(page.locator("#photo-share")).toBeEnabled();
    await page.waitForTimeout(300);
    expect(downloads).toBe(0);
    expect(await readCopied(page)).toBe("");
    await expect(page.locator("#toast")).not.toHaveClass(/is-visible/);
  });

  test("share disables only while the sheet is open, copy stays live", async ({ page }) => {
    await stubShareApi(page, { canShare: true, hold: true });
    await stubClipboard(page);
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#detail-photos .photo-tile").first().click();
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/);

    const share = page.locator("#photo-share");
    const copy = page.locator("#photo-copy-link");
    await share.click();
    await expect(share).toBeDisabled();
    await expect(share).toHaveAttribute("aria-busy", "true");
    await expect(copy).toBeEnabled();
    await page.evaluate(() => (window as Window & { __releaseShare?: () => void }).__releaseShare?.());
    await expect(share).toBeEnabled();
    await expect(share).toHaveAttribute("aria-busy", "false");
  });

  test("photo footer puts copy left and share right, equal, 44 px and focus ordered", async ({ page }) => {
    await stubClipboard(page);
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#detail-photos .photo-tile").first().click();
    await expect(page.locator("#photo-modal")).toHaveClass(/is-open/);

    const copy = page.locator("#photo-copy-link");
    const share = page.locator("#photo-share");
    await expect(copy).toHaveText("Copy link");
    await expect(copy).toHaveAttribute("data-action", "copy-photo-link");
    await expect(share).toHaveAttribute("data-action", "share-photo");

    const geometry = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          background: style.backgroundColor,
          color: style.color,
          borderWidth: style.borderTopWidth,
        };
      };
      const a = document.querySelector("#photo-copy-link");
      const b = document.querySelector("#photo-share");
      return {
        copy: read("#photo-copy-link"),
        share: read("#photo-share"),
        copyBeforeShare: Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(geometry.copy).not.toBeNull();
    expect(geometry.share).not.toBeNull();
    if (!geometry.copy || !geometry.share) return;
    expect(geometry.copy.height).toBeGreaterThanOrEqual(44);
    expect(geometry.share.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(geometry.copy.width - geometry.share.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.copy.y - geometry.share.y)).toBeLessThanOrEqual(1);
    const gap = geometry.share.x - (geometry.copy.x + geometry.copy.width);
    expect(gap).toBeGreaterThanOrEqual(6);
    expect(gap).toBeLessThanOrEqual(10);
    expect(geometry.copy.background).toBe("rgb(255, 255, 255)");
    expect(geometry.copy.color).toBe("rgb(0, 0, 0)");
    expect(geometry.copy.borderWidth).toBe("1px");
    expect(geometry.share.background).toBe("rgb(0, 0, 0)");
    expect(geometry.share.color).toBe("rgb(255, 255, 255)");
    expect(geometry.copyBeforeShare).toBe(true);
    expect(await copy.evaluate((element) => element.tabIndex)).toBe(0);
    expect(await share.evaluate((element) => element.tabIndex)).toBe(0);

    await copy.click();
    await expect(page.locator("#toast-msg")).toHaveText("Link copied");
    expect(await readCopied(page)).toBe("http://localhost:4173/?tag=sky-bucharest-48b");
  });

  test("detail phase glass and community strip match the gallery", async ({ page }) => {
    await gotoGallery(page);
    await openFirstDay(page);
    const phase = page.locator("#hud-phase-pill");
    const phaseStyle = await phase.evaluate((element) => {
      const style = getComputedStyle(element);
      return { filter: style.backdropFilter, background: style.backgroundColor, border: style.borderTopColor, shadow: style.boxShadow };
    });
    expect(phaseStyle.filter).toContain("blur");
    expect(phaseStyle.background).toMatch(/rgba\(255, 255, 255, 0\.1/);
    expect(phaseStyle.shadow).toContain("inset");

    const strip = page.locator("#detail-photos");
    const stripStyle = await strip.evaluate((element) => {
      const style = getComputedStyle(element);
      return { gap: style.gap, overflow: style.overflow, radius: Number.parseFloat(style.borderRadius), shadow: style.boxShadow };
    });
    expect(stripStyle.gap).toBe("0px");
    expect(stripStyle.overflow).toBe("hidden");
    expect(stripStyle.radius).toBeGreaterThanOrEqual(16);
    expect(stripStyle.shadow).toBe("none");
    const skyShadow = await page.locator("#sky-renderer").evaluate((element) => getComputedStyle(element.parentElement as Element).boxShadow);
    expect(skyShadow).toBe("none");

    const tiles = page.locator("#detail-photos .photo-tile");
    await expect(tiles.first()).toBeVisible();
    const overlay = await tiles.first().locator(".photo-tile-shade").evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(overlay).toContain("rgba(0, 0, 0");
    const loaded = await tiles.first().locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth);
    expect(loaded).toBeGreaterThan(0);
    const tileRadius = await tiles.first().evaluate((element) => getComputedStyle(element).borderRadius);
    expect(tileRadius).toBe("0px");
  });

  test("detail renders a designed empty community state", async ({ page, api }) => {
    api.emptyGallery();
    await gotoGallery(page);
    await openFirstDay(page);

    await expect(page.locator("#detail-photos-section")).toBeVisible();
    await expect(page.locator("#detail-photos-empty")).toBeVisible();
    await expect(page.locator("#detail-photos-empty-title")).toHaveText(
      "No skies for this day yet. Be the first. New photos appear after a quick review.",
    );
    await expect(page.locator("#detail-photos-section")).not.toContainText(
      "Contribute with the Submit button in the bottom navigation.",
    );
    await expect(page.locator("#detail-photos-empty")).toHaveCSS("border-top-style", "none");
    expect(
      await page.locator("#detail-photos-empty").evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await expect(page.locator("#detail-photos-empty")).not.toContainText("Share a photo of this sky");
    await expect(page.locator("#detail-photos .photo-tile")).toHaveCount(0);
    const share = page.locator("#detail-photos-empty button", { hasText: "Share your sky" });
    await expect(share).toBeVisible();
    expect((await share.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await share.click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#screen-detail")).not.toHaveClass(/active/);
  });

  test("submit treats pressing the button as CC0 consent", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#consent-checkbox")).toHaveCount(0);
    const footer = page.locator("#submit-sticky-footer");
    await expect(footer).toContainText("Photos are reviewed before publication");
    await expect(footer).toContainText("By submitting, you agree to publish this photo under CC0 and confirm you own it.");
    await expect(footer).not.toContainText("No account needed");
    await expect(footer.locator('a[href="/privacy.html"]')).toHaveAttribute("target", "_blank");
    await expect(footer.locator('a[href="/terms.html"]')).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("home carries no legal or attribution text", async ({ page }) => {
    await gotoHome(page);
    const home = page.locator("#screen-home");
    await expect(home).not.toContainText("Privacy");
    await expect(home).not.toContainText("Terms");
    await expect(home).not.toContainText("Open-Meteo");
    await expect(page.locator("#screen-home footer")).toHaveCount(0);
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
    expect(appearance?.appearance).toBe("always");
    expect(appearance?.size).toBe("invisible");
    await expect(page.locator("#bot-status-label")).toHaveText("Protected");
    const turnstileBox = await page.locator("#turnstile-box").evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    expect(turnstileBox.height).toBeLessThanOrEqual(1);
    expect(turnstileBox.ariaHidden).toBe("true");
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
    expect(api.lastSubmitBody).toContain("2026-11-14T14:15:00.000Z");
    expect(api.lastSubmitBody).toContain('name="consent"');
    expect(api.lastSubmitBody).toContain("true");
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

  test("photo capture time fills the time and day pills", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await page.locator("#sky-file-input").setInputFiles({ name: "beach.png", mimeType: "image/png", buffer: TAKEN_AT_PNG });

    await expect(page.locator("[data-time-hour]")).toHaveText("18", { timeout: 10_000 });
    await expect(page.locator("[data-time-minute]")).toHaveText("42");
    await expect(page.locator("#submit-time-day")).toContainText("Nov 10");

    await page.locator("#submit-time-stepper").click();
    await expect(page.locator('.time-wheel-column[data-wheel="day"] .time-wheel-item[aria-selected="true"]')).toContainText("Nov 10");
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

  test("submit fields share geometry and the inline wheel is keyboard accessible", async ({ page }) => {
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
    for (const [index, item] of geometry.entries()) {
      expect(item.height).toBeCloseTo(geometry[0]!.height, 1);
      expect(item.paddingLeft).toBe(geometry[0]!.paddingLeft);
      if (index < 2) expect(item.paddingRight).toBe(geometry[0]!.paddingRight);
      else expect(item.paddingRight, "handle reserves the pencil inset").toBe("58px");
      expect(item.radius).toBe(geometry[0]!.radius);
      expect(item.border).toBe(geometry[0]!.border);
      expect(item.border).toBe("0px");
    }

    const pill = page.locator("#submit-time-stepper");
    await expect(pill).toContainText(/\d{2}\s*:\s*\d{2}\s*·\s*[A-Z][a-z]{2} \d{1,2}/);
    const pillText = (await pill.textContent()) ?? "";
    expect(pillText).not.toContain("Today");
    await expect(pill).toHaveAttribute("aria-label", /Capture time, \d{2}:\d{2}, /);
    const hour = page.locator("[data-time-hour]");
    const minute = page.locator("[data-time-minute]");
    await expect(hour).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(minute).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const wheel = page.locator("#submit-time-wheel");
    await expect(page.locator("[data-time-decrease]")).toHaveCount(0);
    await expect(page.locator("[data-time-increase]")).toHaveCount(0);
    const beforeHour = Number(await hour.textContent());
    await hour.click();
    await expect(hour).not.toHaveClass(/is-selected/);
    await expect(hour).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(wheel).toBeVisible();
    for (const key of ["hour", "minute", "day"]) {
      const column = wheel.locator(`[data-wheel="${key}"]`);
      const centered = await column.evaluate((element) => {
        const selected = element.querySelector<HTMLElement>(".time-wheel-item.is-selected");
        if (!selected) return false;
        const columnRect = element.getBoundingClientRect();
        const rowRect = selected.getBoundingClientRect();
        return Math.abs(rowRect.top + rowRect.height / 2 - (columnRect.top + columnRect.height / 2)) <= 2;
      });
      expect(centered, `${key} column centred`).toBe(true);
    }
    const hourColumn = wheel.locator('[data-wheel="hour"]');
    await expect(hourColumn).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(hour).toHaveText(String((beforeHour + 1) % 24).padStart(2, "0"));
    await page.keyboard.press("ArrowRight");
    await expect(wheel.locator('[data-wheel="minute"]')).toBeFocused();
    const beforeMinute = Number(await minute.textContent());
    await page.keyboard.press("ArrowDown");
    await expect(minute).toHaveText(String((beforeMinute + 1) % 60).padStart(2, "0"));
    const keptMinute = await minute.textContent();
    await page.keyboard.press("Escape");
    await expect(wheel).toBeHidden();
    await expect(minute).toHaveText(keptMinute ?? "");
    for (const locator of [hour, minute]) {
      const box = await locator.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("submit handle validates inline without a regenerate button", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator('[data-action="randomize-handle"]')).toHaveCount(0);
    const handle = page.locator("#submit-handle-input");
    await expect(handle).not.toHaveValue("—");
    await expect(handle).toHaveAttribute("readonly", "");
    await handle.click();
    await expect(handle).not.toHaveAttribute("readonly", "");
    await handle.fill("ab");
    await expect(page.locator("#handle-status")).toHaveText("Validating…");
    await expect(page.locator("#handle-status")).toHaveText("Too short · at least 5 characters", { timeout: 5000 });
    await handle.fill("admin");
    await expect(page.locator("#handle-status")).toHaveText("That tag is reserved", { timeout: 5000 });
    await handle.fill("taken-tag");
    await expect(page.locator("#handle-status")).toHaveText("Taken", { timeout: 5000 });
    await handle.fill("valid-sky-01");
    await expect(page.locator("#handle-status")).toHaveText("Available", { timeout: 5000 });
  });

  test("submit copy and controls follow the photo state", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#submit-modal .modal-card")).toBeFocused();
    const dropzone = page.locator("#upload-dropzone");
    if (await page.evaluate(() => matchMedia("(hover: none)").matches)) {
      await expect(dropzone.locator(".dropzone-mobile")).toBeVisible();
      await expect(dropzone.locator(".dropzone-desktop")).toBeHidden();
    } else {
      await expect(dropzone.locator(".dropzone-desktop")).toBeVisible();
      await expect(dropzone.locator(".dropzone-mobile")).toBeHidden();
    }
    await expect(dropzone).toContainText("JPG, PNG or WebP · up to 30 MB");
    const submit = page.locator("#submit-btn");
    await expect(submit).toHaveText("Upload your sky");
    await expect(submit).toBeDisabled();
    await page.waitForTimeout(150);
    const emptyDropHeight = (await dropzone.boundingBox())?.height ?? 0;
    const emptyColourHeight = (await page.locator("#submit-palette-empty").boundingBox())?.height ?? 0;
    await page.locator("#sky-file-input").setInputFiles({ name: "sky.png", mimeType: "image/png", buffer: GOOD_PNG });
    await expect(submit).toHaveText("Submit for review →");
    await expect(page.locator("#submit-color-status")).toHaveCount(0);
    await expect(page.locator("#submit-palette-empty")).toBeHidden();
    await expect(page.locator("#submit-palette-result")).toBeVisible();
    const afterDropHeight = (await dropzone.boundingBox())?.height ?? 0;
    expect(Math.abs(afterDropHeight - emptyDropHeight)).toBeLessThanOrEqual(1);
    const afterColourHeight = (await page.locator("#submit-palette-result").boundingBox())?.height ?? 0;
    expect(Math.abs(afterColourHeight - emptyColourHeight)).toBeLessThanOrEqual(1);
    await expect(page.locator("#submit-btn-label")).toHaveText("Submit for review →");
    const footerWidth = await page.locator("#submit-footer").evaluate((element) => element.getBoundingClientRect().width);
    const bodyWidth = await page.locator("#submit-form-body").evaluate((element) => {
      const style = getComputedStyle(element);
      return element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    });
    expect(footerWidth / bodyWidth).toBeGreaterThanOrEqual(0.9);
    const editBox = await page.locator("#submit-handle-edit").boundingBox();
    const fieldBox = await page.locator("#submit-handle-field").boundingBox();
    expect(editBox).not.toBeNull();
    expect(fieldBox).not.toBeNull();
    if (editBox && fieldBox) expect(editBox.x + editBox.width).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width - 24);
    const footerStyle = await page.locator("#submit-footer").evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, size: style.fontSize };
    });
    const protectedStyle = await page.locator("#bot-status").evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, size: style.fontSize };
    });
    expect(protectedStyle.family).toBe(footerStyle.family);
    expect(protectedStyle.size).toBe(footerStyle.size);
    await expect(page.locator("#submit-footer a").first()).toHaveText("Privacy Policy");
    const fieldStyle = await page.locator("#submit-location-input").evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, color: style.color };
    });
    const tagStyle = await page.locator("#submit-handle-input").evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, color: style.color };
    });
    expect(tagStyle).toEqual(fieldStyle);
    await page.locator("#submit-time-stepper").hover();
    const timeHover = await page.locator("#submit-time-stepper").evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.locator("#submit-handle-field").hover();
    const tagHover = await page.locator("#submit-handle-field").evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(timeHover).not.toBe("rgb(245, 245, 245)");
    expect(tagHover).not.toBe("rgb(245, 245, 245)");
    const handle = page.locator("#submit-handle-input");
    await expect(handle).toHaveAttribute("aria-label", "Tag");
    await expect(page.locator("#submit-handle-edit")).toBeVisible();
    await expect(handle).toHaveAttribute("readonly", "");
    await page.locator("#submit-handle-field").click();
    await expect(handle).not.toHaveAttribute("readonly", "");
    expect(await page.locator("#submit-btn").evaluate((element) => getComputedStyle(element).touchAction)).toBe("manipulation");
    expect(await handle.evaluate((element) => getComputedStyle(element).touchAction)).toBe("manipulation");
  });

  test("submit sticky footer stays visible while the body scrolls", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-15-pro", "mobile sticky footer");
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    const body = page.locator("#submit-form-body");
    await body.evaluate((element) => { element.scrollTop = 240; });
    await expect(page.locator("#submit-btn")).toBeVisible();
    const box = await page.locator("#submit-btn").boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.y + box.height).toBeLessThanOrEqual(852 + 1);
    await expect(page.locator("#submit-footer")).toContainText("Photos are reviewed before publication");
    await expect(page.locator("#submit-footer")).not.toContainText("No account needed");
    await expect(page.locator("#submit-footer")).toContainText("Protected");
  });

  test("boot script sets the route tint before the app bundle runs", async ({ page }) => {
    // The Worker's CSP allows 'self' scripts only, so the tint lives in
    // /boot.js, not inline. Block the app bundle and read the first paint.
    await page.route("**/assets/*.js", (route) => route.abort("failed"));
    const read = () => page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor,
      meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
      hasBoot: Boolean(document.querySelector('script[src="/boot.js"]')),
    }));

    await page.goto("/?view=detail", { waitUntil: "domcontentloaded" });
    const detail = await read();
    expect(detail.hasBoot).toBe(true);
    expect(detail.meta).toBe("#ffffff");
    expect(detail.body).toBe("rgb(255, 255, 255)");
    expect(detail.html).toBe("rgb(255, 255, 255)");

    await page.goto("/?view=gallery", { waitUntil: "domcontentloaded" });
    const gallery = await read();
    expect(gallery.meta).toBe("#000000");
    expect(gallery.body).toBe("rgb(0, 0, 0)");
    expect(gallery.html).toBe("rgb(0, 0, 0)");
  });

  test("first paint tint comes from the route before the app boots", async ({ page }) => {
    // Block the app entry so only the inline head script can set the tint.
    await page.route("**/src/client/main.ts", (route) => route.abort("failed"));
    await page.goto("/?view=detail", { waitUntil: "domcontentloaded" });
    const detail = await page.evaluate(() => ({
      meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    }));
    expect(detail.meta).toBe("#ffffff");
    expect(detail.html).toBe("rgb(255, 255, 255)");
    expect(detail.body).toBe("rgb(255, 255, 255)");

    await page.goto("/?view=gallery", { waitUntil: "domcontentloaded" });
    const gallery = await page.evaluate(() => ({
      meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
      html: getComputedStyle(document.documentElement).backgroundColor,
    }));
    expect(gallery.meta).toBe("#000000");
    expect(gallery.html).toBe("rgb(0, 0, 0)");
  });

  test("submit footer is pinned to the card bottom, never floating over content", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);

    const geometry = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>("#submit-form-body")!;
      body.scrollTop = body.scrollHeight;
      const card = document.querySelector<HTMLElement>("#submit-modal .modal-card")!.getBoundingClientRect();
      const footer = document.querySelector<HTMLElement>("#submit-sticky-footer")!.getBoundingClientRect();
      const hit = document.elementFromPoint(card.left + card.width / 2, card.bottom - 4);
      return {
        cardBottom: card.bottom,
        footerBottom: footer.bottom,
        footerTop: footer.top,
        bodyBottom: body.getBoundingClientRect().bottom,
        scrollable: body.scrollHeight - body.clientHeight > 0,
        scrolled: body.scrollTop > 0,
        insideFooter: !!hit?.closest("#submit-sticky-footer"),
      };
    });

    if (geometry.scrollable) expect(geometry.scrolled).toBe(true);
    expect(Math.abs(geometry.cardBottom - geometry.footerBottom)).toBeLessThanOrEqual(1);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.bodyBottom - 1);
    expect(geometry.insideFooter).toBe(true);
  });

  test("browser chrome colour follows the screen, including the bottom extension", async ({ page }) => {
    const read = () => page.evaluate(() => {
      const backdrop = document.querySelector<HTMLElement>("#sky-backdrop")!;
      const root = getComputedStyle(document.documentElement);
      const home = document.querySelector<HTMLElement>("#screen-home");
      return {
        after: getComputedStyle(backdrop, "::after").backgroundColor,
        chromeBottom: root.getPropertyValue("--chrome-bottom").trim(),
        chromeTop: root.getPropertyValue("--chrome-top").trim(),
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        skyBottom: home ? getComputedStyle(home).getPropertyValue("--sky-bottom").trim() : "",
      };
    });

    await page.goto("/?city=bucharest-romania&view=home&time=12%3A00", { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const home = await read();
    // A bright sky, so a stale value would be obvious.
    expect(home.skyBottom).toMatch(/^#[0-9a-f]{6}$/i);
    expect(home.chromeBottom.toLowerCase()).toBe(home.skyBottom.toLowerCase());
    const lower = home.skyBottom.toLowerCase();
    expect(home.after).toBe(
      `rgb(${parseInt(lower.slice(1, 3), 16)}, ${parseInt(lower.slice(3, 5), 16)}, ${parseInt(lower.slice(5, 7), 16)})`,
    );

    await page.locator("#nav-btn-gallery").click();
    await expect.poll(async () => (await read()).chromeBottom).toBe("#000000");
    const gallery = await read();
    expect(gallery.after).toBe("rgb(0, 0, 0)");
    expect(gallery.html).toBe("rgb(0, 0, 0)");
    expect(gallery.body).toBe("rgb(0, 0, 0)");

    await page.locator("#day-cards-grid .day-tile").first().click();
    await expect.poll(async () => (await read()).chromeBottom).toBe("#ffffff");
    const detail = await read();
    expect(detail.after).toBe("rgb(255, 255, 255)");
    expect(detail.body).toBe("rgb(255, 255, 255)");

    await page.locator("#nav-btn-home").click();
    await expect.poll(async () => (await read()).chromeBottom.toLowerCase()).toBe(home.skyBottom.toLowerCase());
    expect((await read()).after).toBe(home.after);
  });

  test("page tint follows the screen and any open dialog", async ({ page }) => {
    const tint = () => page.evaluate(() => ({
      meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    }));

    await gotoHome(page);
    await expect.poll(async () => (await tint()).meta).toMatch(/^#[0-9a-f]{6}$/i);
    const home = await tint();
    // The document background continues the horizon glow under the browser
    // chrome, while theme-color samples the zenith behind the status bar.
    const skyBottom = await page.locator("#screen-home").evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--sky-bottom").trim().toLowerCase(),
    );
    expect(skyBottom).toMatch(/^#[0-9a-f]{6}$/);
    const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    expect(home.html).toBe(rgb(skyBottom));
    expect(home.body).toBe(rgb(skyBottom));

    await gotoGallery(page);
    await expect.poll(async () => (await tint()).meta).toBe("#000000");
    expect((await tint()).html).toBe("rgb(0, 0, 0)");
    expect((await tint()).body).toBe("rgb(0, 0, 0)");

    await openFirstDay(page);
    await expect.poll(async () => (await tint()).meta).toBe("#ffffff");
    expect((await tint()).html).toBe("rgb(255, 255, 255)");
    expect((await tint()).body).toBe("rgb(255, 255, 255)");

    // A hard reload on the detail screen ends white, not the dark default.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await tint()).meta).toBe("#ffffff");
    expect((await tint()).body).toBe("rgb(255, 255, 255)");

    // The strip around an open dialog is the scrim composited over this white
    // screen: rgba(5, 7, 15, 0.72) over #ffffff on touch, 0.55 with a pointer.
    // A dark strip here read as a band above the dimmed page on a device.
    const touchScrim = await page.evaluate(() => matchMedia("(hover: none)").matches);
    await page.locator("#nav-btn-submit").click();
    await expect.poll(async () => (await tint()).meta).toBe(touchScrim ? "#4b4c52" : "#75777b");
    expect((await tint()).body).toBe(touchScrim ? "rgb(75, 76, 82)" : "rgb(117, 119, 123)");
    await page.keyboard.press("Escape");
    await expect(page.locator("#submit-modal")).not.toHaveClass(/is-open/);
    await expect.poll(async () => (await tint()).meta).toBe("#ffffff");
  });

  test("submit rejects HEIC with a clear message and ignores photos without GPS", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await page.locator("#sky-file-input").setInputFiles({ name: "sky.heic", mimeType: "image/heic", buffer: GOOD_PNG });
    await expect(page.locator("#submit-error-text")).toContainText("HEIC isn’t supported");
    await expect(page.locator("#submit-error-text")).toContainText("Most Compatible");
    await page.locator("#sky-file-input").setInputFiles({ name: "sky.png", mimeType: "image/png", buffer: GOOD_PNG });
    await expect(page.locator("#submit-location-input")).toHaveValue("Bucharest, Romania");
    await expect(page.locator("#photo-location-hint")).toBeHidden();
    await expect(page.locator("#from-photo-badge")).toBeHidden();
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

  test("ruler bars use class states instead of per-frame inline sizes", async ({ page }) => {
    await gotoHome(page);
    const active = page.locator("#ruler-tape .ruler-tick.is-active");
    await expect(active).toHaveCount(1);
    await expect(page.locator("#ruler-tape .ruler-tick.is-near").first()).toBeVisible();
    const bar = active.locator(".ruler-bar");
    const state = await bar.evaluate((element) => ({
      transform: getComputedStyle(element).transform,
      inlineHeight: (element as HTMLElement).style.height,
      inlineWidth: (element as HTMLElement).style.width,
      willChange: getComputedStyle(element).willChange,
    }));
    expect(state.transform).not.toBe("none");
    expect(state.inlineHeight).toBe("");
    expect(state.inlineWidth).toBe("");
    expect(state.willChange).toContain("transform");
    expect(state.willChange).not.toContain("height");
  });

  test("tapping Home while home springs the tape back to live", async ({ page }) => {
    await gotoHome(page);
    const display = page.locator("#ruler-time-display");
    await page.locator("#ruler-viewport").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(display).not.toHaveText("16:15");
    await page.locator("#nav-btn-home").click();
    await expect(display).toHaveText("16:15", { timeout: 3000 });
    await expect(page.locator("#home-live-dot")).toBeVisible();
    expect(new URL(page.url()).searchParams.has("time")).toBe(false);
    expect(new URL(page.url()).searchParams.get("view")).toBe("home");
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
    for (const id of ["share-x", "share-facebook", "share-whatsapp"]) {
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
    await expect(page.locator("#share-primary-btn")).toHaveCount(0);
    const row = page.locator("#share-social-row");
    await expect(row).toBeVisible();
    const order = await row.locator(":scope > *").evaluateAll((elements) => elements.map((element) => element.id));
    expect(order).toEqual([
      "share-instagram",
      "share-x",
      "share-whatsapp",
      "share-facebook",
      "share-divider",
      "share-native",
    ]);
    const names: Array<[string, string]> = [
      ["share-x", "Share on X"],
      ["share-facebook", "Share on Facebook"],
      ["share-whatsapp", "Share on WhatsApp"],
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
    await page.locator("#btn-style-telemetry").click();
    await expect(page.locator("#share-native")).toBeEnabled();
    await expect(page.locator("#share-instagram")).toBeEnabled();
    await page.locator("#btn-style-studio").click();
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
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });
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
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });
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
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });
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
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });
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

  test("social buttons open their own composer without a download or native sheet", async ({ page }) => {
    await stubShareApi(page, { canShare: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });
    const x = page.locator("#share-x");
    await expect(x).toBeEnabled({ timeout: 10_000 });
    await x.click();
    await expect.poll(async () => (await readShareProbe(page)).openedUrls.length).toBe(1);
    const probe = await readShareProbe(page);
    expect(probe.calls).toBe(0);
    expect(probe.openedUrls[0]).toContain("twitter.com/intent/tweet");
    expect(decodeURIComponent(probe.openedUrls[0] ?? "")).toContain("view=home");
    expect(probe.openDuringClick).toEqual([true]);
    await expect(x).toBeEnabled();
  });

  test("X, WhatsApp and Facebook open their composers synchronously with exact URLs", async ({ page }) => {
    await stubShareApi(page, { canShare: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });

    await page.evaluate(() => {
      (window as Window & { __copied?: string }).__copied = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { (window as Window & { __copied?: string }).__copied = text; } },
      });
    });
    await page.locator('#share-modal [data-action="copy-link"]').click();
    await expect.poll(async () => page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? "")).not.toBe("");
    const deepLink = await page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? "");
    const meta = (await page.locator("#studio-time").textContent()) ?? "";
    const [time = "", phase = ""] = meta.split(" · ");
    const city = (await page.locator("#home-city-label").textContent()) ?? "";
    const text = `${time} · ${phase} · ${city}`;
    const encodedText = encodeURIComponent(text);
    const encodedUrl = encodeURIComponent(deepLink);
    const expected = [
      `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`,
      `https://wa.me/?text=${encodedText}%20${encodedUrl}`,
      `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    ];

    for (const id of ["share-x", "share-whatsapp", "share-facebook"]) {
      await expect(page.locator(`#${id}`)).toBeEnabled();
      await page.locator(`#${id}`).click();
    }
    await expect.poll(async () => (await readShareProbe(page)).openedUrls.length).toBe(3);
    const probe = await readShareProbe(page);
    expect(probe.calls).toBe(0);
    expect(probe.openedUrls).toEqual(expected);
    expect(probe.openDuringClick).toEqual([true, true, true]);
    for (const id of ["share-x", "share-whatsapp", "share-facebook"]) {
      await expect(page.locator(`#${id}`)).toBeEnabled();
    }
  });

  test("only the in-flight native control disables; link composers stay live", async ({ page }) => {
    await stubShareApi(page, { canShare: true, hold: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });
    const instagram = page.locator("#share-instagram");
    await expect(instagram).toBeEnabled();
    await instagram.click();
    await expect(instagram).toBeDisabled();
    for (const id of ["share-x", "share-whatsapp", "share-facebook", "share-native"]) {
      await expect(page.locator(`#${id}`)).toBeEnabled();
    }
    await page.locator("#share-x").click();
    await expect.poll(async () => (await readShareProbe(page)).openedUrls.length).toBe(1);
    await expect(page.locator("#share-x")).toBeEnabled();
    await page.evaluate(() => (window as Window & { __releaseShare?: () => void }).__releaseShare?.());
    await expect(instagram).toBeEnabled();
  });

  test("cancelling the native share sheet is silent", async ({ page }) => {
    await stubShareApi(page, { canShare: true, abort: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", "studio", { timeout: 10_000 });
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

  test("home cluster uses one text tone", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-14T09:42:00Z"));
    await gotoHome(page);
    const colors = await page.evaluate(() => {
      const selectors = ["#home-city-label", "#screen-home .home-suggest", "#screen-home .home-suggest-strong", "#screen-home .home-suggest-link"];
      return selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? getComputedStyle(element).color : "missing";
      });
    });
    expect(new Set(colors).size, `cluster colours: ${colors.join(", ")}`).toBe(1);
  });

  test("city result rows stay light, readable and full rounded", async ({ page }) => {
    const readRow = (row: import("@playwright/test").Locator) =>
      row.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color, radius: style.borderRadius, height: element.getBoundingClientRect().height };
      });
    const assertRow = async (row: import("@playwright/test").Locator, field: import("@playwright/test").Locator): Promise<void> => {
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("aria-selected", "false");
      const before = await readRow(row);
      expect(before.background).toBe("rgb(255, 255, 255)");
      expect(before.color).toBe("rgb(0, 0, 0)");
      expect(Number.parseFloat(before.radius)).toBeGreaterThanOrEqual(999);
      const fieldBox = await field.boundingBox();
      expect(Math.round(before.height)).toBe(Math.round(fieldBox?.height ?? 0));
      expect(contrastRatio(rgbToHex(before.color), rgbToHex(before.background))).toBeGreaterThanOrEqual(4.5);
      await row.hover();
      await expect(row).toHaveCSS("background-color", "rgb(245, 245, 245)");
      await expect(row).toHaveCSS("color", "rgb(0, 0, 0)");
    };

    await gotoHome(page);
    const homeInput = page.locator("#city-search-input");
    await homeInput.fill("tok");
    await expect(page.locator("#city-dropdown")).toHaveCSS("border-top-left-radius", "28px");
    await assertRow(page.locator('#city-dropdown [role="option"]').first(), homeInput);

    await gotoGallery(page);
    await page.locator("#gallery-location-btn").click();
    const galleryInput = page.locator("#modal-city-search-input");
    await galleryInput.fill("tok");
    await expect(page.locator("#modal-city-dropdown")).toHaveCSS("border-top-left-radius", "28px");
    await assertRow(page.locator('#modal-city-dropdown [role="option"]').first(), galleryInput);

    await page.keyboard.press("Escape");
    await page.locator('#gallery-search-modal button[data-action="close-gallery-search"]').click();
    await expect(page.locator("#gallery-search-modal")).not.toHaveClass(/is-open/);
    await page.locator("#nav-btn-home").click();
    await expect(page.locator("#screen-home")).toHaveClass(/active/);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    const submitInput = page.locator("#submit-location-input");
    await submitInput.fill("tok");
    await expect(page.locator("#submit-location-dropdown")).toHaveCSS("border-top-left-radius", "28px");
    await assertRow(page.locator('#submit-location-dropdown [role="option"]').first(), submitInput);
  });

  test("submit wheel drags, snaps and owns the whole field", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#submit-date-trigger")).toHaveCount(0);
    await expect(page.locator("#submit-date-popover")).toHaveCount(0);
    const body = page.locator("#submit-form-body");
    const field = page.locator("#submit-time-stepper");
    await field.scrollIntoViewIfNeeded();
    const bodyScroll = await body.evaluate((element) => element.scrollTop);
    await field.click();
    const wheel = page.locator("#submit-time-wheel");
    await expect(wheel).toBeVisible();
    const hour = page.locator("[data-time-hour]");
    const minute = page.locator("[data-time-minute]");
    const before = Number(await hour.textContent());
    const column = wheel.locator('[data-wheel="hour"]');
    const box = await column.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(x, y - step * 6);
      await page.waitForTimeout(25);
    }
    // The pill is committed only when the wheel settles.
    expect(Number(await hour.textContent())).toBe(before);
    await page.mouse.up();
    const expected = (before + 1) % 24;
    await expect.poll(async () => Number(await hour.textContent()), { timeout: 2_000 }).toBe(expected);
    await page.waitForTimeout(500);
    expect(Number(await hour.textContent()), "stays after settle").toBe(expected);

    const settled = await column.evaluate((element) => {
      const track = element.querySelector<HTMLElement>(".time-wheel-track")!;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(track).transform);
      const selected = element.querySelector<HTMLElement>(".time-wheel-item.is-selected")!;
      const columnRect = element.getBoundingClientRect();
      const rowRect = selected.getBoundingClientRect();
      return {
        offset: matrix.m42,
        centered: Math.abs(rowRect.top + rowRect.height / 2 - (columnRect.top + columnRect.height / 2)),
      };
    });
    expect(Math.abs(settled.offset / 40 - Math.round(settled.offset / 40))).toBeLessThan(0.01);
    expect(settled.centered).toBeLessThanOrEqual(2);
    expect(await body.evaluate((element) => element.scrollTop)).toBe(bodyScroll);
    await expect(minute).toHaveText(/^\d{2}$/);
    await page.keyboard.press("Escape");
    await expect(wheel).toBeHidden();
  });

  test("submit wheel flings forward and bounces at both ends", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    const field = page.locator("#submit-time-stepper");
    await field.click();
    const wheel = page.locator("#submit-time-wheel");
    await expect(wheel).toBeVisible();
    const hour = page.locator("[data-time-hour]");
    const column = wheel.locator('[data-wheel="hour"]');
    const box = await column.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const before = Number(await hour.textContent());
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 5; step += 1) {
      await page.mouse.move(x, y - step * 40);
    }
    await page.mouse.up();
    await page.waitForTimeout(900);
    const flung = Number(await hour.textContent());
    expect(flung).toBeGreaterThanOrEqual(before + 2);

    // Bounce at 23.
    await column.press("Home");
    await expect(hour).toHaveText("00");
    await column.press("End");
    await expect(hour).toHaveText("23");
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(x, y - step * 12);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(800);
    await expect(hour).toHaveText("23");
    const endCenter = await column.evaluate((element) => {
      const selected = element.querySelector<HTMLElement>(".time-wheel-item.is-selected")!;
      const columnRect = element.getBoundingClientRect();
      const rowRect = selected.getBoundingClientRect();
      return Math.abs(rowRect.top + rowRect.height / 2 - (columnRect.top + columnRect.height / 2));
    });
    expect(endCenter).toBeLessThanOrEqual(2);

    // Bounce at 0.
    await column.press("Home");
    await expect(hour).toHaveText("00");
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(x, y + step * 12);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(800);
    await expect(hour).toHaveText("00");
    await page.keyboard.press("Escape");
    await expect(wheel).toBeHidden();
  });

  test("submit capturedAt combines the wheel day and time in the city zone", async ({ page, api }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
    await page.locator("#sky-file-input").setInputFiles({ name: "sky.png", mimeType: "image/png", buffer: GOOD_PNG });
    await expect(page.locator("#submit-btn")).toBeEnabled();
    await page.locator("#submit-time-stepper").click();
    const wheel = page.locator("#submit-time-wheel");
    await expect(wheel).toBeVisible();
    await page.waitForTimeout(150);
    await wheel.locator('[data-wheel="day"] .time-wheel-item[data-value="2026-11-13"]').click();
    await expect(page.locator("#submit-time-stepper")).toContainText(/·\s*Nov 13/);
    await expect(page.locator("#submit-time-stepper")).toHaveAttribute("aria-label", /November 13/);
    const hourColumn = wheel.locator('[data-wheel="hour"]');
    await hourColumn.press("Home");
    for (let index = 0; index < 10; index += 1) await hourColumn.press("ArrowDown");
    await expect(page.locator("[data-time-hour]")).toHaveText("10");
    await page.keyboard.press("ArrowRight");
    await expect(wheel.locator('[data-wheel="minute"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator("[data-time-minute]")).toHaveText("00");
    await page.keyboard.press("Escape");
    await page.locator("#submit-btn").click();
    await expect(page.locator("#submit-success")).toBeVisible({ timeout: 10_000 });
    const captured = /name="capturedAt"\r\n\r\n([^\r\n]+)/.exec(api.lastSubmitBody ?? "")?.[1];
    expect(captured).toBe("2026-11-13T08:00:00.000Z");
  });

  test("removed copy and controls stay removed", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("#screen-home")).not.toContainText("HQ");

    await page.locator("#nav-btn-gallery").click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await expect(page.locator("#screen-gallery")).not.toContainText("HQ");
    await page.locator("#day-cards-grid .day-tile").first().click();
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    const detail = page.locator("#screen-detail");
    await expect(detail).not.toContainText("Solar geometry · palette model");
    await expect(detail).not.toContainText("5-SWATCH PROFILE");
    await expect(detail).not.toContainText("Tap for reference");
    await expect(page.locator("#detail-time-phase")).toHaveCount(0);
    await expect(detail.locator('[data-action="detail-jump"][data-kind="sunrise"]')).toHaveText("Sunrise");
    await expect(detail.locator('[data-action="detail-jump"][data-kind="noon"]')).toHaveCount(0);

    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#submit-modal")).not.toContainText("Anonymous · pending review");
    await expect(page.locator("#submit-modal")).not.toContainText("Choose a photo to preview its five-swatch palette.");
    await expect(page.locator("#submit-modal")).not.toContainText("Scaled to 1600 px");
    await expect(page.locator('[data-time-decrease]')).toHaveCount(0);
    await expect(page.locator('[data-time-increase]')).toHaveCount(0);
    await expect(page.locator('[data-action="randomize-handle"]')).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#share-telegram")).toHaveCount(0);
    await expect(page.locator("#share-modal")).toContainText("Pantone");
    await expect(page.locator("#share-modal")).not.toContainText("Monolith");
  });

  test("Instagram story composites the selected card and preserves its palette", async ({ page }) => {
    await stubShareApi(page, { canShare: true });
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    const styles = ["studio", "telemetry", "horizon", "monolith"];
    const hashes: number[] = [];
    for (let index = 0; index < styles.length; index += 1) {
      const style = styles[index]!;
      await page.locator(`#btn-style-${style}`).click();
      await expect(page.locator(`#card-variant-${style}`)).toBeVisible();
      await expect(page.locator("#share-modal")).toHaveAttribute("data-card-style", style, { timeout: 10_000 });
      await expect(page.locator("#share-instagram")).toBeEnabled({ timeout: 10_000 });
      await page.locator("#share-instagram").click();
      await expect.poll(() =>
        page.evaluate(() => (window as Window & { __shareFiles?: File[] }).__shareFiles?.length ?? 0),
      ).toBe(index + 1);
      const result = await page.evaluate(async (styleName) => {
        const files = (window as Window & { __shareFiles?: File[] }).__shareFiles ?? [];
        const file = files[files.length - 1];
        if (!file) return null;
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(image, 0, 0);
        URL.revokeObjectURL(url);
        const width = canvas.width;
        const height = canvas.height;
        const pixels = context.getImageData(0, 0, width, height).data;
        const active = document.querySelector<HTMLElement>(".card-variant.is-active");
        const colors = active
          ? Array.from(active.querySelectorAll<HTMLElement>(".swatch-val-0, .swatch-val-1, .swatch-val-2, .swatch-val-3, .swatch-val-4")).map((element) => {
              const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(element).backgroundColor);
              return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
            })
          : [];
        const backgrounds = {
          studio: [250, 250, 252],
          telemetry: [11, 13, 18],
          horizon: [14, 17, 26],
          monolith: [0, 0, 0],
        } as const;
        const backgroundList = Object.values(backgrounds);
        const expected = backgrounds[styleName as keyof typeof backgrounds];
        const near = (r: number, g: number, b: number, target: readonly number[], tolerance = 2): boolean =>
          Math.abs(r - (target[0] ?? 0)) <= tolerance &&
          Math.abs(g - (target[1] ?? 0)) <= tolerance &&
          Math.abs(b - (target[2] ?? 0)) <= tolerance;
        const backgroundCounts = backgroundList.map((target) => {
          let count = 0;
          for (let pixel = 0; pixel < pixels.length; pixel += 4) {
            if (near(pixels[pixel] ?? 0, pixels[pixel + 1] ?? 0, pixels[pixel + 2] ?? 0, target)) count += 1;
          }
          return count;
        });
        const paletteCounts = colors.map(([r = 0, g = 0, b = 0]) => {
          let count = 0;
          for (let pixel = 0; pixel < pixels.length; pixel += 4) {
            if (
              Math.abs((pixels[pixel] ?? 0) - r) <= 1 &&
              Math.abs((pixels[pixel + 1] ?? 0) - g) <= 1 &&
              Math.abs((pixels[pixel + 2] ?? 0) - b) <= 1
            ) {
              count += 1;
            }
          }
          return count;
        });
        let wrongBackgroundRows = 0;
        const bands = [0, Math.max(0, height - 180)];
        for (const bandStart of bands) {
          const bandEnd = Math.min(height, bandStart + 180);
          for (let y = bandStart; y < bandEnd; y += 1) {
            const offset = y * width * 4;
            const r = pixels[offset] ?? 0;
            const g = pixels[offset + 1] ?? 0;
            const b = pixels[offset + 2] ?? 0;
            let uniform = true;
            for (let x = 1; x < width; x += 1) {
              const index = (y * width + x) * 4;
              if (pixels[index] !== r || pixels[index + 1] !== g || pixels[index + 2] !== b) {
                uniform = false;
                break;
              }
            }
            if (uniform && !near(r, g, b, expected, 3)) wrongBackgroundRows += 1;
          }
        }
        let hash = 2166136261;
        for (let pixel = 0; pixel < pixels.length; pixel += 64) {
          hash ^= pixels[pixel] ?? 0;
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        return { width, height, paletteCounts, backgroundCounts, wrongBackgroundRows, hash };
      }, style);
      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(result.paletteCounts.every((count) => count > 500), `palette ${result.paletteCounts.join(",")}`).toBe(true);
      const expectedIndex = styles.indexOf(style);
      expect(result.backgroundCounts[expectedIndex], `dominant ${style}`).toBeGreaterThan(100_000);
      result.backgroundCounts.forEach((count, backgroundIndex) => {
        if (backgroundIndex === expectedIndex) return;
        expect(result.backgroundCounts[expectedIndex], `${style} beats background ${backgroundIndex}`).toBeGreaterThan(count);
      });
      expect(result.wrongBackgroundRows, `${style} wrong top/bottom rows`).toBe(0);
      hashes.push(result.hash);
    }
    expect(new Set(hashes).size).toBe(styles.length);
  });

  test("invisible Turnstile timeout shows the retry state", async ({ page }) => {
    await page.addInitScript(() => { (window as Window & { __turnstileHang?: boolean }).__turnstileHang = true; });
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#bot-status-label")).toHaveText("Check failed", { timeout: 12_000 });
    await expect(page.locator("#turnstile-note")).toContainText("Check failed");
    await expect(page.locator("#turnstile-container iframe")).toHaveCount(0);
  });

  test("privacy and terms static pages resolve with their titles", async ({ page }) => {
    for (const [path, title] of [
      ["/privacy.html", "Privacy — Sky Palette"],
      ["/terms.html", "Terms — Sky Palette"],
    ] as const) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
      expect(await response.text(), path).toContain(`<title>${title}</title>`);
    }
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
    await expect(page.locator('#info-modal a[href="/privacy.html"]').first()).toHaveAttribute("target", "_blank");
    await expect(page.locator('#info-modal a[href="/terms.html"]').first()).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator('#info-modal a[href="https://open-meteo.com/"]')).toHaveCount(1);
    await expect(page.locator('#info-modal a[href="https://open-meteo.com/"]')).toContainText("Open-Meteo");
    const infoFooter = page.locator("#info-modal .modal-card > div:last-child");
    await expect(infoFooter.locator('a[href="/privacy.html"], a[href="/terms.html"], a[href="https://open-meteo.com/"]')).toHaveCount(0);
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
    const nightScrim = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--home-scrim-top"));
    await expect(pill).toHaveCSS("background-color", "rgb(245, 245, 247)");
    await expect(input).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(info).toHaveCSS("background-color", "rgb(245, 245, 247)");
    await expect(info).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(suggest).toHaveCSS("color", "rgb(255, 255, 255)");

    await page.keyboard.press("End");
    await expect(screen).toHaveAttribute("data-tone", "light");
    const dayScrim = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--home-scrim-top"));
    expect(dayScrim).not.toBe(nightScrim);
    await expect(pill).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(input).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(info).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(info).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(suggest).toHaveCSS("color", "rgb(0, 0, 0)");
  });

  test("submit modal form paints on every open", async ({ page }) => {
    await gotoHome(page);
    const ratios: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.locator("#nav-btn-submit").click();
      const modal = page.locator("#submit-modal");
      await expect(modal).toHaveClass(/is-open/);
      await expect(page.locator("#turnstile-state")).toHaveText("ready", { timeout: 8000 });
      const body = page.locator("#submit-form-body");
      await expect(body).toBeVisible();
      await page.waitForTimeout(250);
      const box = await body.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      const screenshot = await page.screenshot({
        clip: {
          x: Math.floor(box.x),
          y: Math.floor(box.y),
          width: Math.max(1, Math.floor(box.width)),
          height: Math.max(1, Math.floor(box.height)),
        },
      });
      const { data, info } = await sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let nonWhite = 0;
      for (let index = 0; index < data.length; index += info.channels) {
        const r = data[index] ?? 255;
        const g = data[index + 1] ?? 255;
        const b = data[index + 2] ?? 255;
        if (r < 250 || g < 250 || b < 250) nonWhite += 1;
      }
      const total = info.width * info.height;
      ratios.push(nonWhite / total);
      expect(ratios[attempt], `open ${attempt + 1} must contain painted pixels`).toBeGreaterThan(0.02);
      if (attempt === 0) {
        await page.keyboard.press("Escape");
        await expect(modal).not.toHaveClass(/is-open/);
      }
    }
    const [first, second] = ratios;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const difference = Math.abs(first - second) / Math.max(first, second);
    expect(difference, `non-white ratio ${first.toFixed(3)} vs ${second.toFixed(3)}`).toBeLessThanOrEqual(0.1);
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


  test("submit palette band is free of pink pixels in Chromium and WebKit", async ({ page }) => {
    const project = test.info().project.name;
    test.skip(!["iphone-15-pro", "webkit-iphone-15-pro", "desktop"].includes(project), "visual pixel scan runs on Chromium and WebKit");
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await page.waitForTimeout(250);
    expect(await assertNoPinkBand(page, "#submit-palette-empty"), "empty palette band").toBe(0);

    await page.locator("#sky-file-input").setInputFiles({ name: "sky.png", mimeType: "image/png", buffer: GOOD_PNG });
    await expect(page.locator("#submit-palette-result")).toBeVisible();
    await expect.poll(async () => page.locator("#submit-color-0").textContent()).toMatch(/^#[0-9A-F]{6}$/);
    await page.waitForTimeout(150);
    expect(await assertNoPinkBand(page, "#submit-palette-result"), "resolved palette band").toBe(0);

    const reset = await page.evaluate(() => {
      const selectors = ["#submit-palette-empty", "#submit-palette-result", "#submit-palette-row"];
      return selectors.map((selector) => {
        const style = getComputedStyle(document.querySelector<HTMLElement>(selector)!);
        return { selector, outline: style.outlineStyle, border: style.borderTopWidth, shadow: style.boxShadow };
      });
    });
    for (const row of reset) {
      expect(row.outline, `${row.selector} outline`).toBe("none");
      expect(row.border, `${row.selector} border`).toBe("0px");
      expect(row.shadow, `${row.selector} shadow`).toBe("none");
    }
  });

  test("submit footer is one inline sentence with a described Protected tooltip", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);

    const footer = page.locator("#submit-footer");
    await expect(footer).toContainText("See the Privacy Policy and Terms · Protected");
    const links = footer.locator("a");
    await expect(links).toHaveCount(2);
    const linkMetrics = await links.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          display: style.display,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          marginLeft: style.marginLeft,
          marginRight: style.marginRight,
          height: rect.height,
          rects: element.getClientRects().length,
        };
      }),
    );
    for (const metric of linkMetrics) {
      expect(metric.display).toBe("inline");
      expect(metric.paddingLeft).toBe("0px");
      expect(metric.paddingRight).toBe("0px");
      expect(metric.marginLeft).toBe("0px");
      expect(metric.marginRight).toBe("0px");
      expect(metric.height).toBeLessThan(24);
      expect(metric.rects).toBe(1);
    }

    const status = page.locator("#bot-status");
    const tooltip = "Cloudflare Turnstile verifies that this submission comes from a human. It runs only when this dialog opens; no personal data is sent.";
    await expect(status).toHaveAttribute("title", tooltip);
    await expect(status).toHaveAttribute("aria-describedby", "turnstile-help");
    await expect(page.locator("#turnstile-help")).toHaveText(tooltip);
    await expect(status).toHaveCSS("display", "inline");
    await expect(status.locator("svg")).toHaveCount(0);
  });

  test("time, tag and location pills share one type recipe and highlight on hover", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);

    const recipe = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          family: style.fontFamily,
          size: style.fontSize,
          weight: style.fontWeight,
          color: style.color,
          spacing: style.letterSpacing,
        };
      });
    const location = await recipe("#submit-location-input");
    expect(await recipe("#submit-time-stepper [data-time-hour]")).toEqual(location);
    expect(await recipe("#submit-time-stepper [data-time-minute]")).toEqual(location);
    expect(await recipe("#submit-time-stepper #submit-time-day")).toEqual(location);
    expect(await recipe("#submit-handle-input")).toEqual(location);
    expect(await recipe("#submit-time-stepper .time-colon")).toEqual(location);

    await page.locator("#submit-time-stepper").hover();
    await expect(page.locator("#submit-time-stepper")).toHaveCSS("background-color", "rgb(236, 236, 236)");
    await page.locator("#submit-handle-field").hover();
    await expect(page.locator("#submit-handle-field")).toHaveCSS("background-color", "rgb(236, 236, 236)");
  });

  test("submit tag pencil stays pinned and matches the location magnifier inset", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);

    const measure = () =>
      page.evaluate(() => {
        const location = document.querySelector<HTMLElement>("#submit-location-input")!;
        const field = location.closest<HTMLElement>(".search-field")!;
        const svgs = field.querySelectorAll<SVGElement>("svg");
        const magnifier = svgs[svgs.length - 1]!;
        const edit = document.querySelector<HTMLElement>("#submit-handle-edit")!;
        const pencil = edit.querySelector<SVGElement>("svg")!;
        const input = document.querySelector<HTMLElement>("#submit-handle-input")!;
        const status = document.querySelector<HTMLElement>("#handle-status")!;
        const magnifierRect = magnifier.getBoundingClientRect();
        const pencilRect = pencil.getBoundingClientRect();
        const editRect = edit.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        const statusRect = status.getBoundingClientRect();
        return {
          magnifierRight: magnifierRect.right,
          pencilRight: pencilRect.right,
          editLeft: editRect.left,
          editRight: editRect.right,
          editWidth: editRect.width,
          editHeight: editRect.height,
          inputRight: inputRect.right,
          statusRight: statusRect.right,
        };
      });

    const idle = await measure();
    expect(Math.abs(idle.pencilRight - idle.magnifierRight)).toBeLessThanOrEqual(2);
    expect(idle.editWidth).toBe(44);
    expect(idle.editHeight).toBe(44);
    expect(idle.inputRight).toBeLessThanOrEqual(idle.editLeft + 0.5);

    const handle = page.locator("#submit-handle-input");
    await handle.click();
    await handle.fill("valid-sky-01");
    await expect(page.locator("#handle-status")).toHaveText("Available", { timeout: 5_000 });
    const available = await measure();
    expect(Math.abs(available.pencilRight - available.magnifierRight)).toBeLessThanOrEqual(2);
    expect(available.pencilRight, "pencil must not move when status appears").toBeCloseTo(idle.pencilRight, 2);
    expect(available.inputRight).toBeLessThanOrEqual(available.editLeft + 0.5);
    expect(available.statusRight).toBeLessThanOrEqual(available.editLeft + 0.5);
  });

  test("opening the time wheel leaves the pill unhighlighted", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    const pill = page.locator("#submit-time-stepper");
    const body = page.locator("#submit-form-body");
    await pill.scrollIntoViewIfNeeded();
    const idle = await pill.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: style.borderTopColor,
        shadow: style.boxShadow,
        hourColor: getComputedStyle(element.querySelector<HTMLElement>("[data-time-hour]")!).color,
        minuteColor: getComputedStyle(element.querySelector<HTMLElement>("[data-time-minute]")!).color,
        scrollTop: document.querySelector<HTMLElement>("#submit-form-body")!.scrollTop,
      };
    });
    await pill.click();
    const wheel = page.locator("#submit-time-wheel");
    await expect(wheel).toBeVisible();

    const open = await pill.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: style.borderTopColor,
        shadow: style.boxShadow,
        hourColor: getComputedStyle(element.querySelector<HTMLElement>("[data-time-hour]")!).color,
        minuteColor: getComputedStyle(element.querySelector<HTMLElement>("[data-time-minute]")!).color,
        scrollTop: document.querySelector<HTMLElement>("#submit-form-body")!.scrollTop,
      };
    });
    expect(open.border).toBe(idle.border);
    expect(open.shadow).toBe(idle.shadow);
    expect(open.hourColor).toBe(idle.hourColor);
    expect(open.minuteColor).toBe(idle.minuteColor);
    expect(open.scrollTop).toBe(idle.scrollTop);
    await expect(page.locator("[data-time-hour]")).not.toHaveClass(/is-selected/);
    await expect(page.locator("[data-time-minute]")).not.toHaveClass(/is-selected/);

    await wheel.locator('[data-wheel="minute"]').focus();
    const focused = await pill.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopColor, shadow: style.boxShadow };
    });
    expect(focused.border).toBe(idle.border);
    expect(focused.shadow).toBe(idle.shadow);
    expect(await body.evaluate((element) => element.scrollTop)).toBe(idle.scrollTop);
    await page.locator("#submit-title").click();
    await expect(wheel).toBeHidden();
  });

  test("share modal closes without a card-only frame", async ({ page }) => {
    await gotoHome(page);
    await page.locator("#dock-share-btn").click();
    await expect(page.locator("#share-modal")).toHaveClass(/is-open/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#share-modal")).not.toHaveClass(/is-open/);
    const styles = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("#share-modal .modal-card")!;
      const active = document.querySelector<HTMLElement>("#share-modal .card-variant.is-active")!;
      const shell = document.querySelector<HTMLElement>("#share-modal")!;
      const cardStyle = getComputedStyle(card);
      const variantStyle = getComputedStyle(active);
      return {
        cardVisibility: cardStyle.visibility,
        cardOpacity: cardStyle.opacity,
        cardTransition: cardStyle.transitionDuration,
        variantVisibility: variantStyle.visibility,
        shellVisibility: getComputedStyle(shell).visibility,
      };
    });
    expect(styles.shellVisibility).toBe("hidden");
    expect(styles.cardVisibility).toBe("hidden");
    expect(styles.cardOpacity).toBe("0");
    expect(styles.cardTransition).toBe("0s");
    expect(styles.variantVisibility).toBe("hidden");
  });

  test("home suggestion row has no background in either tone", async ({ page }) => {
    await gotoHome(page);
    const backgrounds = await page.evaluate(() => {
      const screen = document.querySelector<HTMLElement>("#screen-home")!;
      const row = document.querySelector<HTMLElement>("#screen-home .home-suggest")!;
      const values: Record<string, string> = {};
      for (const tone of ["dark", "light"]) {
        screen.dataset.tone = tone;
        values[tone] = getComputedStyle(row).backgroundColor;
      }
      return values;
    });
    expect(backgrounds.dark).toBe("rgba(0, 0, 0, 0)");
    expect(backgrounds.light).toBe("rgba(0, 0, 0, 0)");
  });

  test("home keeps the sky under floating browser chrome", async ({ page }) => {
    await gotoHome(page);
    const scrims = await page.evaluate(() => {
      const top = document.querySelector<HTMLElement>("#safe-top-scrim")!;
      const bottom = document.querySelector<HTMLElement>("#safe-bottom-scrim")!;
      const home = document.querySelector<HTMLElement>("#screen-home")!;
      const style = getComputedStyle(home);
      return {
        topColor: getComputedStyle(top).backgroundColor,
        bottomColor: getComputedStyle(bottom).backgroundColor,
        bottomImage: getComputedStyle(bottom).backgroundImage,
        zenith: style.getPropertyValue("--sky-zenith").trim(),
        skyBottom: style.getPropertyValue("--sky-bottom").trim(),
        backdrop: getComputedStyle(document.querySelector("#sky-backdrop")!).height,
        after: getComputedStyle(document.querySelector("#sky-backdrop")!, "::after").height,
      };
    });
    const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    // Safari 26+ samples these solid strips for the browser chrome.
    expect(scrims.topColor).toBe(rgb(scrims.zenith.toLowerCase()));
    expect(scrims.bottomColor).toBe(rgb(scrims.skyBottom.toLowerCase()));
    // No gradient over the hero: it only darkened the strip under the toolbar.
    expect(scrims.bottomImage).toBe("none");
    expect(scrims.after).not.toBe("0px");
    expect(scrims.backdrop).not.toBe("0px");

    await gotoGallery(page);
    await expect(page.locator("#safe-bottom-scrim")).not.toHaveCSS("display", "none");
    // On phones the mosaic starts one rem down, so a top scrim would float;
    // above 640 px the grid starts at 0 and the scrim still darkens the tiles.
    const narrow = (page.viewportSize()?.width ?? 0) < 640;
    const topScrim = await page.locator("#safe-top-scrim").evaluate((el) => getComputedStyle(el).display);
    expect(topScrim).toBe(narrow ? "none" : "block");
  });

  test("safe areas stay continuous at 393x852", async ({ page }) => {
    test.skip(page.viewportSize()?.width !== 393, "phone-only visual check");
    await gotoGallery(page);
    const gallery = await edgeAverage(page);
    expect(gallery.top.every((channel) => channel < 70), `gallery top ${gallery.top.join(",")}`).toBe(true);
    expect(gallery.bottom.every((channel) => channel < 70), `gallery bottom ${gallery.bottom.join(",")}`).toBe(true);

    await openFirstDay(page);
    await expect(page.locator("#screen-detail")).toHaveCSS("opacity", "1");
    await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(120);
    const detail = await edgeAverage(page);
    expect(detail.top.every((channel) => channel > 200), `detail top ${detail.top.join(",")}`).toBe(true);
    expect(detail.bottom.every((channel) => channel > 200), `detail bottom ${detail.bottom.join(",")}`).toBe(true);

    const geometry = await page.evaluate(() => {
      const backdrop = getComputedStyle(document.querySelector<HTMLElement>("#sky-backdrop")!);
      const screens = Array.from(document.querySelectorAll<HTMLElement>(".app-screen")).map(
        (screen) => getComputedStyle(screen).backgroundColor,
      );
      return {
        top: backdrop.top,
        left: backdrop.left,
        height: Number.parseFloat(backdrop.height),
        viewport: window.innerHeight,
        screens,
      };
    });
    expect(geometry.top).toBe("0px");
    expect(geometry.left).toBe("0px");
    expect(geometry.height).toBeGreaterThanOrEqual(geometry.viewport - 1);
    expect(geometry.screens.every((color) => color === "rgba(0, 0, 0, 0)")).toBe(true);
  });

  test("network failure shows a retry toast that reruns the failed load", async ({ page }) => {
    await gotoGallery(page);
    const abortHistory = async (route: import("@playwright/test").Route): Promise<void> => { await route.abort("failed"); };
    await page.route("**/api/history**", abortHistory);
    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-30").click();
    await expect(page.locator("#toast")).toContainText("Network unavailable", { timeout: 10_000 });
    await expect(page.locator("#toast")).toHaveClass(/is-visible/);
    await expect(page.locator("#toast-retry")).toBeVisible();

    await page.unroute("**/api/history**", abortHistory);
    await page.locator("#toast-retry").click();
    await expect(page.locator("#day-cards-grid .day-tile")).toHaveCount(30, { timeout: 10_000 });
    await expect(page.locator("#toast")).not.toHaveClass(/is-visible/);
  });

  test("an unrelated success does not hide the offline toast", async ({ page }) => {
    await page.route("**/api/palette**", (route) => route.abort("failed"));
    await gotoHome(page);
    await expect(page.locator("#toast")).toContainText("Network unavailable", { timeout: 10_000 });

    // The history request succeeds when the gallery opens; that must not clear
    // the toast while /api/palette is still unreachable.
    await page.locator("#nav-btn-gallery").click();
    await expect(page.locator("#day-cards-grid .day-tile").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#toast")).toHaveClass(/is-visible/);
    await expect(page.locator("#toast-retry")).toBeVisible();
  });

  test("the toast inverts against the surface behind it", async ({ page }) => {
    await gotoGallery(page);
    await page.route("**/api/history**", (route) => route.abort("failed"));
    await page.locator("#interval-trigger-btn").click();
    await page.locator("#int-btn-30").click();
    await expect(page.locator("#toast")).toHaveClass(/is-visible/);

    // Dark mosaic: white pill, dark ink.
    await expect(page.locator("#toast")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator("#toast-msg")).toHaveCSS("color", "rgb(11, 13, 18)");

    // Light dialog surface: the original black pill returns.
    await page.locator("#nav-btn-submit").click();
    await expect(page.locator("#submit-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#toast")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(page.locator("#toast-msg")).toHaveCSS("color", "rgb(255, 255, 255)");
  });

  test("community skeleton shows on first load and while a page appends", async ({ page }) => {
    test.skip(page.viewportSize()?.width !== 393, "phone review capture");
    await gotoGallery(page);
    let releasePage = (): void => {};
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    const slowGallery = async (route: import("@playwright/test").Route): Promise<void> => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("cursor")) {
        await pageGate;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await route.fallback();
    };
    await page.route("**/api/gallery**", slowGallery);
    await page.locator("#day-cards-grid .day-tile").first().click();
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator("#detail-photos-skeleton")).toBeVisible();
    await expect(page.locator("#detail-photos .photo-tile")).toHaveCount(6, { timeout: 10_000 });
    await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator("#detail-photos-skeleton")).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: "docs/assets/review/loading-iphone.png" });
    await page.unroute("**/api/gallery**", slowGallery);
    releasePage();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await page.locator("#detail-photos .photo-tile").count()) >= 24) break;
      await page.locator("#screen-detail").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(300);
    }
    await expect(page.locator("#detail-photos .photo-tile")).toHaveCount(24, { timeout: 10_000 });
    await expect(page.locator("#detail-photos-skeleton")).toBeHidden();
  });


  test("detail ruler stops at live time today and reaches midnight on past days", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-14T17:05:00Z"));
    await gotoGallery(page);
    await openFirstDay(page);
    const viewport = page.locator("#detail-ruler-viewport");
    const display = page.locator("#detail-ruler-time-display");
    const liveBadge = page.locator("#detail-live-badge");

    await expect(viewport).toHaveAttribute("aria-valuemax", "1140");
    const initial = await display.textContent();
    expect(minutesFromClock(initial ?? ""), "initial hour on today").toBeLessThanOrEqual(1140);

    await viewport.press("End");
    await expect(display).toHaveText("19:00");
    await expect(viewport).toHaveAttribute("aria-valuenow", "1140");
    await expect(viewport).toHaveAttribute("aria-valuetext", /Live/);
    await expect(liveBadge).toBeVisible();
    await expect(page.locator("#detail-ruler-tape .ruler-live-dot")).toBeVisible();
    await expect(page.locator("#detail-ruler-tape .ruler-tick.is-disabled")).toHaveCount(20);

    await page.locator('#detail-ruler-tape .ruler-tick[data-index="90"]').click({ force: true });
    await expect(display).toHaveText("19:00");

    await viewport.press("ArrowLeft");
    await expect(display).toHaveText("18:45");
    await expect(liveBadge).toBeHidden();
    await expect(viewport).toHaveAttribute("aria-valuetext", "18:45");

    await page.locator('#screen-detail [data-action="nav"][data-screen="gallery"]').click();
    await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
    await page.locator("#day-cards-grid .day-tile").nth(1).click();
    await expect(page.locator("#screen-detail")).toHaveClass(/active/);
    await expect(page.locator("#screen-detail")).toHaveCSS("opacity", "1");

    await expect(viewport).toHaveAttribute("aria-valuemax", "1440");
    await expect(liveBadge).toBeHidden();
    await expect(page.locator("#detail-ruler-tape .ruler-live-dot")).toHaveCount(0);
    await viewport.press("End");
    await expect(viewport).toHaveAttribute("aria-valuenow", "1440");
    await viewport.press("ArrowLeft");
    await expect(display).toHaveText("23:45");

    await page.locator('[data-action="detail-jump"][data-kind="sunset"]').click();
    await expect(display).toHaveText("16:45");
  });

  test("detail timelapse stops at the live bound", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.setFixedTime(new Date("2026-11-14T16:50:00Z"));
    await gotoGallery(page);
    await openFirstDay(page);
    await page.locator("#timelapse-btn").click();
    await expect(page.locator("#detail-ruler-time-display")).toHaveText("18:45", { timeout: 5_000 });
    await expect(page.locator("#timelapse-btn")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#detail-live-badge")).toBeVisible();
    await expect(page.locator("#detail-ruler-viewport")).toHaveAttribute("aria-valuemax", "1125");
  });

  test("detail jump buttons beyond the live bound are disabled", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-14T04:05:00Z"));
    await gotoGallery(page);
    await openFirstDay(page);
    const viewport = page.locator("#detail-ruler-viewport");
    const display = page.locator("#detail-ruler-time-display");
    await expect(viewport).toHaveAttribute("aria-valuemax", "360");
    await expect(display).toHaveText("06:00");

    const sunrise = page.locator('[data-action="detail-jump"][data-kind="sunrise"]');
    const golden = page.locator('[data-action="detail-jump"][data-kind="golden"]');
    const sunset = page.locator('[data-action="detail-jump"][data-kind="sunset"]');
    for (const button of [sunrise, golden, sunset]) {
      await expect(button).toHaveAttribute("aria-disabled", "true");
      await expect(button).toHaveCSS("opacity", "0.38");
    }
    await sunrise.click({ force: true });
    await expect(display).toHaveText("06:00");
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

  test("a palette outage shows only the retry toast, no inline card", async ({ page }) => {
    await page.route("**/api/palette**", (route) => route.abort("failed"));
    await page.goto("/");
    await expect(page.locator("#toast")).toContainText("Network unavailable");
    await expect(page.locator("#toast")).toHaveClass(/is-visible/);
    await expect(page.locator("#toast-retry")).toBeVisible();
    await expect(page.locator("#home-error")).toBeHidden();
    await expect(page.locator("#home-elevation")).not.toHaveText("—");
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
