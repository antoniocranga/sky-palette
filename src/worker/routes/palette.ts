/** Authoritative palette for a point and instant. */

import { computePalette } from "../../shared/palette";
import { BUCHAREST, getSolarPosition, getSunTimes } from "../../shared/solar";
import { isoDayInZone } from "../../shared/time";
import type { PaletteResponse } from "../../shared/types";
import type { RouteHandler } from "../env";
import { isoInstant, jsonResponse, logEvent, numberParam, stringParam } from "../lib/http";
import { enforceEdgeRateLimit } from "../lib/rate-limit";
import { fetchWeatherAt } from "../lib/weather";

const DEFAULT_TIMEZONE = "UTC";

export const handlePalette: RouteHandler = async (request, env, ctx, context) => {
  const url = new URL(request.url);
  const lat = numberParam(url.searchParams.get("lat"), BUCHAREST.lat, -90, 90);
  const lon = numberParam(url.searchParams.get("lon"), BUCHAREST.lon, -180, 180);
  const timezone = stringParam(url.searchParams.get("tz"), DEFAULT_TIMEZONE, 64);
  const at = isoInstant(url.searchParams.get("at"), new Date());

  await enforceEdgeRateLimit(env.PALETTE_LIMITER, request, env, context);

  const [weatherResult, solar] = await Promise.all([
    fetchWeatherAt(lat, lon, at, (promise) => ctx.waitUntil(promise)),
    Promise.resolve(getSolarPosition(lat, lon, at)),
  ]);

  const palette = computePalette({
    elevation: solar.elevation,
    cloudCoverLow: weatherResult.weather.cloudCoverLow,
    cloudCoverMid: weatherResult.weather.cloudCoverMid,
    cloudCoverHigh: weatherResult.weather.cloudCoverHigh,
    visibility: weatherResult.weather.visibility,
  });

  const times = getSunTimes(lat, lon, at);
  const body: PaletteResponse = {
    success: true,
    location: { lat, lon, timezone },
    at: at.toISOString(),
    solar,
    weather: weatherResult.weather,
    palette,
    sunTimes: {
      sunrise: times.sunrise?.toISOString() ?? null,
      sunset: times.sunset?.toISOString() ?? null,
      goldenHourStart: times.goldenHourStart?.toISOString() ?? null,
      goldenHourEnd: times.goldenHourEnd?.toISOString() ?? null,
    },
    cached: false,
    requestId: context.requestId,
  };

  logEvent("info", "palette.computed", {
    requestId: context.requestId,
    cityKey: `${lat.toFixed(2)},${lon.toFixed(2)}`,
    day: isoDayInZone(at, timezone),
    elevation: solar.elevation,
    phase: palette.phase,
    degraded: weatherResult.degraded,
    durationMs: Date.now() - context.startedAt,
  });

  return jsonResponse(body, 200, {
    "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    "X-Weather-Source": weatherResult.degraded ? "fallback" : "open-meteo",
  });
};
