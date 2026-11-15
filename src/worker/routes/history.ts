/** Sunset palette history for a point. */

import { BUCHAREST } from "../../shared/solar";
import { isValidTimeZone } from "../../shared/time";
import type { HistoryResponse } from "../../shared/types";
import type { RouteHandler } from "../env";
import { getDailyPalettes } from "../lib/daily-palettes";
import { HttpError, intParam, jsonResponse, logEvent, numberParam } from "../lib/http";
import { enforceEdgeRateLimit } from "../lib/rate-limit";

const DEFAULT_DAYS = 15;
const MAX_DAYS = 30;
const DEFAULT_TIMEZONE = "UTC";

export const handleHistory: RouteHandler = async (request, env, _ctx, context) => {
  const url = new URL(request.url);
  const lat = numberParam(url.searchParams.get("lat"), BUCHAREST.lat, -90, 90);
  const lon = numberParam(url.searchParams.get("lon"), BUCHAREST.lon, -180, 180);
  const days = intParam(url.searchParams.get("days"), DEFAULT_DAYS, 1, MAX_DAYS);

  const rawTimezone = url.searchParams.get("tz");
  const timezone = rawTimezone && rawTimezone.trim() !== "" ? rawTimezone.trim() : DEFAULT_TIMEZONE;
  if (timezone.length > 64 || !isValidTimeZone(timezone)) {
    throw new HttpError(400, "Invalid timezone");
  }

  await enforceEdgeRateLimit(env.PALETTE_LIMITER, request, env, context);

  const result = await getDailyPalettes({ lat, lon, days, timezone, db: env.DB });

  const body: HistoryResponse = {
    success: true,
    location: { lat, lon },
    days: result.days,
    cached: result.cached,
  };

  logEvent("info", "history.served", {
    requestId: context.requestId,
    cityKey: `${lat.toFixed(2)},${lon.toFixed(2)}`,
    days: result.days.length,
    timezone,
    cached: result.cached,
    degraded: result.degraded,
    durationMs: Date.now() - context.startedAt,
  });

  return jsonResponse(body, 200, {
    "Cache-Control": "public, max-age=600, stale-while-revalidate=1800",
    "X-History-Source": result.degraded ? "fallback" : result.cached ? "database" : "open-meteo",
  });
};
