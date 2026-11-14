/** Public runtime configuration for the browser. Contains no secrets. */

import type { ConfigResponse } from "../../shared/types";
import type { RouteHandler } from "../env";
import { jsonResponse } from "../lib/http";

export const handleConfig: RouteHandler = async (_request, env) => {
  const body: ConfigResponse = {
    success: true,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
    appUrl: env.APP_URL ?? "https://skypalette.app",
    // `--tag` is a release label (v1.0.0); the id is an opaque version UUID.
    version: env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id || "dev",
  };

  return jsonResponse(body, 200, {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
  });
};
