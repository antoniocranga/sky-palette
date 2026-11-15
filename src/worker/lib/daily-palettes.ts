/**
 * Daily sunset palettes: the history endpoint's storage layer.
 *
 * One palette per city-day, computed at the local sunset instant from the
 * hourly sample nearest to it. Rows are cached in D1 (`daily_palettes`) so a
 * repeat visit costs one indexed read instead of an upstream call, and a
 * partially warm range only fetches the missing dates.
 */

import { computePalette } from "../../shared/palette";
import { getSolarPosition, getSunTimes } from "../../shared/solar";
import { addDays, clockInZone, isoDayInZone, zonedTimeToUtc } from "../../shared/time";
import { swatchesToArray, type DayPalette, type HexColor } from "../../shared/types";
import { logEvent } from "./http";
import { FALLBACK_WEATHER, fetchHourlyRange, findNearestSample, type HourlySample } from "./weather";

/** Today's row is recomputed after this age in case the forecast changed. */
const TODAY_FRESH_MS = 2 * 3_600_000;

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

interface CachedRow {
  date: string;
  phase: string;
  swatches_json: string;
  weather_code: number;
  computed_at: string;
}

export interface DailyPaletteResult {
  days: DayPalette[];
  /** True when every day was served from D1 without touching the upstream. */
  cached: boolean;
  degraded: boolean;
}

export interface DailyPaletteQuery {
  lat: number;
  lon: number;
  days: number;
  timezone: string;
  db: D1Database;
}

export async function getDailyPalettes(query: DailyPaletteQuery): Promise<DailyPaletteResult> {
  const { lat, lon, days, timezone, db } = query;
  const today = isoDayInZone(new Date(), timezone);

  const dates: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    dates.push(addDays(today, -back));
  }

  const cityKey = cityKeyFor(lat, lon);
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) return { days: [], cached: true, degraded: false };

  const rows = await readCache(db, cityKey, first, last);
  const cachedByDate = new Map<string, DayPalette>();
  for (const row of rows) {
    const day = rowToDayPalette(row, lat, lon, timezone, today);
    if (day) cachedByDate.set(day.date, day);
  }

  const missing = dates.filter((date) => !cachedByDate.has(date));
  let degraded = false;

  if (missing.length > 0) {
    const rangeStart = missing[0];
    const rangeEnd = missing[missing.length - 1];
    if (rangeStart !== undefined && rangeEnd !== undefined) {
      const range = await fetchHourlyRange(lat, lon, rangeStart, rangeEnd);
      degraded = range.degraded;

      const fresh: Array<{ day: DayPalette; row: CachedRow | null }> = [];
      for (const date of missing) {
        const { day, sample } = computeDay(lat, lon, date, timezone, range.samples);
        fresh.push({
          day,
          row: sample ? dayToRow(day) : null,
        });
      }

      for (const entry of fresh) cachedByDate.set(entry.day.date, entry.day);

      // A day without a nearby hourly sample is served from clear-sky defaults
      // and is neither trustworthy nor cached.
      if (fresh.some((entry) => entry.row === null)) degraded = true;

      const writable = fresh.flatMap((entry) => (entry.row ? [entry.row] : []));
      if (writable.length > 0) await writeCache(db, cityKey, writable);
    }
  }

  const ordered: DayPalette[] = [];
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const date = dates[index];
    if (date === undefined) continue;
    const day = cachedByDate.get(date);
    if (day) ordered.push(day);
  }

  return { days: ordered, cached: missing.length === 0, degraded };
}

function cityKeyFor(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

/**
 * The UTC instant of sunset for a local calendar date. `getSunTimes` works on
 * the UTC day containing its argument, so the neighbouring day is checked when
 * the zone offset pushes sunset across midnight UTC.
 */
export function localSunset(lat: number, lon: number, date: string, timezone: string): Date | null {
  for (const offset of [0, -1, 1]) {
    const anchor = new Date(`${addDays(date, offset)}T12:00:00Z`);
    const sunset = getSunTimes(lat, lon, anchor).sunset;
    if (sunset && isoDayInZone(sunset, timezone) === date) return sunset;
  }
  return null;
}

/** Hourly samples further than this from the target are treated as missing. */
const SAMPLE_TOLERANCE_MS = 3 * 3_600_000;

function computeDay(
  lat: number,
  lon: number,
  date: string,
  timezone: string,
  samples: HourlySample[],
): { day: DayPalette; sample: HourlySample | null } {
  const sunset = localSunset(lat, lon, date, timezone);
  const reference = sunset ?? zonedTimeToUtc(date, "12:00", timezone);
  const nearest = findNearestSample(samples, reference);
  const sample =
    nearest && Math.abs(nearest.timestamp - reference.getTime()) <= SAMPLE_TOLERANCE_MS ? nearest : null;

  const elevation = getSolarPosition(lat, lon, reference).elevation;
  const palette = computePalette({
    elevation,
    cloudCoverLow: sample?.cloudCoverLow ?? FALLBACK_WEATHER.cloudCoverLow,
    cloudCoverMid: sample?.cloudCoverMid ?? FALLBACK_WEATHER.cloudCoverMid,
    cloudCoverHigh: sample?.cloudCoverHigh ?? FALLBACK_WEATHER.cloudCoverHigh,
    visibility: sample?.visibility ?? FALLBACK_WEATHER.visibility,
  });

  return {
    day: {
      date,
      sunset: sunset ? clockInZone(sunset, timezone) : null,
      phase: palette.phase,
      colors: swatchesToArray(palette),
      weatherCode: sample?.weatherCode ?? FALLBACK_WEATHER.weatherCode,
    },
    sample,
  };
}

async function readCache(db: D1Database, cityKey: string, startDate: string, endDate: string): Promise<CachedRow[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT date, phase, swatches_json, weather_code, computed_at
           FROM daily_palettes
          WHERE city_key = ? AND date >= ? AND date <= ?`,
      )
      .bind(cityKey, startDate, endDate)
      .all<CachedRow>();
    return results ?? [];
  } catch (error) {
    logEvent("warn", "history.cache_read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function writeCache(db: D1Database, cityKey: string, rows: CachedRow[]): Promise<void> {
  try {
    await db.batch(
      rows.map((row) =>
        db
          .prepare(
            `INSERT INTO daily_palettes (city_key, date, phase, swatches_json, weather_code, computed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(city_key, date) DO UPDATE SET
               phase = excluded.phase,
               swatches_json = excluded.swatches_json,
               weather_code = excluded.weather_code,
               computed_at = excluded.computed_at`,
          )
          .bind(cityKey, row.date, row.phase, row.swatches_json, row.weather_code, row.computed_at),
      ),
    );
  } catch (error) {
    logEvent("warn", "history.cache_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function dayToRow(day: DayPalette): CachedRow {
  return {
    date: day.date,
    phase: day.phase,
    swatches_json: JSON.stringify(day.colors),
    weather_code: day.weatherCode,
    computed_at: new Date().toISOString(),
  };
}

function rowToDayPalette(
  row: CachedRow,
  lat: number,
  lon: number,
  timezone: string,
  today: string,
): DayPalette | null {
  if (row.date === today) {
    const computedAt = Date.parse(row.computed_at);
    if (Number.isFinite(computedAt) && Date.now() - computedAt > TODAY_FRESH_MS) return null;
  }

  const colors = parseColors(row.swatches_json);
  if (!colors) return null;

  const sunset = localSunset(lat, lon, row.date, timezone);
  return {
    date: row.date,
    sunset: sunset ? clockInZone(sunset, timezone) : null,
    phase: row.phase,
    colors,
    weatherCode: row.weather_code,
  };
}

function parseColors(value: string): DayPalette["colors"] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) return null;
  const colors = parsed.filter((entry): entry is string => typeof entry === "string" && HEX_PATTERN.test(entry));
  if (colors.length !== 5) return null;
  return colors as [HexColor, HexColor, HexColor, HexColor, HexColor];
}
