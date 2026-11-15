/** Liveness probe used by deploy checks and uptime monitoring. */

import type { RouteHandler } from "../env";
import { jsonResponse, logEvent } from "../lib/http";

export const handleHealth: RouteHandler = async (_request, env, _ctx, context) => {
  let database = false;
  try {
    await env.DB.prepare("SELECT 1").first();
    database = true;
  } catch (error) {
    logEvent("error", "health.database_unavailable", {
      requestId: context.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return jsonResponse(
    {
      success: true,
      ok: database,
      database,
      version: env.CF_VERSION_METADATA?.id ?? "dev",
      environment: env.ENVIRONMENT ?? "development",
      requestId: context.requestId,
    },
    200,
    { "Cache-Control": "no-store" },
  );
};
