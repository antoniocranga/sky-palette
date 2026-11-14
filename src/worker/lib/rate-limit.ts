/**
 * Abuse protection.
 *
 * Two layers, deliberately:
 *
 * 1. Cloudflare `RateLimit` bindings — per-colo, eventually consistent, cheap.
 *    They absorb floods before any D1 read. Good for "too many requests from
 *    one address right now", not for exact quotas.
 * 2. `rate_limits` in D1 — a single atomic UPSERT ... RETURNING per window.
 *    This is the authoritative quota (uploads per hour, global uploads per
 *    day), and it is race-free under concurrency.
 *
 * Every key is either a fixed action name or a salted SHA-256 IP digest. No raw
 * address is ever written.
 */

import { clientIpHash, type Env } from "../env";
import { HttpError, logEvent, type RequestContext } from "./http";

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window rolls over. */
  retryAfter: number;
}

export interface QuotaOptions {
  /** Action name plus an optional identity, for example `submit:<ipHash>`. */
  key: string;
  limit: number;
  windowSeconds: number;
  now?: Date;
}

/**
 * Increments the counter for the current window and reports whether the caller
 * is still inside the limit. One round trip, no read-then-write race.
 */
export async function consumeQuota(db: D1Database, options: QuotaOptions): Promise<QuotaResult> {
  const nowMs = (options.now ?? new Date()).getTime();
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSeconds / options.windowSeconds) * options.windowSeconds;

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(options.key, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;
  const retryAfter = Math.max(1, windowStart + options.windowSeconds - nowSeconds);
  return {
    allowed: count <= options.limit,
    remaining: Math.max(0, options.limit - count),
    retryAfter,
  };
}

/** Deletes windows that can no longer be part of any active quota. */
export async function pruneQuotas(db: D1Database, olderThanSeconds = 172_800): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
  try {
    await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoff).run();
  } catch {
    // Pruning is housekeeping; never fail a request over it.
  }
}

/**
 * Applies a Cloudflare RateLimit binding. Passes silently when the binding is
 * absent (local dev, tests) so behaviour never depends on the platform.
 */
export async function enforceEdgeRateLimit(
  limiter: RateLimit | undefined,
  request: Request,
  env: Env,
  context: RequestContext,
  scope = "edge",
): Promise<void> {
  if (!limiter) return;

  const key = await clientIpHash(request, env);
  const { success } = await limiter.limit({ key });
  if (!success) {
    logEvent("warn", "rate_limit.exceeded", {
      requestId: context.requestId,
      scope,
      key: key.slice(0, 12),
    });
    throw new HttpError(429, "Rate limit exceeded. Please slow down.", { "Retry-After": "60" });
  }
}

/** Throws the standard 429 for an exhausted D1 quota. */
export function quotaExceeded(result: QuotaResult, message: string, context: RequestContext, scope: string): never {
  logEvent("warn", "quota.exceeded", {
    requestId: context.requestId,
    scope,
    retryAfter: result.retryAfter,
  });
  throw new HttpError(429, message, { "Retry-After": String(result.retryAfter) });
}
