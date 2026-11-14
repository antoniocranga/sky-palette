/** City autocomplete. */

import type { CitiesResponse } from "../../shared/types";
import type { RouteHandler } from "../env";
import { searchCities } from "../lib/cities";
import { HttpError, jsonResponse, logEvent } from "../lib/http";
import { enforceEdgeRateLimit } from "../lib/rate-limit";

const QUERY_MIN = 2;
const QUERY_MAX = 80;

export const handleCities: RouteHandler = async (request, env, _ctx, context) => {
  await enforceEdgeRateLimit(env.CITIES_LIMITER, request, env, context, "cities");

  const url = new URL(request.url);
  const raw = url.searchParams.get("q");

  // Strip control characters and collapse whitespace before length checks so
  // "  Cluj \n" behaves like "Cluj".
  // eslint-disable-next-line no-control-regex -- deliberate: strip control chars
  const query = (raw ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();

  if (query.length < QUERY_MIN || query.length > QUERY_MAX) {
    throw new HttpError(400, `Query must be between ${QUERY_MIN} and ${QUERY_MAX} characters`);
  }

  const { cities, degraded } = await searchCities(query, env);
  const body: CitiesResponse = { success: true, results: cities };

  logEvent("info", "cities.searched", {
    requestId: context.requestId,
    queryLength: query.length,
    results: cities.length,
    degraded,
    durationMs: Date.now() - context.startedAt,
  });

  return jsonResponse(body, 200, {
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    "X-Cities-Source": degraded ? "database" : "open-meteo",
  });
};
