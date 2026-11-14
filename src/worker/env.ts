/** Worker environment bindings and the shared route handler signature. */

import type { RequestContext } from "./lib/http";

export interface Env {
  DB: D1Database;
  /** Optional so local dev and tests can run without a bucket. */
  PHOTOS?: R2Bucket;
  ASSETS: Fetcher;
  PALETTE_LIMITER?: RateLimit;
  SUBMIT_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  CITIES_LIMITER?: RateLimit;
  OG_LIMITER?: RateLimit;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  /** Server-only Turnstile secret. Absent locally disables the check. */
  TURNSTILE_SECRET_KEY?: string;
  /** Public Turnstile site key, safe to expose through /api/config. */
  TURNSTILE_SITE_KEY?: string;
  /** Salt for IP hashing. Never logged, never returned. */
  IP_SALT?: string;
  /** When "false", uploads answer 503. Set as a Worker secret for a kill switch. */
  UPLOADS_ENABLED?: string;
  /** Bearer token for /api/admin/*. Unset disables the whole admin surface. */
  ADMIN_TOKEN?: string;
  ENVIRONMENT?: string;
  APP_URL?: string;
}

export type RouteHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  context: RequestContext,
) => Promise<Response>;

const DEV_SALT = "sky-palette-dev-salt";

/** SHA-256 of `salt:ip`. Raw addresses are never stored or logged. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hashed client identity used for abuse limits. */
export async function clientIpHash(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  return hashIp(ip, env.IP_SALT ?? DEV_SALT);
}

/** Raw client address, only ever passed to Turnstile's `remoteip`. */
export function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}
