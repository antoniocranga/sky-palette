/**
 * Streams a stored photo from private R2.
 *
 * Visibility is moderation-gated: only `approved` submissions are public. A
 * pending/rejected object is still reachable by an admin (bearer token) so the
 * moderation page can preview it, but never by guessing the key.
 *
 * Approved responses are cached at the edge, so a gallery view does not hit
 * D1 or R2 on every request.
 */

import type { RouteHandler } from "../env";
import { HttpError } from "../lib/http";

const PHOTO_PREFIX = "/api/photos/";
const KEY_PATTERN = /^photos\/\d{4}\/\d{2}\/(?:thumb-)?[0-9a-f-]{36}\.(?:jpg|png|webp)$/;
const PUBLIC_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const handlePhoto: RouteHandler = async (request, env, ctx, context) => {
  const url = new URL(request.url);
  const raw = url.pathname.slice(PHOTO_PREFIX.length);

  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    throw new HttpError(404, "Photo not found");
  }

  if (!isSafeKey(key)) throw new HttpError(404, "Photo not found");
  if (!env.PHOTOS) throw new HttpError(503, "Photo storage is unavailable");

  const isAdmin = hasAdminToken(request, env.ADMIN_TOKEN);

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cacheable = !isAdmin && !request.headers.has("if-none-match");
  if (cacheable && cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const row = await env.DB.prepare(
    "SELECT status FROM submissions WHERE r2_key = ?1 OR thumb_key = ?1 LIMIT 1",
  )
    .bind(key)
    .first<{ status: string }>();

  if (!row) throw new HttpError(404, "Photo not found");
  if (row.status !== "approved" && !isAdmin) throw new HttpError(404, "Photo not found");

  const object = await env.PHOTOS.get(key);
  if (!object) throw new HttpError(404, "Photo not found");

  const storedType = object.httpMetadata?.contentType ?? "";
  const contentType = PUBLIC_TYPES.has(storedType) ? storedType : "application/octet-stream";

  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": "inline",
    "Cache-Control": isAdmin ? "no-store" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Defence in depth if an image is ever interpreted as a document.
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: object.httpEtag,
  });

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("Content-Length", String(object.size));
  const response = new Response(object.body, { status: 200, headers });

  if (cacheable && cache && contentType !== "application/octet-stream") {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  logApproved(context.requestId, key);
  return response;
};

function logApproved(_requestId: string, _key: string): void {
  // Intentionally silent per request: photo views are high volume and the
  // access log already records the path. Kept as a seam for future sampling.
}

function hasAdminToken(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return constantTimeEqual(provided, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Only random upload keys: no traversal, no listing, no legacy shapes. */
function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 300) return false;
  if (key.includes("..") || key.includes("\\") || key.includes("//")) return false;
  return KEY_PATTERN.test(key);
}
