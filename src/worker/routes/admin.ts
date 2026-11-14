/**
 * Minimal curation surface.
 *
 * The gallery only serves `approved` rows, and uploads land as `pending`, so a
 * human must be able to approve, reject, and delete. This is the smallest
 * surface that makes that possible without building an admin UI:
 *
 *   PATCH  /api/admin/submissions/:id   {"status":"approved"|"rejected"}
 *   DELETE /api/admin/submissions/:id
 *
 * Auth is a single bearer token (`ADMIN_TOKEN` secret). When the secret is
 * absent the whole surface answers 404, so an unconfigured deployment exposes
 * nothing. The token is compared in constant time and never logged.
 */

import type { RouteHandler } from "../env";
import { HttpError, jsonResponse, logEvent } from "../lib/http";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = new Set(["approved", "rejected", "pending"]);
const PREFIX = "/api/admin/submissions/";

export const handleAdmin: RouteHandler = async (request, env, ctx, context) => {
  const expected = env.ADMIN_TOKEN;
  if (!expected) throw new HttpError(404, "Not found");

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!constantTimeEqual(provided, expected)) {
    logEvent("warn", "admin.unauthorized", { requestId: context.requestId });
    throw new HttpError(401, "Unauthorized");
  }

  const url = new URL(request.url);
  const id = url.pathname.slice(PREFIX.length);
  if (!ID_PATTERN.test(id)) throw new HttpError(404, "Submission not found");

  const row = await env.DB.prepare("SELECT r2_key FROM submissions WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string }>();
  if (!row) throw new HttpError(404, "Submission not found");

  if (request.method === "DELETE") {
    if (env.PHOTOS) await env.PHOTOS.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id).run();
    logEvent("info", "admin.deleted", { requestId: context.requestId, submissionId: id });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  const status = await readStatus(request);
  await env.DB.prepare("UPDATE submissions SET status = ? WHERE id = ?").bind(status, id).run();
  logEvent("info", "admin.moderated", { requestId: context.requestId, submissionId: id, status });
  ctx.waitUntil(Promise.resolve());

  return jsonResponse({ success: true, id, status }, 200, { "Cache-Control": "no-store" });
};

async function readStatus(request: Request): Promise<string> {
  const raw = await request.text();
  if (raw.length > 512) throw new HttpError(413, "Body too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  const status = (body as { status?: unknown } | null)?.status;
  if (typeof status !== "string" || !STATUSES.has(status)) {
    throw new HttpError(400, "status must be pending, approved or rejected");
  }
  return status;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
