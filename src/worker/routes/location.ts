/**
 * Nearest-city lookup for photo GPS.
 *
 * The browser reads the photo's EXIF GPS locally (the bytes never leave the
 * device before the upload pipeline strips them), then asks this endpoint for a
 * human-readable place.
 *
 * Two tiers keep the answer honest:
 *   1. A cached city within `NEAR_KM` is good enough and costs no network.
 *   2. Otherwise the coordinate is reverse geocoded (cached in D1) and the
 *      resulting name is resolved to a full city row. The `cities` table only
 *      holds places someone searched before, so it is never trusted for a
 *      distant match — that is how a point in Constanța used to resolve to a
 *      village 18 km inland.
 */

import type { City } from "../../shared/types";
import type { RouteHandler } from "../env";
import { jsonResponse, logEvent, numberParam } from "../lib/http";
import { enforceEdgeRateLimit } from "../lib/rate-limit";
import { reverseCity } from "../lib/reverse";

/** A cached city this close needs no second opinion. */
const NEAR_KM = 3;
/** Last-resort radius when the reverse geocoder is unavailable. */
const FALLBACK_KM = 15;
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

interface Match {
  city: City;
  distanceKm: number;
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

  const latDelta = FALLBACK_KM / 111;
  const lonDelta = FALLBACK_KM / Math.max(1, Math.abs(Math.cos((lat * Math.PI) / 180)) * 111);

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

  let nearest: Match | null = null;
  for (const row of rows) {
    const distanceKm = haversine(lat, lon, row.lat, row.lon);
    if (distanceKm <= FALLBACK_KM && (!nearest || distanceKm < nearest.distanceKm)) {
      nearest = { city: toCity(row), distanceKm };
    }
  }

  let match = nearest && nearest.distanceKm <= NEAR_KM ? nearest : null;
  let source: "cache" | "reverse" | "fallback" | "none" = match ? "cache" : "none";

  if (!match) {
    const reversed = await reverseCity(lat, lon, env);
    if (reversed) {
      match = { city: reversed, distanceKm: haversine(lat, lon, reversed.lat, reversed.lon) };
      source = "reverse";
    } else if (nearest) {
      match = nearest;
      source = "fallback";
    }
  }

  logEvent("info", "location.resolved", {
    requestId: context.requestId,
    matched: Boolean(match),
    source,
    candidates: rows.length,
  });

  return jsonResponse(
    {
      success: true as const,
      match: match
        ? {
            city: match.city,
            distanceKm: Math.round(match.distanceKm * 10) / 10,
          }
        : null,
    },
    200,
    { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  );
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
