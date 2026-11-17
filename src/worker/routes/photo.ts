/**
 * One approved photo's metadata, for the shareable photo modal.
 *
 * Lookups accept either `?id=<uuid>` or `?handle=<handle>`. Handles are kept
 * unique across submissions, so a shared link can use the human-readable form.
 * Only approved rows resolve; a pending or rejected handle is indistinguishable
 * from an unknown one.
 */

import type { GalleryPhoto, Palette } from "../../shared/types";
import type { RouteHandler } from "../env";
import { HttpError, jsonResponse } from "../lib/http";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_HANDLE_LENGTH = 64;

interface PhotoRow {
  id: string;
  handle: string;
  city_slug: string | null;
  r2_key: string;
  thumb_key: string | null;
  captured_at: string;
  created_at: string;
  palette_json: string;
  width: number;
  height: number;
}

const ROW_COLUMNS = `id, handle, city_slug, r2_key, thumb_key, captured_at, created_at, palette_json, width, height`;

export const handlePhotoInfo: RouteHandler = async (request, env, _ctx, _context) => {
  const url = new URL(request.url);
  const rawId = url.searchParams.get("id");
  const rawHandle = url.searchParams.get("handle");
  // A blank parameter counts as absent, so `?id=` behaves like no parameter at
  // all instead of silently looking up an empty id.
  const id = rawId?.trim() || null;
  const handle = rawHandle?.trim().toLowerCase() || null;

  if (id !== null && handle !== null) {
    throw new HttpError(400, "Pass either id or handle, not both");
  }
  if (id === null && handle === null) {
    throw new HttpError(400, "Missing photo id or handle");
  }

  const row =
    id !== null ? await rowById(env.DB, id) : await rowByHandle(env.DB, handle ?? "");

  if (!row) throw new HttpError(404, "Photo not found");

  const palette = parsePalette(row.palette_json);
  if (!palette) throw new HttpError(404, "Photo not found");

  const photo: GalleryPhoto = {
    id: row.id,
    handle: row.handle,
    citySlug: row.city_slug,
    url: `/api/photos/${row.r2_key}`,
    thumbUrl: `/api/photos/${row.thumb_key ?? row.r2_key}`,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    palette,
    width: row.width,
    height: row.height,
  };

  return jsonResponse(
    { success: true, photo },
    200,
    { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" },
  );
};

async function rowById(db: D1Database, id: string): Promise<PhotoRow | null> {
  // A malformed id cannot exist, so it is reported as not found rather than as
  // a client error: the response must not confirm how ids are shaped.
  if (!ID_PATTERN.test(id)) return null;
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM submissions WHERE id = ? AND status = 'approved'`)
    .bind(id)
    .first<PhotoRow>();
}

async function rowByHandle(db: D1Database, handle: string): Promise<PhotoRow | null> {
  if (handle.length === 0 || handle.length > MAX_HANDLE_LENGTH) return null;
  if (!HANDLE_PATTERN.test(handle)) return null;
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM submissions WHERE lower(handle) = ? AND status = 'approved'`)
    .bind(handle)
    .first<PhotoRow>();
}

function parsePalette(value: string): Palette | null {
  try {
    const parsed = JSON.parse(value) as Partial<Palette> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const channels = ["zenith", "midsky", "horizon", "sunglow", "cloudtint"] as const;
    for (const channel of channels) {
      const colour = parsed[channel];
      if (typeof colour !== "string" || !/^#[0-9a-f]{6}$/i.test(colour)) return null;
    }
    return parsed as Palette;
  } catch {
    return null;
  }
}
