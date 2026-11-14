/**
 * Approved community photos near a point.
 *
 * Only rows a human approved are returned, and only within a small bounding
 * box, so this endpoint can never dump the table.
 */

import type { GalleryPhoto, GalleryResponse, Palette } from "../../shared/types";
import type { RouteHandler } from "../env";
import { coordinatesParam, jsonResponse, logEvent, numberParam } from "../lib/http";

const DEFAULT_RADIUS = 0.75;
const MAX_RADIUS = 5;
const MAX_PHOTOS = 6;

interface PhotoRow {
  id: string;
  handle: string;
  r2_key: string;
  thumb_key: string | null;
  captured_at: string;
  palette_json: string;
  width: number;
  height: number;
}

export const handleGallery: RouteHandler = async (request, env, _ctx, context) => {
  const url = new URL(request.url);
  const { lat, lon } = coordinatesParam(url.searchParams.get("lat"), url.searchParams.get("lon"));
  const radius = numberParam(url.searchParams.get("radius"), DEFAULT_RADIUS, 0, MAX_RADIUS);

  const { results } = await env.DB.prepare(
    `SELECT id, handle, r2_key, thumb_key, captured_at, palette_json, width, height
       FROM submissions
      WHERE status = 'approved'
        AND lat BETWEEN ? AND ?
        AND lon BETWEEN ? AND ?
      ORDER BY captured_at DESC
      LIMIT ?`,
  )
    .bind(lat - radius, lat + radius, lon - radius, lon + radius, MAX_PHOTOS)
    .all<PhotoRow>();

  const photos: GalleryPhoto[] = [];
  for (const row of results ?? []) {
    const palette = parsePalette(row.palette_json);
    if (!palette) continue;
    photos.push({
      id: row.id,
      handle: row.handle,
      url: new URL(`/api/photos/${row.r2_key}`, request.url).toString(),
      thumbUrl: new URL(`/api/photos/${row.thumb_key ?? row.r2_key}`, request.url).toString(),
      capturedAt: row.captured_at,
      palette,
      width: row.width,
      height: row.height,
    });
  }

  const body: GalleryResponse = { success: true, photos };

  logEvent("info", "gallery.served", {
    requestId: context.requestId,
    radius,
    photos: photos.length,
    durationMs: Date.now() - context.startedAt,
  });

  return jsonResponse(body, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
  });
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
    return {
      zenith: parsed.zenith as Palette["zenith"],
      midsky: parsed.midsky as Palette["midsky"],
      horizon: parsed.horizon as Palette["horizon"],
      sunglow: parsed.sunglow as Palette["sunglow"],
      cloudtint: parsed.cloudtint as Palette["cloudtint"],
      elevation: typeof parsed.elevation === "number" ? parsed.elevation : 0,
      phase: typeof parsed.phase === "string" ? parsed.phase : "Unknown",
      gradientCss: typeof parsed.gradientCss === "string" ? parsed.gradientCss : "",
    };
  } catch {
    return null;
  }
}
