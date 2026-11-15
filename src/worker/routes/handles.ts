/**
 * Anonymous handle validation.
 *
 * Handles are display names, not identifiers, so this checks format and
 * reserved words only. It deliberately does not check uniqueness: two
 * contributors may share a handle, and the record id is the real key.
 */

import type { Env, RouteHandler } from "../env";
import { jsonResponse, logEvent } from "../lib/http";
import { enforceEdgeRateLimit } from "../lib/rate-limit";

export const HANDLE_MIN = 5;
export const HANDLE_MAX = 24;

const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set([
  "admin",
  "administrator",
  "anonymous",
  "api",
  "cloudflare",
  "help",
  "moderator",
  "official",
  "root",
  "security",
  "sky-palette",
  "skypalette",
  "staff",
  "support",
  "system",
]);

export interface HandleCheck {
  handle: string;
  valid: boolean;
  available?: boolean;
  reason?: "too_short" | "too_long" | "charset" | "edges" | "reserved" | "taken";
}

export function validateHandle(value: string): HandleCheck {
  const handle = value.trim().toLowerCase();

  if (handle.length < HANDLE_MIN) return { handle, valid: false, reason: "too_short" };
  if (handle.length > HANDLE_MAX) return { handle, valid: false, reason: "too_long" };
  if (handle.startsWith("-") || handle.endsWith("-") || handle.includes("--")) {
    return { handle, valid: false, reason: "edges" };
  }
  if (!HANDLE_PATTERN.test(handle)) return { handle, valid: false, reason: "charset" };
  if (RESERVED.has(handle)) return { handle, valid: false, reason: "reserved" };

  return { handle, valid: true };
}

export const handleHandleCheck: RouteHandler = async (request, env, _ctx, context) => {
  await enforceEdgeRateLimit(env.CITIES_LIMITER, request, env, context, "handles");

  const url = new URL(request.url);
  const raw = url.searchParams.get("handle") ?? "";
  const result = validateHandle(raw.slice(0, 64));

  if (result.valid) {
    const available = await isHandleAvailable(env.DB, result.handle);
    logEvent("info", "handle.checked", {
      requestId: context.requestId,
      valid: available,
      reason: available ? undefined : "taken",
    });
    return jsonResponse(
      { success: true, ...result, available, reason: available ? undefined : "taken" },
      200,
      { "Cache-Control": "no-store" },
    );
  }

  logEvent("info", "handle.checked", {
    requestId: context.requestId,
    valid: false,
    reason: result.reason,
  });

  return jsonResponse({ success: true, ...result, available: false }, 200, { "Cache-Control": "no-store" });
};

/** Handles are display names, but we keep them unique so shared links are unambiguous. */
export async function isHandleAvailable(db: D1Database, handle: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM submissions WHERE lower(handle) = ? LIMIT 1")
    .bind(handle.toLowerCase())
    .first<{ hit: number }>();
  return !row;
}

/** Validates format and uniqueness; returns the normalised handle or a reason. */
export async function checkHandle(
  db: D1Database,
  value: string,
): Promise<{ handle: string; ok: boolean; reason?: string }> {
  const result = validateHandle(value);
  if (!result.valid) return { handle: result.handle, ok: false, reason: result.reason };
  if (!(await isHandleAvailable(db, result.handle))) {
    return { handle: result.handle, ok: false, reason: "taken" };
  }
  return { handle: result.handle, ok: true };
}
