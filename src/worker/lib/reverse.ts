/**
 * Reverse geocoding for photo GPS.
 *
 * The `cities` table only knows places that were searched before, so a point in
 * Constanța could otherwise resolve to a cached village 18 km inland. This asks
 * OpenStreetMap Nominatim for the place name at the coordinate, then resolves
 * that name through the Open-Meteo geocoder so the result carries the same
 * timezone and population fields as an autocomplete result.
 *
 * Every answer is cached in D1 by a ~1 km grid cell, which keeps upstream calls
 * to a trickle and makes repeat uploads work offline.
 */

import type { City } from "../../shared/types";
import { findCityNear } from "./cities";
import { logEvent } from "./http";

const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "SkyPalette/1.0 (+https://skypalette.app)";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface NominatimAddress {
  city?: unknown;
  town?: unknown;
  village?: unknown;
  municipality?: unknown;
  county?: unknown;
  country_code?: unknown;
}

interface NominatimResponse {
  name?: unknown;
  address?: NominatimAddress;
}

interface CacheRow {
  payload: string;
  created_at: string;
}

export interface ReverseOptions {
  /** Lets tests and logs see whether the network was touched. */
  now?: () => number;
}

function cacheKey(value: number): number {
  return Math.round(value * 100) / 100;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The settlement name, preferring the smallest administrative unit. */
function placeName(payload: NominatimResponse): string | null {
  const address = payload.address ?? {};
  return (
    asText(address.city) ??
    asText(address.town) ??
    asText(address.village) ??
    asText(address.municipality) ??
    asText(payload.name) ??
    asText(address.county)
  );
}

async function readCache(db: D1Database, lat: number, lon: number, now: number): Promise<City | null> {
  try {
    const row = await db
      .prepare("SELECT payload, created_at FROM geo_cache WHERE lat_key = ? AND lon_key = ?")
      .bind(cacheKey(lat), cacheKey(lon))
      .first<CacheRow>();
    if (!row) return null;
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || now - created > CACHE_TTL_MS) return null;
    const city = JSON.parse(row.payload) as City;
    if (typeof city?.name !== "string" || typeof city?.timezone !== "string") return null;
    return city;
  } catch (error) {
    logEvent("warn", "location.cache_read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function writeCache(db: D1Database, lat: number, lon: number, city: City, now: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO geo_cache (lat_key, lon_key, payload, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(lat_key, lon_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
      )
      .bind(cacheKey(lat), cacheKey(lon), JSON.stringify(city), new Date(now).toISOString())
      .run();
  } catch (error) {
    // The answer is still correct without a cache write.
    logEvent("warn", "location.cache_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function lookupPlace(lat: number, lon: number): Promise<{ name: string; countryCode: string | null } | null> {
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", lat.toFixed(6));
  url.searchParams.set("lon", lon.toFixed(6));
  url.searchParams.set("zoom", "10");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "en");

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);

  const payload = (await response.json()) as NominatimResponse;
  const name = placeName(payload);
  if (!name) return null;
  return { name, countryCode: asText(payload.address?.country_code)?.toLowerCase() ?? null };
}

/**
 * Resolve a coordinate to a full `City`, or null when no place can be named.
 * Never throws: the caller decides whether to fall back to a cached city.
 */
export async function reverseCity(
  lat: number,
  lon: number,
  env: { DB: D1Database },
  options: ReverseOptions = {},
): Promise<City | null> {
  const now = (options.now ?? Date.now)();

  const cached = await readCache(env.DB, lat, lon, now);
  if (cached) return cached;

  try {
    const place = await lookupPlace(lat, lon);
    if (!place) return null;
    const city = await findCityNear(place.name, place.countryCode, lat, lon, env);
    if (!city) return null;
    await writeCache(env.DB, lat, lon, city, now);
    logEvent("info", "location.reverse", {
      name: city.name,
      lat: Number(city.lat.toFixed(2)),
      lon: Number(city.lon.toFixed(2)),
    });
    return city;
  } catch (error) {
    logEvent("warn", "location.reverse_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Daily cron: drop cache cells nobody asked about for a month. */
export async function pruneGeoCache(db: D1Database, now = Date.now()): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM geo_cache WHERE created_at < ?")
      .bind(new Date(now - CACHE_TTL_MS).toISOString())
      .run();
  } catch (error) {
    logEvent("warn", "location.cache_prune_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
