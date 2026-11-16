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
 */

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = "#0b0d12";

function normalize(color: string): string {
  return HEX.test(color) ? color : FALLBACK;
}

function apply(theme: string, surface: string): void {
  const themeValue = normalize(theme);
  const surfaceValue = normalize(surface);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeValue);
  document.documentElement.style.backgroundColor = surfaceValue;
  if (document.body) document.body.style.backgroundColor = surfaceValue;
}

/** Recompute the tint from the active screen, its tone and any open dialog. */
export function refreshThemeColor(): void {
  // A dialog dims the page behind it; the strip around the card is the scrim.
  if (document.querySelector(".modal-shell.is-open")) {
    apply(FALLBACK, FALLBACK);
    return;
  }

  if (document.querySelector("#screen-gallery.active")) {
    apply(FALLBACK, FALLBACK);
    return;
  }

  if (document.querySelector("#screen-detail.active")) {
    apply("#ffffff", "#ffffff");
    return;
  }

  const home = document.querySelector<HTMLElement>("#screen-home.active");
  if (home) {
    const style = getComputedStyle(home);
    const zenith = style.getPropertyValue("--sky-zenith").trim();
    const bottom = style.getPropertyValue("--sky-bottom").trim();
    apply(
      HEX.test(zenith) ? zenith : home.dataset.tone === "light" ? "#dfe7f5" : "#090b10",
      HEX.test(bottom) ? bottom : FALLBACK,
    );
    return;
  }

  apply(FALLBACK, FALLBACK);
}
