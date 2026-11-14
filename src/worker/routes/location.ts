/**
 * Nearest-city lookup for photo GPS.
 *
 * The browser reads the photo's EXIF GPS locally (the bytes never leave the
 * device before the upload pipeline strips them), then asks this endpoint for a
 * human-readable place. To keep the zero-third-party-request rule, the lookup
 * only uses the `cities` table already populated by autocomplete; there is no
 * external reverse-geocoding call. When nothing is close enough the client
 * falls back to a formatted coordinate pair.
 */

import type { City } from "../../shared/types";
import type { RouteHandler } from "../env";
import { jsonResponse, logEvent, numberParam } from "../lib/http";
import { enforceEdgeRateLimit } from "../lib/rate-limit";

/** Search radius. Beyond this a coordinate label is more honest than a city. */
const RADIUS_KM = 100;
const EARTH_RADIUS_KM = 6371;

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

export const handleLocation: RouteHandler = async (request, env, ctx, context) => {
  await enforceEdgeRateLimit(env.CITIES_LIMITER, request, env, context, "location");

  const url = new URL(request.url);
  const lat = numberParam(url.searchParams.get("lat"), Number.NaN, -90, 90);
  const lon = numberParam(url.searchParams.get("lon"), Number.NaN, -180, 180);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ success: true, match: null, reason: "missing_coordinates" }, 200, {
      "Cache-Control": "no-store",
    });
  }

  const latDelta = RADIUS_KM / 111;
  const lonDelta = RADIUS_KM / Math.max(1, Math.abs(Math.cos((lat * Math.PI) / 180)) * 111);

  let rows: CityRow[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT slug, name, country, country_code, admin1, lat, lon, timezone, population
       FROM cities
       WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
       LIMIT 200`,
    )
      .bind(lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta)
      .all<CityRow>();
    rows = result.results ?? [];
  } catch (error) {
    logEvent("error", "location.lookup_failed", {
      requestId: context.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ success: true, match: null, reason: "unavailable" }, 200, {
      "Cache-Control": "no-store",
    });
  }

  let best: { city: CityRow; distanceKm: number } | null = null;
  for (const row of rows) {
    const distanceKm = haversine(lat, lon, row.lat, row.lon);
    if (distanceKm <= RADIUS_KM && (!best || distanceKm < best.distanceKm)) {
      best = { city: row, distanceKm };
    }
  }

  const body = {
    success: true as const,
    match: best
      ? {
          city: toCity(best.city),
          distanceKm: Math.round(best.distanceKm * 10) / 10,
        }
      : null,
  };

  logEvent("info", "location.resolved", {
    requestId: context.requestId,
    matched: Boolean(best),
    candidates: rows.length,
  });

  return jsonResponse(body, 200, { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" });
};

function toCity(row: CityRow): City {
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

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
