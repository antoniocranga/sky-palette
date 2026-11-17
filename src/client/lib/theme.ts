/**
 * Page tint. Browsers paint the area outside the web viewport (iOS status bar,
 * home-indicator strip, browser chrome, overscroll) with the document
 * background and `theme-color`. Both must follow the screen that is showing, or
 * the safe areas read as a dark band over the white detail screen and a stale
 * tint over the gallery.
 *
 * `body` matters as much as `html`: some in-app browsers ignore
 * `viewport-fit=cover` and sample the body background for the strips above and
 * below the web view. Home uses two samples — the zenith under the status bar
 * and the horizon glow under the bottom chrome — so the sky reads continuous.
 *
 * iOS Safari paints the status-bar strip with `theme-color` (measured on iOS
 * 17.5 and 27 simulators against a control page), so a dialog must not leave a
 * dark strip above a light, dimmed screen: the strip is the scrim itself.
 */

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = "#0b0d12";

/** `.modal-backdrop` colour and its two alphas, kept in step with modal-scrim.css. */
const SCRIM_RGB = [5, 7, 15] as const;
const SCRIM_ALPHA_TOUCH = 0.72;
const SCRIM_ALPHA_POINTER = 0.55;

function normalize(color: string): string {
  return HEX.test(color) ? color : FALLBACK;
}

function channels(color: string): [number, number, number] {
  const value = normalize(color);
  return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

/**
 * The colour a dialog scrim puts over `base`: the strip around the card has to
 * be that composite, not the dark default, which painted a 59 px dark band
 * above the dimmed white detail screen.
 */
export function scrimTint(base: string, alpha: number): string {
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : SCRIM_ALPHA_POINTER;
  const [r, g, b] = channels(base);
  const mix = (scrim: number, value: number) =>
    Math.round(scrim * a + value * (1 - a))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(SCRIM_RGB[0], r)}${mix(SCRIM_RGB[1], g)}${mix(SCRIM_RGB[2], b)}`;
}

function scrimAlpha(): number {
  return typeof matchMedia === "function" && matchMedia("(hover: none)").matches
    ? SCRIM_ALPHA_TOUCH
    : SCRIM_ALPHA_POINTER;
}

interface ScreenTint {
  /** Colour of the strip above the web view. */
  theme: string;
  /** Document background under the browser chrome. */
  surface: string;
}

/** The tint pair the active screen asks for, before any dialog dims it. */
function screenTint(): ScreenTint {
  if (document.querySelector("#screen-gallery.active")) return { theme: FALLBACK, surface: FALLBACK };
  if (document.querySelector("#screen-detail.active")) return { theme: "#ffffff", surface: "#ffffff" };

  const home = document.querySelector<HTMLElement>("#screen-home.active");
  if (home) {
    const style = getComputedStyle(home);
    const zenith = style.getPropertyValue("--sky-zenith").trim();
    const bottom = style.getPropertyValue("--sky-bottom").trim();
    return {
      theme: HEX.test(zenith) ? zenith : home.dataset.tone === "light" ? "#dfe7f5" : "#090b10",
      surface: HEX.test(bottom) ? bottom : FALLBACK,
    };
  }

  return { theme: FALLBACK, surface: FALLBACK };
}

function apply(theme: string, surface: string): void {
  const themeValue = normalize(theme);
  const surfaceValue = normalize(surface);
  const root = document.documentElement;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeValue);
  root.style.backgroundColor = surfaceValue;
  if (document.body) document.body.style.backgroundColor = surfaceValue;
  // Safari 26+ reads these from the fixed edge strips instead of theme-color.
  root.style.setProperty("--chrome-top", themeValue);
  root.style.setProperty("--chrome-bottom", surfaceValue);
}

/** Recompute the tint from the active screen, its tone and any open dialog. */
export function refreshThemeColor(): void {
  const tint = screenTint();

  // A dialog dims the page behind it; the strip around the card is that same
  // scrim composited over the screen it is dimming.
  if (document.querySelector(".modal-shell.is-open")) {
    const alpha = scrimAlpha();
    apply(scrimTint(tint.theme, alpha), scrimTint(tint.surface, alpha));
    return;
  }

  apply(tint.theme, tint.surface);
}
