/**
 * Open-Meteo client. Forecast and archive endpoints are free for non-commercial
 * use (CC BY 4.0). Requests are edge-cached so one city-hour is fetched once.
 */

import type { WeatherSnapshot } from "../../shared/types";
import { addDays } from "../../shared/time";
import { logEvent } from "./http";

export interface WeatherResult {
  weather: WeatherSnapshot;
  degraded: boolean;
}

const CACHE_TTL_SECONDS = 3600;

/** Open-Meteo's archive lags a few days behind; newer dates use the forecast. */
const ARCHIVE_LAG_DAYS = 6;

const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive";

const HOURLY_FIELDS = [
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "visibility",
  "weather_code",
].join(",");

/** One hourly sample keyed by its UTC instant. */
export interface HourlySample extends WeatherSnapshot {
  /** Epoch milliseconds of the sample. */
  timestamp: number;
}

export interface HourlyRangeResult {
  samples: HourlySample[];
  degraded: boolean;
}

interface OpenMeteoHourly {
  time?: string[];
  cloud_cover_low?: number[];
  cloud_cover_mid?: number[];
  cloud_cover_high?: number[];
  visibility?: number[];
  weather_code?: number[];
}

interface OpenMeteoResponse {
  hourly?: OpenMeteoHourly;
}

/** Calm clear-sky baseline used when the upstream is unavailable. */
export const FALLBACK_WEATHER: Omit<WeatherSnapshot, "time"> = {
  cloudCoverLow: 15,
  cloudCoverMid: 10,
  cloudCoverHigh: 25,
  visibility: 20_000,
  weatherCode: 0,
};

export async function fetchWeatherAt(
  lat: number,
  lon: number,
  at: Date,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<WeatherResult> {
  const hourKey = `${lat.toFixed(2)},${lon.toFixed(2)},${new Date(at).toISOString().slice(0, 13)}`;
  const cacheUrl = `https://sky-palette.internal/weather?key=${encodeURIComponent(hourKey)}`;
  const cache = typeof caches !== "undefined" ? caches.default : null;

  if (cache) {
    const hit = await cache.match(cacheUrl);
    if (hit) {
      return { weather: (await hit.json()) as WeatherSnapshot, degraded: false };
    }
  }

  try {
    const url = buildUrl(lat, lon, at);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "SkyPalette/2.0 (+https://skypalette.app)",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);

    const data = (await response.json()) as OpenMeteoResponse;
    const weather = pickHour(data.hourly, at);
    if (!weather) throw new Error("Open-Meteo returned no hourly sample");

    if (cache) {
      waitUntil(
        cache.put(
          cacheUrl,
          new Response(JSON.stringify(weather), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
            },
          }),
        ),
      );
    }
    return { weather, degraded: false };
  } catch (error) {
    logEvent("warn", "weather.upstream_failed", {
      message: error instanceof Error ? error.message : String(error),
      lat,
      lon,
    });
    return {
      weather: { ...FALLBACK_WEATHER, time: new Date(at).toISOString() },
      degraded: true,
    };
  }
}

/**
 * Hourly samples across a date range (inclusive, YYYY-MM-DD in UTC).
 *
 * Each endpoint is called once for its whole share of the range: the archive
 * for days older than its lag, the forecast for the rest. A 30-day request
 * therefore costs at most two upstream calls. Partial failure is tolerated —
 * the caller falls back to clear-sky defaults for dates with no sample.
 */
export async function fetchHourlyRange(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<HourlyRangeResult> {
  if (startDate > endDate) return { samples: [], degraded: false };

  const today = new Date().toISOString().slice(0, 10);
  const archiveCutoff = addDays(today, -ARCHIVE_LAG_DAYS);
  const archiveEnd = endDate < archiveCutoff ? endDate : archiveCutoff;
  const forecastStart = addDays(archiveCutoff, 1);

  const requests: Array<Promise<HourlySample[]>> = [];
  if (startDate <= archiveEnd) {
    requests.push(requestRange(ARCHIVE_ENDPOINT, lat, lon, startDate, archiveEnd));
  }
  if (forecastStart <= endDate) {
    const start = startDate > forecastStart ? startDate : forecastStart;
    requests.push(requestRange(FORECAST_ENDPOINT, lat, lon, start, endDate));
  }

  const settled = await Promise.allSettled(requests);
  const samples: HourlySample[] = [];
  let degraded = false;

  for (const result of settled) {
    if (result.status === "fulfilled") {
      samples.push(...result.value);
    } else {
      degraded = true;
      logEvent("warn", "weather.range_failed", {
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        lat,
        lon,
      });
    }
  }

  samples.sort((a, b) => a.timestamp - b.timestamp);
  return { samples: dedupeSamples(samples), degraded };
}

async function requestRange(
  endpoint: string,
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<HourlySample[]> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: HOURLY_FIELDS,
    timezone: "UTC",
    start_date: startDate,
    end_date: endDate,
  });

  const response = await fetch(`${endpoint}?${params.toString()}`, {
    headers: { "User-Agent": "SkyPalette/2.0 (+https://skypalette.app)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);

  const data = (await response.json()) as OpenMeteoResponse;
  return toSamples(data.hourly);
}

function toSamples(hourly: OpenMeteoHourly | undefined): HourlySample[] {
  const times = hourly?.time;
  if (!times || times.length === 0) return [];

  const samples: HourlySample[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const stamp = parseSampleTime(times[index] ?? "");
    if (stamp === null) continue;
    samples.push({
      timestamp: stamp,
      time: new Date(stamp).toISOString(),
      cloudCoverLow: hourly?.cloud_cover_low?.[index] ?? FALLBACK_WEATHER.cloudCoverLow,
      cloudCoverMid: hourly?.cloud_cover_mid?.[index] ?? FALLBACK_WEATHER.cloudCoverMid,
      cloudCoverHigh: hourly?.cloud_cover_high?.[index] ?? FALLBACK_WEATHER.cloudCoverHigh,
      visibility: hourly?.visibility?.[index] ?? FALLBACK_WEATHER.visibility,
      weatherCode: hourly?.weather_code?.[index] ?? FALLBACK_WEATHER.weatherCode,
    });
  }
  return samples;
}

/** Open-Meteo returns "2026-11-14T00:00" when timezone=UTC. */
function parseSampleTime(value: string): number | null {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}${normalized.length === 16 ? ":00Z" : "Z"}`;
  const parsed = Date.parse(zoned);
  return Number.isNaN(parsed) ? null : parsed;
}

function dedupeSamples(samples: HourlySample[]): HourlySample[] {
  const out: HourlySample[] = [];
  for (const sample of samples) {
    const previous = out[out.length - 1];
    if (previous && previous.timestamp === sample.timestamp) continue;
    out.push(sample);
  }
  return out;
}

/** Nearest hourly sample to an instant, using a binary search on time. */
export function findNearestSample(samples: HourlySample[], instant: Date): HourlySample | null {
  if (samples.length === 0) return null;
  const target = instant.getTime();

  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const sample = samples[middle];
    if (sample && sample.timestamp < target) low = middle + 1;
    else high = middle;
  }

  const after = samples[low];
  const before = samples[Math.max(0, low - 1)];
  if (!after) return before ?? null;
  if (!before) return after;
  return Math.abs(after.timestamp - target) < Math.abs(before.timestamp - target) ? after : before;
}

function buildUrl(lat: number, lon: number, at: Date): string {
  const ageDays = (Date.now() - at.getTime()) / 86_400_000;
  const isArchive = ageDays > 5;
  const host = isArchive ? ARCHIVE_ENDPOINT : FORECAST_ENDPOINT;
  const date = at.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: HOURLY_FIELDS,
    timezone: "UTC",
    start_date: date,
    end_date: date,
  });
  return `${host}?${params.toString()}`;
}

function pickHour(hourly: OpenMeteoHourly | undefined, at: Date): WeatherSnapshot | null {
  const times = hourly?.time;
  if (!times || times.length === 0) return null;

  const target = at.getTime();
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times.length; i += 1) {
    const stamp = Date.parse(`${times[i]}:00Z`);
    const distance = Math.abs(stamp - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return {
    time: `${times[bestIndex]}:00Z`,
    cloudCoverLow: hourly?.cloud_cover_low?.[bestIndex] ?? FALLBACK_WEATHER.cloudCoverLow,
    cloudCoverMid: hourly?.cloud_cover_mid?.[bestIndex] ?? FALLBACK_WEATHER.cloudCoverMid,
    cloudCoverHigh: hourly?.cloud_cover_high?.[bestIndex] ?? FALLBACK_WEATHER.cloudCoverHigh,
    visibility: hourly?.visibility?.[bestIndex] ?? FALLBACK_WEATHER.visibility,
    weatherCode: hourly?.weather_code?.[bestIndex] ?? FALLBACK_WEATHER.weatherCode,
  };
}
