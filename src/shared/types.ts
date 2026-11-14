/** Contract types shared by the Worker API and the browser client. */

export type HexColor = `#${string}`;

export interface PaletteSwatches {
  zenith: HexColor;
  midsky: HexColor;
  horizon: HexColor;
  sunglow: HexColor;
  cloudtint: HexColor;
}

export interface Palette extends PaletteSwatches {
  elevation: number;
  phase: string;
  gradientCss: string;
}

export interface WeatherSnapshot {
  /** ISO timestamp of the hourly sample used. */
  time: string;
  cloudCoverLow: number;
  cloudCoverMid: number;
  cloudCoverHigh: number;
  /** Metres. */
  visibility: number;
  weatherCode: number;
}

export interface City {
  slug: string;
  name: string;
  country: string;
  countryCode: string | null;
  admin1: string | null;
  lat: number;
  lon: number;
  timezone: string;
  population: number;
}

export interface DayPalette {
  /** YYYY-MM-DD in the city's timezone. */
  date: string;
  /** Local sunset HH:MM, or null during polar day/night. */
  sunset: string | null;
  phase: string;
  colors: [HexColor, HexColor, HexColor, HexColor, HexColor];
  weatherCode: number;
}

export interface PaletteResponse {
  success: true;
  location: { lat: number; lon: number; timezone: string };
  at: string;
  solar: { elevation: number; azimuth: number; zenith: number };
  weather: WeatherSnapshot;
  palette: Palette;
  sunTimes: { sunrise: string | null; sunset: string | null; goldenHourStart: string | null; goldenHourEnd: string | null };
  cached: boolean;
  requestId: string;
}

export interface HistoryResponse {
  success: true;
  location: { lat: number; lon: number };
  days: DayPalette[];
  cached: boolean;
}

export interface CitiesResponse {
  success: true;
  results: City[];
}

export interface SubmissionResponse {
  success: true;
  submissionId: string;
  handle: string;
  status: "pending";
  url: string | null;
}

export interface GalleryPhoto {
  id: string;
  handle: string;
  /** Absolute URL of the streamed photo (`/api/photos/...`). */
  url: string;
  /** Smaller variant for grid tiles; equals `url` when no variant exists. */
  thumbUrl: string;
  capturedAt: string;
  palette: Palette;
  width: number;
  height: number;
}

export interface GalleryResponse {
  success: true;
  photos: GalleryPhoto[];
}

export interface ConfigResponse {
  success: true;
  turnstileSiteKey: string | null;
  appUrl: string;
  version: string;
}

export interface ApiFailure {
  success: false;
  error: string;
  requestId: string;
}

export const SWATCH_LABELS = ["zenith", "midsky", "horizon", "sunglow", "cloudtint"] as const;
export type SwatchName = (typeof SWATCH_LABELS)[number];

export function swatchesToArray(swatches: PaletteSwatches): [HexColor, HexColor, HexColor, HexColor, HexColor] {
  return [swatches.zenith, swatches.midsky, swatches.horizon, swatches.sunglow, swatches.cloudtint];
}
