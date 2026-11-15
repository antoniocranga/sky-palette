/**
 * The sky model. One implementation, used by the Worker for authoritative
 * responses and by the browser for zero-latency scrubbing.
 *
 * The swatches come from a small table of physically motivated anchor colours
 * sampled across solar elevation, blended with a C1-continuous cubic Hermite
 * spline so dragging the time scrubber never produces a colour jump. Cloud
 * cover and visibility then modulate the result continuously.
 */

import { clamp, clamp01, hexToRgb, mix, rgbToHex, type Rgb } from "./color";
import { phaseForElevation } from "./solar";
import type { HexColor, Palette, PaletteSwatches } from "./types";

export interface PaletteInput {
  /** Solar elevation in degrees. */
  elevation: number;
  cloudCoverLow?: number;
  cloudCoverMid?: number;
  cloudCoverHigh?: number;
  /** Horizontal visibility in metres. */
  visibility?: number;
}

interface Anchor extends PaletteSwatches {
  elevation: number;
}

const ANCHORS: Anchor[] = [
  { elevation: -90, zenith: "#05070F", midsky: "#090C18", horizon: "#101426", sunglow: "#1B2034", cloudtint: "#161A2A" },
  { elevation: -18, zenith: "#060812", midsky: "#0C101E", horizon: "#14182D", sunglow: "#282D46", cloudtint: "#1E2337" },
  { elevation: -12, zenith: "#080B1C", midsky: "#121530", horizon: "#1E1A38", sunglow: "#38243C", cloudtint: "#241A30" },
  { elevation: -9, zenith: "#0B0E22", midsky: "#171A36", horizon: "#3A2145", sunglow: "#6E3038", cloudtint: "#4A2A3E" },
  { elevation: -6, zenith: "#101533", midsky: "#241A44", horizon: "#5C2A48", sunglow: "#A8483C", cloudtint: "#6E3A4E" },
  { elevation: -2.5, zenith: "#16204A", midsky: "#3A2A5A", horizon: "#A23E4A", sunglow: "#E05A34", cloudtint: "#E0705C" },
  { elevation: 1.5, zenith: "#1D3068", midsky: "#5A3C7A", horizon: "#D26246", sunglow: "#FF9A3C", cloudtint: "#FF9E74" },
  { elevation: 6, zenith: "#204380", midsky: "#4E73A8", horizon: "#D9A07E", sunglow: "#FFC062", cloudtint: "#FFC59C" },
  { elevation: 12, zenith: "#1E4E96", midsky: "#4A82C2", horizon: "#C9AE9E", sunglow: "#FFD07A", cloudtint: "#FFE2C6" },
  { elevation: 30, zenith: "#1657B0", midsky: "#5B9BDD", horizon: "#AFD3F2", sunglow: "#FFF6D2", cloudtint: "#F2FAFF" },
  { elevation: 60, zenith: "#0F4FA8", midsky: "#4F92D8", horizon: "#A6CDF0", sunglow: "#FFFFFF", cloudtint: "#F7FCFF" },
  { elevation: 90, zenith: "#0F4FA8", midsky: "#4F92D8", horizon: "#A6CDF0", sunglow: "#FFFFFF", cloudtint: "#F7FCFF" },
];

const CHANNELS = ["zenith", "midsky", "horizon", "sunglow", "cloudtint"] as const;
type Channel = (typeof CHANNELS)[number];

const ANCHOR_RGB = ANCHORS.map((anchor) => ({
  elevation: anchor.elevation,
  rgb: Object.fromEntries(CHANNELS.map((c) => [c, hexToRgb(anchor[c])])) as Record<Channel, Rgb>,
}));

/** Cubic Hermite with finite-difference tangents: continuous value and slope. */
function cubicHermite(y0: number, y1: number, y2: number, y3: number, x0: number, x1: number, x2: number, x3: number, t: number): number {
  const span = x2 - x1;
  const m1 = ((y2 - y0) / (x2 - x0)) * span;
  const m2 = ((y3 - y1) / (x3 - x1)) * span;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * y1 + h10 * m1 + h01 * y2 + h11 * m2;
}

function sampleChannel(channel: Channel, elevation: number): Rgb {
  const points = ANCHOR_RGB.map((anchor) => ({ x: anchor.elevation, y: anchor.rgb[channel] }));
  const n = points.length;

  if (elevation <= points[0]!.x) return points[0]!.y;
  if (elevation >= points[n - 1]!.x) return points[n - 1]!.y;

  let i = 0;
  while (i < n - 2 && elevation > points[i + 1]!.x) i += 1;

  const p0 = points[Math.max(0, i - 1)]!;
  const p1 = points[i]!;
  const p2 = points[i + 1]!;
  const p3 = points[Math.min(n - 1, i + 2)]!;
  const t = (elevation - p1.x) / (p2.x - p1.x);

  return {
    r: cubicHermite(p0.y.r, p1.y.r, p2.y.r, p3.y.r, p0.x, p1.x, p2.x, p3.x, t),
    g: cubicHermite(p0.y.g, p1.y.g, p2.y.g, p3.y.g, p0.x, p1.x, p2.x, p3.x, t),
    b: cubicHermite(p0.y.b, p1.y.b, p2.y.b, p3.y.b, p0.x, p1.x, p2.x, p3.x, t),
  };
}

const OVERCAST_DAY = hexToRgb("#8A94A4");
const OVERCAST_NIGHT = hexToRgb("#141824");
const HAZE_DAY = hexToRgb("#AEBCCC");
const HAZE_NIGHT = hexToRgb("#1C2230");
const WARM_CLOUD = hexToRgb("#FFB07A");
const COOL_CLOUD = hexToRgb("#EEF3FA");

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Compute the five-swatch palette. Deterministic: the same input always yields
 * the same output, which is what lets the client pre-render while the network
 * response is in flight.
 */
export function computePalette(input: PaletteInput): Palette {
  const elevation = Number.isFinite(input.elevation) ? input.elevation : 0;
  const low = clamp01((input.cloudCoverLow ?? 15) / 100);
  const high = clamp01((input.cloudCoverHigh ?? 25) / 100);
  const mid = clamp01((input.cloudCoverMid ?? 10) / 100);
  const visibility = input.visibility ?? 20_000;
  const haze = clamp01((20_000 - visibility) / 20_000);

  // Clouds and haze reflect ambient light: at night an overcast layer is dark
  // grey, not the bright grey it is at noon. Interpolating the *target* colour
  // keeps the same coverage maths while staying physically plausible.
  const daylight = smoothstep(-14, 8, elevation);
  const overcast = mix(OVERCAST_NIGHT, OVERCAST_DAY, daylight);
  const hazeTarget = mix(HAZE_NIGHT, HAZE_DAY, daylight);

  const base = Object.fromEntries(CHANNELS.map((c) => [c, sampleChannel(c, elevation)])) as Record<Channel, Rgb>;

  // High cloud catches the low sun; low cloud flattens and greys the sky.
  // The warm window ramps smoothly so scrubbing never steps the cloud tint.
  const lowSunWindow = smoothstep(-11, -7, elevation) * (1 - smoothstep(7, 12, elevation));
  const warmAmount = lowSunWindow * high * 0.55;
  const coolAmount = high * 0.25 + mid * 0.15;

  const zenith = mix(mix(base.zenith, overcast, low * 0.35), overcast, haze * 0.1);
  const midsky = mix(base.midsky, overcast, low * 0.25 + haze * 0.2);
  const horizon = mix(base.horizon, hazeTarget, low * 0.45 + haze * 0.35);
  const sunglow = mix(mix(base.sunglow, overcast, low * 0.55), COOL_CLOUD, haze * 0.15);
  const cloudtint = mix(mix(base.cloudtint, WARM_CLOUD, warmAmount), COOL_CLOUD, coolAmount);

  const swatches: PaletteSwatches = {
    zenith: rgbToHex(zenith) as HexColor,
    midsky: rgbToHex(midsky) as HexColor,
    horizon: rgbToHex(horizon) as HexColor,
    sunglow: rgbToHex(sunglow) as HexColor,
    cloudtint: rgbToHex(cloudtint) as HexColor,
  };

  return {
    ...swatches,
    elevation: Math.round(elevation * 100) / 100,
    phase: phaseForElevation(elevation),
    gradientCss: `linear-gradient(180deg, ${swatches.zenith} 0%, ${swatches.midsky} 45%, ${swatches.horizon} 100%)`,
  };
}

/** Convenience for the server: palette straight from solar geometry. */
export function paletteCssVariables(palette: Palette): string {
  return [
    `--sky-zenith:${palette.zenith}`,
    `--sky-midsky:${palette.midsky}`,
    `--sky-horizon:${palette.horizon}`,
    `--sky-sunglow:${palette.sunglow}`,
    `--sky-cloudtint:${palette.cloudtint}`,
  ].join(";");
}

export { clamp };
