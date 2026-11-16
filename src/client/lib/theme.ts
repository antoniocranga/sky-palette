/**
 * Page tint. Browsers paint the area outside the web viewport (iOS status bar,
 * Android task switcher, overscroll) with `theme-color` and the root element's
 * background. Both must follow the screen that is actually showing, otherwise
 * the safe areas read as white bands over the dark gallery, or as a stale sky
 * tint over the white detail screen.
 */

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = "#0b0d12";

function apply(color: string): void {
  const value = HEX.test(color) ? color : FALLBACK;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", value);
  document.documentElement.style.backgroundColor = value;
}

/** Recompute the tint from the active screen, its tone and any open dialog. */
export function refreshThemeColor(): void {
  // A dialog dims the page behind it; the strip above the card is the scrim.
  if (document.querySelector(".modal-shell.is-open")) {
    apply(FALLBACK);
    return;
  }

  if (document.querySelector("#screen-gallery.active")) {
    apply(FALLBACK);
    return;
  }

  if (document.querySelector("#screen-detail.active")) {
    apply("#ffffff");
    return;
  }

  const home = document.querySelector<HTMLElement>("#screen-home.active");
  if (home) {
    const zenith = getComputedStyle(home).getPropertyValue("--sky-zenith").trim();
    if (HEX.test(zenith)) {
      apply(zenith);
      return;
    }
    apply(home.dataset.tone === "light" ? "#dfe7f5" : "#090b10");
    return;
  }

  apply(FALLBACK);
}
