/** One approved photo's metadata, for the shareable photo modal. */

import type { GalleryPhoto, Palette } from "../../shared/types";
import type { Env, RouteHandler } from "../env";
import { HttpError, jsonResponse } from "../lib/http";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export const handlePhotoInfo: RouteHandler = async (request, env, _ctx, context) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!ID_PATTERN.test(id)) throw new HttpError(404, "Photo not found");

  const row = await env.DB.prepare(
    `SELECT id, handle, city_slug, r2_key, thumb_key, captured_at, created_at, palette_json, width, height
       FROM submissions
      WHERE id = ? AND status = 'approved'`,
  )
    .bind(id)
    .first<PhotoRow>();

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
