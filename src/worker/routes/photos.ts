/** Streams a stored photo from private R2. The bucket is never public. */

import type { RouteHandler } from "../env";
import { HttpError } from "../lib/http";

const PHOTO_PREFIX = "/api/photos/";
const KEY_PATTERN = /^photos\/[A-Za-z0-9/._-]+$/;

export const handlePhoto: RouteHandler = async (request, env) => {
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

  const object = await env.PHOTOS.get(key);
  if (!object) throw new HttpError(404, "Photo not found");

  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Disposition": "inline",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ETag: object.httpEtag,
  });

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
};

/** Only the upload prefix, no traversal, no query tricks. */
function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 300) return false;
  if (key.includes("..") || key.includes("\\") || key.includes("//")) return false;
  return KEY_PATTERN.test(key);
}
