/**
 * Gallery keyset pagination: sort by upload or capture time, in either
 * direction, with a `(timestamp, id)` cursor so ties neither skip nor repeat.
 */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { computePalette } from "../../src/shared/palette";
import type { GalleryResponse } from "../../src/shared/types";
import { testEnv } from "./helpers";

const BASE = "https://skypalette.test";
const PALETTE = JSON.stringify(computePalette({ elevation: 2 }));

interface Seed {
  id: string;
  handle?: string;
  createdAt: string;
  capturedAt: string;
  lat?: number;
  lon?: number;
  status?: "pending" | "approved" | "rejected";
}

async function seed(row: Seed): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO submissions (
       id, city_slug, handle, r2_key, content_type, bytes, width, height,
       captured_at, lat, lon, palette_json, status, ip_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      "bucharest-romania",
      row.handle ?? `sky-${row.id.slice(0, 8)}`,
      `photos/2026/11/${row.id}.jpg`,
      "image/jpeg",
      4,
      800,
      600,
      row.capturedAt,
      row.lat ?? 44.4268,
      row.lon ?? 26.1025,
      PALETTE,
      row.status ?? "approved",
      "a".repeat(64),
      row.createdAt,
    )
    .run();
}

function gallery(query: Record<string, string>): Promise<Response> {
  const search = new URLSearchParams({ lat: "44.4268", lon: "26.1025", ...query });
  return SELF.fetch(`${BASE}/api/gallery?${search.toString()}`);
}

async function page(query: Record<string, string>): Promise<GalleryResponse & { nextCursor: string | null }> {
  const response = await gallery(query);
  expect(response.status).toBe(200);
  return (await response.json()) as GalleryResponse & { nextCursor: string | null };
}

/** Walks every page with the given sort/order and returns the ids in order. */
async function allIds(sort: string, order: string, limit = 5): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const body = await page({
      sort,
      order,
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
    expect(body.photos.length).toBeLessThanOrEqual(limit);
    ids.push(...body.photos.map((photo) => photo.id));
    cursor = body.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error("pagination did not terminate");
}

/** id with a hex counter, so lexicographic order is predictable. */
function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function expectedOrder(rows: Seed[], field: "createdAt" | "capturedAt", order: string): string[] {
  const direction = order === "asc" ? 1 : -1;
  return [...rows]
    .sort((a, b) => {
      if (a[field] === b[field]) return a.id < b.id ? -direction : direction;
      return a[field] < b[field] ? -direction : direction;
    })
    .map((row) => row.id);
}

describe("GET /api/gallery sorting", () => {
  const rows: Seed[] = [
    { id: uuid(1), createdAt: "2026-11-01T10:00:00.000Z", capturedAt: "2026-11-14T12:00:00.000Z" },
    { id: uuid(2), createdAt: "2026-11-15T09:00:00.000Z", capturedAt: "2026-11-02T08:00:00.000Z" },
    { id: uuid(3), createdAt: "2026-11-07T18:30:00.000Z", capturedAt: "2026-11-09T16:45:00.000Z" },
  ];

  it("defaults to newest upload first", async () => {
    for (const row of rows) await seed(row);

    const response = await gallery({});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("public");

    const body = (await response.json()) as GalleryResponse;
    expect(body.photos.map((photo) => photo.id)).toEqual([rows[1]!.id, rows[2]!.id, rows[0]!.id]);
    expect(body.nextCursor).toBeNull();
  });

  it("sorts upload ascending", async () => {
    for (const row of rows) await seed(row);

    const body = await page({ sort: "upload", order: "asc" });
    expect(body.photos.map((photo) => photo.id)).toEqual([rows[0]!.id, rows[2]!.id, rows[1]!.id]);
  });

  it("sorts by capture time in both directions", async () => {
    for (const row of rows) await seed(row);

    const descending = await page({ sort: "captured", order: "desc" });
    expect(descending.photos.map((photo) => photo.id)).toEqual([rows[0]!.id, rows[2]!.id, rows[1]!.id]);

    const ascending = await page({ sort: "captured", order: "asc" });
    expect(ascending.photos.map((photo) => photo.id)).toEqual([rows[1]!.id, rows[2]!.id, rows[0]!.id]);
  });

  it("keeps the 12-row cap for every sort", async () => {
    for (let i = 0; i < 15; i += 1) {
      await seed({
        id: uuid(i),
        createdAt: `2026-11-01T10:00:${String(i).padStart(2, "0")}.000Z`,
        capturedAt: `2026-11-01T10:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    for (const sort of ["upload", "captured"] as const) {
      const body = await page({ sort, limit: "1000" });
      expect(body.photos).toHaveLength(12);
      expect(body.nextCursor).toBeTruthy();
    }
  });

  it("paginates tied timestamps without repeating or skipping a row", async () => {
    // Every row shares both timestamps: only the id tiebreaker keeps the
    // pages disjoint and complete.
    const tied: Seed[] = Array.from({ length: 13 }, (_, index) => ({
      id: uuid(index),
      createdAt: "2026-11-10T12:00:00.000Z",
      capturedAt: "2026-11-10T12:00:00.000Z",
    }));
    for (const row of tied) await seed(row);

    for (const sort of ["upload", "captured"] as const) {
      for (const order of ["desc", "asc"] as const) {
        const ids = await allIds(sort, order);
        const field = sort === "upload" ? "createdAt" : "capturedAt";
        expect(ids).toEqual(expectedOrder(tied, field, order));
        expect(new Set(ids).size).toBe(tied.length);
      }
    }
  });

  it("paginates mixed timestamps with duplicates on the boundary", async () => {
    const mixed: Seed[] = Array.from({ length: 9 }, (_, index) => ({
      id: uuid(index),
      // Three pairs share a timestamp, so page boundaries land on ties.
      createdAt: `2026-11-0${Math.floor(index / 3) + 1}T12:00:00.000Z`,
      capturedAt: `2026-11-0${Math.floor(index / 2) + 1}T06:00:00.000Z`,
    }));
    for (const row of mixed) await seed(row);

    for (const sort of ["upload", "captured"] as const) {
      for (const order of ["desc", "asc"] as const) {
        const ids = await allIds(sort, order, 2);
        expect(ids).toEqual(expectedOrder(mixed, sort === "upload" ? "createdAt" : "capturedAt", order));
      }
    }
  });

  it("emits an opaque base64url cursor that carries the id", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seed({
        id: uuid(i),
        createdAt: `2026-11-01T10:00:0${i}.000Z`,
        capturedAt: `2026-11-01T10:00:0${i}.000Z`,
      });
    }

    const body = await page({ limit: "2" });
    const cursor = body.nextCursor;
    expect(cursor).toBeTruthy();
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = atob(
      cursor!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (cursor!.length % 4)) % 4),
    );
    const [timestamp, id] = decoded.split("|");
    // Newest upload first: the cursor points at the second row, timestamp and id.
    expect(timestamp).toBe("2026-11-01T10:00:01.000Z");
    expect(id).toBe(body.photos[1]!.id);
  });

  it("rejects unknown sort and order values", async () => {
    const badSort = await gallery({ sort: "size" });
    expect(badSort.status).toBe(400);
    expect(badSort.headers.get("cache-control")).toBe("no-store");
    const sortBody = (await badSort.json()) as { success: boolean; error: string };
    expect(sortBody.success).toBe(false);
    expect(sortBody.error).toContain("sort");

    const badOrder = await gallery({ order: "sideways" });
    expect(badOrder.status).toBe(400);
    expect(((await badOrder.json()) as { error: string }).error).toContain("order");

    const empty = await gallery({ sort: "" });
    expect(empty.status).toBe(400);
  });

  it("rejects malformed cursors, including the old date-only form", async () => {
    const malformed = [
      "not-a-date",
      "%%%not-base64%%%",
      "aGVsbG8", // "hello": decodes, but has no `|`
      btoa("2026-11-01T10:00:00.000Z"), // timestamp only
      btoa("2026-11-01T10:00:00.000Z|not-a-uuid"),
      btoa("nonsense|00000000-0000-4000-8000-000000000001"),
      btoa(`2026-11-01T10:00:00.000Z|00000000-0000-4000-8000-000000000001|extra`),
    ];

    for (const cursor of malformed) {
      const response = await gallery({ cursor });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("cursor");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    // A real old-style cursor: the ISO date the previous version returned.
    const legacy = await gallery({ cursor: "2026-11-01T10:00:00.000Z" });
    expect(legacy.status).toBe(400);
  });
});
