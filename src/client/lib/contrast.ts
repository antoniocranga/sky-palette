/**
 * Contrast-aware text colours for the home hero.
 *
 * The hero sits over a live gradient, so its text colour cannot be constant.
 * We sample the rendered backdrop behind each line (linear sky gradient plus
 * the warm radial), then choose pure black or white. Pure black/white always
 * reaches at least ~4.58:1 for any opaque backdrop, so no light card or scrim
 * is needed over the design.
 */

import { clamp01, contrastRatio, hexToRgb, mix, rgbToHex } from "./color";

export interface GradientStop {
  color: string;
  at: number;
}

const DARK_INK = "#000000";
const LIGHT_INK = "#FFFFFF";

/** Interpolate a multi-stop gradient at 0–1. */
export function gradientColorAt(stops: readonly GradientStop[], position: number): string {
  if (stops.length === 0) return "#000000";
  const t = clamp01(position);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return "#000000";
  if (t <= first.at) return first.color;
  if (t >= last.at) return last.color;

  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    if (!from || !to) continue;
    if (t >= from.at && t <= to.at) {
      const span = to.at - from.at;
      const local = span <= 0 ? 0 : (t - from.at) / span;
      return rgbToHex(mix(hexToRgb(from.color), hexToRgb(to.color), local));
    }
  }
  return last.color;
}

/**
 * Vertical slice of the home backdrop used by the hero, matching the CSS
 * gradient coordinates (including the radial warm patch centred at 70%).
 */
export function homeBackdropColor(
  palette: { zenith: string; midsky: string; horizon: string; sunglow: string },
  fraction: number,
): string {
  const base = gradientColorAt(
    [
      { color: palette.zenith, at: 0 },
      { color: palette.midsky, at: 0.4 },
      { color: palette.horizon, at: 0.72 },
      { color: palette.sunglow, at: 1 },
    ],
    fraction,
  );

  // radial-gradient(ellipse 90% 40% at 50% 70%, sunglow 0%, transparent 65%)
  const verticalDistance = Math.abs(fraction - 0.7) / 0.4;
  const radial = clamp01(1 - verticalDistance / 0.65);
  return rgbToHex(mix(hexToRgb(base), hexToRgb(palette.sunglow), radial));
}

/** Pick black or white for a single opaque backdrop. */
export function textColorFor(background: string): string {
  return contrastRatio(DARK_INK, background) >= contrastRatio(LIGHT_INK, background) ? DARK_INK : LIGHT_INK;
}

export interface HomeTextColors {
  /** City line, which sits higher over the midsky. */
  top: string;
  /** Suggestions and muted copy, lower over the horizon. */
  bottom: string;
}

/** Per-line colours, avoiding any shared light scrim/card. */
export function homeTextColors(palette: {
  zenith: string;
  midsky: string;
  horizon: string;
  sunglow: string;
}): HomeTextColors {
  return {
    top: textColorFor(homeBackdropColor(palette, 0.29)),
    bottom: textColorFor(homeBackdropColor(palette, 0.48)),
  };
}

/** Ruler treatment: the time label sits lower, over the warm horizon. */
export function rulerTextColor(palette: { zenith: string; midsky: string; horizon: string; sunglow: string }): string {
  return textColorFor(homeBackdropColor(palette, 0.79));
}

/* -------------------------------------------------------------------------- */
/* Home controls                                                              */
/* -------------------------------------------------------------------------- */

export type HomeTone = "dark" | "light";

export interface HomeControlPalette {
  /** Search pill background. */
  surface: string;
  /** Search text and icon on the pill. */
  surfaceInk: string;
  /** Search placeholder on the pill. */
  placeholder: string;
  /** Focus ring around the pill. */
  focusRing: string;
  /** Suggested-city text and underline. */
  suggestInk: string;
  /** Info button background and glyph. */
  infoSurface: string;
  infoInk: string;
  /** Live/forecast badge inks and its subtle border. */
  modeLive: string;
  modeForecast: string;
  modeBorder: string;
}

/**
 * The search pill and the info button invert against the sky. Both palettes
 * are pure black/white pairs, so each surface keeps at least ~15:1 contrast.
 */
export const HOME_CONTROL_PALETTES: Record<HomeTone, HomeControlPalette> = {
  dark: {
    surface: "#F5F5F7",
    surfaceInk: "#000000",
    placeholder: "#3F3F46",
    focusRing: "rgba(0, 0, 0, 0.30)",
    suggestInk: "#FFFFFF",
    infoSurface: "#F5F5F7",
    infoInk: "#000000",
    modeLive: "#86EFAC",
    modeForecast: "#FCD34D",
    modeBorder: "rgba(255, 255, 255, 0.24)",
  },
  light: {
    surface: "#000000",
    surfaceInk: "#FFFFFF",
    placeholder: "#D4D4D8",
    focusRing: "rgba(255, 255, 255, 0.42)",
    suggestInk: "#000000",
    infoSurface: "#000000",
    infoInk: "#FFFFFF",
    modeLive: "#14532D",
    modeForecast: "#92400E",
    modeBorder: "rgba(0, 0, 0, 0.28)",
  },
};

/** Backdrop slice behind the search pill / suggested chips. */
const CONTROL_FRACTION = 0.47;

/**
 * Choose the control tone with a small hysteresis band so scrubbing across the
 * threshold does not toggle the search pill back and forth on tiny movements.
 */
export function resolveHomeTone(background: string, previous: HomeTone | null = null, band = 0.15): HomeTone {
  const onBlack = contrastRatio(DARK_INK, background);
  const onWhite = contrastRatio(LIGHT_INK, background);
  if (previous === "light") return onWhite > onBlack + band ? "dark" : "light";
  if (previous === "dark") return onBlack > onWhite + band ? "light" : "dark";
  return onWhite >= onBlack ? "dark" : "light";
}

export function nextHomeToneAt(
  palette: { zenith: string; midsky: string; horizon: string; sunglow: string },
  fraction: number,
  previous: HomeTone | null = null,
  band = 0.15,
): HomeTone {
  return resolveHomeTone(homeBackdropColor(palette, fraction), previous, band);
}

export function nextHomeTone(
  palette: { zenith: string; midsky: string; horizon: string; sunglow: string },
  previous: HomeTone | null = null,
  band = 0.15,
): HomeTone {
  return nextHomeToneAt(palette, CONTROL_FRACTION, previous, band);
}
