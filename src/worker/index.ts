/**
 * Sky Palette Worker.
 *
 * The Worker owns everything authoritative: validation, rate limiting, weather
 * ingestion, palette computation and persistence. The browser only renders.
 *
 * Routing is a small table: the path selects a handler, the table also decides
 * 404 (no such API path) and 405 (path exists, method does not), so every route
 * answers those two cases identically.
 */

import type { Env, RouteHandler } from "./env";
import { createRequestContext, errorResponse, htmlErrorResponse, HttpError, logEvent, type RequestContext } from "./lib/http";
import { enforceEdgeRateLimit } from "./lib/rate-limit";
import { reapOrphans } from "./lib/orphans";
import { handleCities } from "./routes/cities";
import { handleConfig } from "./routes/config";
import { handleGallery } from "./routes/gallery";
import { handleHealth } from "./routes/health";
import { handleHandleCheck } from "./routes/handles";
import { handleHistory } from "./routes/history";
import { handleLocation } from "./routes/location";
import { handlePalette } from "./routes/palette";
import { handlePhoto } from "./routes/photos";
import { handlePhotoInfo } from "./routes/photo";
import { handleSubmit } from "./routes/submit";
import { pruneGeoCache } from "./lib/reverse";
import { handleAdmin } from "./routes/admin";

export type { Env } from "./env";
export { hashIp } from "./env";

interface RouteDefinition {
  path: string;
  methods: readonly string[];
  handler: RouteHandler;
  /** Photo keys live under a prefix rather than at a fixed path. */
  prefix?: boolean;
}

const GET = ["GET", "HEAD"] as const;
const POST = ["POST"] as const;

const ROUTES: readonly RouteDefinition[] = [
  { path: "/api/health", methods: GET, handler: handleHealth },
  { path: "/api/palette", methods: GET, handler: handlePalette },
  { path: "/api/cities", methods: GET, handler: handleCities },
  { path: "/api/history", methods: GET, handler: handleHistory },
  { path: "/api/handles/check", methods: GET, handler: handleHandleCheck },
  { path: "/api/location", methods: GET, handler: handleLocation },
  { path: "/api/gallery", methods: GET, handler: handleGallery },
  { path: "/api/config", methods: GET, handler: handleConfig },
  { path: "/api/submit", methods: POST, handler: handleSubmit },
  { path: "/api/photo", methods: GET, handler: handlePhotoInfo },
  { path: "/api/photos/", methods: GET, handler: handlePhoto, prefix: true },
  { path: "/api/admin/", methods: ["GET", "DELETE", "PATCH"] as const, handler: handleAdmin, prefix: true },
];

function matchRoute(pathname: string): RouteDefinition | undefined {
  for (const route of ROUTES) {
    if (route.prefix) {
      if (pathname.length > route.path.length && pathname.startsWith(route.path)) return route;
    } else if (pathname === route.path) {
      return route;
    }
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const context = createRequestContext(request);

    // One canonical host. A route (not a custom domain) points www here so it
    // cannot serve a duplicate copy of the app.
    if (url.hostname === "www.skypalette.app") {
      const target = new URL(url.pathname + url.search, "https://skypalette.app");
      return Response.redirect(target.toString(), 301);
    }

    try {
      const route = matchRoute(url.pathname);

      // One global ceiling for the whole API surface, before any route work.
      // Health is excluded so monitoring can never be rate-limited.
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
        await enforceEdgeRateLimit(env.API_LIMITER, request, env, context, "api");
      }

      if (route) {
        if (!route.methods.includes(request.method)) {
          return errorResponse(405, "Method not allowed", context, { Allow: route.methods.join(", ") });
        }
        const response = await route.handler(request, env, ctx, context);
        logEvent("info", "request.completed", {
          requestId: context.requestId,
          method: request.method,
          path: url.pathname,
          status: response.status,
          durationMs: Date.now() - context.startedAt,
        });
        return response;
      }

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return errorResponse(404, "Unknown API endpoint", context);
      }

      // Non-API requests are served by the static asset binding.
      return await env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status >= 500) {
          logEvent("warn", "request.failed", {
            requestId: context.requestId,
            path: url.pathname,
            status: error.status,
            reason: error.message,
            durationMs: Date.now() - context.startedAt,
          });
        }
        return errorResponse(error.status, error.message, context, error.headers);
      }

      // Never leak a stack trace or an upstream message to the client.
      logEvent("error", "request.unhandled", {
        requestId: context.requestId,
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        durationMs: Date.now() - context.startedAt,
      });
      if (url.pathname.startsWith("/api/")) {
        return errorResponse(500, "Atmospheric processing failed. Please try again.", context);
      }
      return htmlErrorResponse(500, context);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reapOrphans(env));
    ctx.waitUntil(pruneGeoCache(env.DB));
  },
} satisfies ExportedHandler<Env>;

export type { RequestContext };
