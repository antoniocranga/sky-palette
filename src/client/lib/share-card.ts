/**
 * Pure share-card geometry and copy. Kept out of the canvas module so the
 * story layout can be unit tested in Node without a DOM.
 */

import type { Palette } from "../../shared/types";
import { formatCoordinates, formatDateUpper, formatDegrees, formatElevation } from "./format";

export const CARD_SIZE = { width: 1080, height: 1350 } as const;
export const STORY_SIZE = { width: 1080, height: 1920 } as const;

/**
 * Story layout in canvas pixels. `margin` is the outer content gutter and
 * `safeMargin` the minimum clearance expected by every social crop. All text
 * is drawn inside `contentTop…contentBottom`, i.e. never in the outer 120 px.
 */
export const STORY_LAYOUT = {
  width: STORY_SIZE.width,
  height: STORY_SIZE.height,
  margin: 120,
  safeMargin: 96,
  contentTop: 180,
  contentBottom: 1740,
  swatchTop: 450,
  swatchHeight: 690,
  hexBaseline: 1200,
  panelTop: 1260,
  panelHeight: 320,
  footerRule: 1630,
  footerBaseline: 1700,
} as const;

export const SHARE_HANDLE = "@skypalette";
export const SHARE_SITE = "skypalette.app";

/** `sky-palette-<slug>-<day>.png`, with `-story` for the 9:16 card. */
export function sharePngFilename(kind: "card" | "story", slug: string, dateIso: string): string {
  const suffix = kind === "story" ? "-story" : "";
  return `sky-palette-${slug}-${dateIso}${suffix}.png`;
}

export interface StorySource {
  city: {
    name: string;
    country: string;
    lat: number;
    lon: number;
  };
  palette: Palette;
  dateIso: string;
  timeLabel: string;
  phase: string;
  elevation: number;
  azimuth: number;
  cloudLabel: string;
}

export interface StoryContent {
  eyebrow: string;
  city: string;
  coords: string;
  date: string;
  time: string;
  phase: string;
  metrics: Array<{ label: string; value: string }>;
  colors: string[];
  hexes: string[];
  handle: string;
  site: string;
}

/** The exact strings the story card draws, in draw order. */
export function storyContent(source: StorySource): StoryContent {
  const colors = [
    source.palette.zenith,
    source.palette.midsky,
    source.palette.horizon,
    source.palette.sunglow,
    source.palette.cloudtint,
  ];
  return {
    eyebrow: "SKY PALETTE",
    city: source.city.name.toUpperCase(),
    coords: `${formatCoordinates(source.city.lat, source.city.lon)} · ${source.city.country.toUpperCase()}`,
    date: formatDateUpper(source.dateIso),
    time: source.timeLabel,
    phase: source.phase,
    metrics: [
      { label: "SOLAR ELEVATION", value: formatElevation(source.elevation) },
      { label: "AZIMUTH", value: formatDegrees(source.azimuth) },
      { label: "CLOUD COVER", value: source.cloudLabel },
      { label: "PHASE", value: source.phase },
    ],
    colors,
    hexes: colors.map((color) => color.toUpperCase()),
    handle: SHARE_HANDLE,
    site: SHARE_SITE,
  };
}

/** True when every text baseline sits inside the story's safe area. */
export function storyTextInsideSafeArea(): boolean {
  const { height, margin, safeMargin, contentTop, contentBottom } = STORY_LAYOUT;
  return margin >= safeMargin && contentTop >= safeMargin && contentBottom <= height - safeMargin;
}
