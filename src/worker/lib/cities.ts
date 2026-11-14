/**
 * City lookup.
 *
 * Autocomplete goes through the Open-Meteo geocoder (free, no key), is
 * normalised into the shared `City` contract, and is written back to D1 so the
 * same search keeps working when the upstream is unreachable.
 */

import type { City } from "../../shared/types";
import { logEvent } from "./http";

const GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const RESULT_LIMIT = 8;

interface GeocodingResult {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  country?: unknown;
  country_code?: unknown;
  admin1?: unknown;
  timezone?: unknown;
  population?: unknown;
}

interface GeocodingResponse {
  results?: GeocodingResult[];
}

interface CityRow {
  slug: string;
  name: string;
  country: string;
  country_code: string | null;
  admin1: string | null;
  lat: number;
  lon: number;
  timezone: string;
  population: number;
}

/** Lowercase ASCII slug: "Cluj-Napoca" -> "cluj-napoca". */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Escapes `%`, `_` and `\` for a LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface CitySearchResult {
  cities: City[];
  degraded: boolean;
}

export async function searchCities(query: string, env: { DB: D1Database }): Promise<CitySearchResult> {
  try {
    const upstream = await fetchGeocoder(query);
    const cities = await persistCities(upstream, env);
    return { cities, degraded: false };
  } catch (error) {
    logEvent("warn", "cities.upstream_failed", {
      query,
      message: error instanceof Error ? error.message : String(error),
    });
    const cities = await searchCitiesInDatabase(query, env);
    return { cities, degraded: true };
  }
}

async function fetchGeocoder(query: string): Promise<City[]> {
  const url = new URL(GEOCODING_ENDPOINT);
  url.searchParams.set("name", query);
  url.searchParams.set("count", String(RESULT_LIMIT));
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "SkyPalette/2.0 (+https://skypalette.app)" },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Geocoder ${response.status}`);

  const payload = (await response.json()) as GeocodingResponse;
  const results = Array.isArray(payload.results) ? payload.results : [];

  const cities: City[] = [];
  for (const result of results) {
    const name = asString(result.name);
    const lat = asNumber(result.latitude);
    const lon = asNumber(result.longitude);
    if (!name || lat === null || lon === null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const country = asString(result.country) ?? "Unknown";
    const timezone = asString(result.timezone) ?? "UTC";
    cities.push({
      slug: "", // assigned in persistCities once collisions are known
      name,
      country,
      countryCode: asString(result.country_code),
      admin1: asString(result.admin1),
      lat: roundCoord(lat),
      lon: roundCoord(lon),
      timezone,
      population: Math.max(0, Math.round(asNumber(result.population) ?? 0)),
    });
    if (cities.length >= RESULT_LIMIT) break;
  }

  return cities;
}

/**
 * Writes resolved cities to D1 and assigns a stable, collision-free slug.
 * A slug is `name-country`, disambiguated with admin1 and then a counter when a
 * different place already owns the slug.
 */
async function persistCities(cities: City[], env: { DB: D1Database }): Promise<City[]> {
  if (cities.length === 0) return cities;

  const candidateMap = new Map<number, string[]>();
  const allCandidates = new Set<string>();
  cities.forEach((city, index) => {
    const candidates = slugCandidates(city);
    candidateMap.set(index, candidates);
    for (const candidate of candidates) allCandidates.add(candidate);
  });

  const placeholders = [...allCandidates].map(() => "?").join(",");
  const existing = await env.DB.prepare(
    `SELECT slug, lat, lon FROM cities WHERE slug IN (${placeholders})`,
  )
    .bind(...allCandidates)
    .all<{ slug: string; lat: number; lon: number }>();

  const owners = new Map<string, { lat: number; lon: number }>();
  for (const row of existing.results ?? []) {
    owners.set(row.slug, { lat: row.lat, lon: row.lon });
  }

  const claimed = new Set<string>();
  const assigned: City[] = [];

  cities.forEach((city, index) => {
    const candidates = candidateMap.get(index) ?? slugCandidates(city);
    let slug = candidates[0] ?? `place-${index}`;
    for (const candidate of candidates) {
      if (claimed.has(candidate)) continue;
      const owner = owners.get(candidate);
      if (!owner || samePlace(owner, city)) {
        slug = candidate;
        break;
      }
    }
    claimed.add(slug);
    assigned.push({ ...city, slug });
  });

  const updatedAt = new Date().toISOString();
  const statements = assigned.map((city) =>
    env.DB.prepare(
      `INSERT INTO cities (slug, name, country, country_code, admin1, lat, lon, timezone, population, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         country = excluded.country,
         country_code = excluded.country_code,
         admin1 = excluded.admin1,
         lat = excluded.lat,
         lon = excluded.lon,
         timezone = excluded.timezone,
         population = excluded.population,
         updated_at = excluded.updated_at`,
    ).bind(
      city.slug,
      city.name,
      city.country,
      city.countryCode,
      city.admin1,
      city.lat,
      city.lon,
      city.timezone,
      city.population,
      updatedAt,
    ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A failed cache write must not fail the search response.
    logEvent("warn", "cities.persist_failed", {
      message: error instanceof Error ? error.message : String(error),
      count: statements.length,
    });
  }

  return assigned;
}

function slugCandidates(city: City): string[] {
  const name = slugify(city.name) || "place";
  const country = slugify(city.country) || slugify(city.countryCode ?? "") || "world";
  const base = `${name}-${country}`;
  const admin = city.admin1 ? slugify(city.admin1) : "";
  const withAdmin = admin && admin !== name ? `${base}-${admin}` : base;

  const candidates = [base];
  if (withAdmin !== base) candidates.push(withAdmin);
  for (let suffix = 2; suffix <= 9; suffix += 1) {
    candidates.push(`${withAdmin}-${suffix}`);
  }
  return candidates;
}

function samePlace(owner: { lat: number; lon: number }, city: City): boolean {
  return Math.abs(owner.lat - city.lat) < 0.05 && Math.abs(owner.lon - city.lon) < 0.05;
}

async function searchCitiesInDatabase(query: string, env: { DB: D1Database }): Promise<City[]> {
  try {
    const pattern = `${escapeLike(query)}%`;
    const { results } = await env.DB.prepare(
      `SELECT slug, name, country, country_code, admin1, lat, lon, timezone, population
         FROM cities
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY population DESC
        LIMIT ?`,
    )
      .bind(pattern, RESULT_LIMIT)
      .all<CityRow>();

    return (results ?? []).map(rowToCity);
  } catch (error) {
    logEvent("error", "cities.fallback_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function rowToCity(row: CityRow): City {
  return {
    slug: row.slug,
    name: row.name,
    country: row.country,
    countryCode: row.country_code,
    admin1: row.admin1,
    lat: row.lat,
    lon: row.lon,
    timezone: row.timezone,
    population: row.population,
  };
}
