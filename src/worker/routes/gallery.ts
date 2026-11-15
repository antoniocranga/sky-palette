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
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;

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

export const handleGallery: RouteHandler = async (request, env, _ctx, context) => {
  const url = new URL(request.url);
  const { lat, lon } = coordinatesParam(url.searchParams.get("lat"), url.searchParams.get("lon"));
  const radius = numberParam(url.searchParams.get("radius"), DEFAULT_RADIUS, 0, MAX_RADIUS);
  const rawLimit = url.searchParams.get("limit");
  const requestedLimit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
    return jsonResponse({ success: false, error: "Invalid limit", statusCode: 400, requestId: context.requestId }, 400, { "Cache-Control": "no-store" });
  }
  const limit = Math.min(MAX_LIMIT, Math.floor(requestedLimit));
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && Number.isNaN(Date.parse(cursor))) {
    return jsonResponse({ success: false, error: "Invalid cursor", statusCode: 400, requestId: context.requestId }, 400, { "Cache-Control": "no-store" });
  }

  // No edge cache here: approvals change the list, and per-coordinate cache
  // keys make targeted invalidation impractical. The HTTP cache header still
  // lets the browser reuse the response briefly.
  const { results } = await env.DB.prepare(
    `SELECT id, handle, city_slug, r2_key, thumb_key, captured_at, created_at, palette_json, width, height
       FROM submissions
      WHERE status = 'approved'
        AND lat BETWEEN ? AND ?
        AND lon BETWEEN ? AND ?
        ${cursor ? "AND created_at < ?" : ""}
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(
      lat - radius,
      lat + radius,
      lon - radius,
      lon + radius,
      ...(cursor ? [cursor] : []),
      limit + 1,
    )
    .all<PhotoRow>();

  const rows = results ?? [];
  const pageRows = rows.slice(0, limit);
  const photos: GalleryPhoto[] = [];
  for (const row of pageRows) {
    const palette = parsePalette(row.palette_json);
    if (!palette) continue;
    photos.push({
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
    });
  }

  const nextCursor = rows.length > limit ? (pageRows[pageRows.length - 1]?.created_at ?? null) : null;
  const body = { success: true as const, photos, nextCursor };

  logEvent("info", "gallery.served", {
    requestId: context.requestId,
    radius,
    photos: photos.length,
    nextCursor: Boolean(nextCursor),
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
