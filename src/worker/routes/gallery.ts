/**
 * Approved community photos near a point.
 *
 * Only rows a human approved are returned, and only within a small bounding
 * box, so this endpoint can never dump the table.
 *
 * Pagination is keyset based on `(sort column, id)`: the cursor carries both
 * halves of the key, so photos uploaded in the same millisecond can never make
 * a page skip or repeat a row.
 */

import type { GalleryPhoto, GalleryResponse, Palette } from "../../shared/types";
import type { RouteHandler } from "../env";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { coordinatesParam, HttpError, jsonResponse, logEvent, numberParam } from "../lib/http";

const DEFAULT_RADIUS = 0.75;
const MAX_RADIUS = 5;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;

/** Whitelisted sort keys: the query string never reaches the SQL text. */
const SORT_COLUMNS = {
  upload: "created_at",
  captured: "captured_at",
} as const;

type SortKey = keyof typeof SORT_COLUMNS;
type SortOrder = "asc" | "desc";

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
    throw new HttpError(400, "Invalid limit: expected a number of at least 1");
  }
  const limit = Math.min(MAX_LIMIT, Math.floor(requestedLimit));
  const sort = sortParam(url.searchParams.get("sort"));
  const order = orderParam(url.searchParams.get("order"));

  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
  if (rawCursor !== null && cursor === null) {
    throw new HttpError(400, "Invalid cursor");
  }

  // Keyset comparison on the tuple (column, id). Both halves always travel
  // together in the cursor, so ties on the timestamp are broken by id.
  const column = SORT_COLUMNS[sort];
  const comparator =
    order === "asc"
      ? `(${column} > ? OR (${column} = ? AND id > ?))`
      : `(${column} < ? OR (${column} = ? AND id < ?))`;
  const cursorBindings = cursor ? [cursor.timestamp, cursor.timestamp, cursor.id] : [];

  // No edge cache here: approvals change the list, and per-coordinate cache
  // keys make targeted invalidation impractical. The HTTP cache header still
  // lets the browser reuse the response briefly. Sort and order are plain
  // query parameters, so they are part of the cache key.
  const { results } = await env.DB.prepare(
    `SELECT id, handle, city_slug, r2_key, thumb_key, captured_at, created_at, palette_json, width, height
       FROM submissions
      WHERE status = 'approved'
        AND lat BETWEEN ? AND ?
        AND lon BETWEEN ? AND ?
        ${cursor ? `AND ${comparator}` : ""}
      ORDER BY ${column} ${order === "asc" ? "ASC" : "DESC"}, id ${order === "asc" ? "ASC" : "DESC"}
      LIMIT ?`,
  )
    .bind(
      lat - radius,
      lat + radius,
      lon - radius,
      lon + radius,
      ...cursorBindings,
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

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow ? encodeCursor(lastRow[column], lastRow.id) : null;
  const body = { success: true as const, photos, nextCursor };

  logEvent("info", "gallery.served", {
    requestId: context.requestId,
    radius,
    sort,
    order,
    photos: photos.length,
    nextCursor: Boolean(nextCursor),
    durationMs: Date.now() - context.startedAt,
  });

  return jsonResponse(body, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
  });
};

function sortParam(value: string | null): SortKey {
  if (value === null) return "upload";
  if (value === "upload" || value === "captured") return value;
  throw new HttpError(400, "Invalid sort: expected upload or captured");
}

function orderParam(value: string | null): SortOrder {
  if (value === null) return "desc";
  if (value === "asc" || value === "desc") return value;
  throw new HttpError(400, "Invalid order: expected asc or desc");
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
