/**
 * Photo metadata lookup: `/api/photo?id=<uuid>` and `/api/photo?handle=<handle>`
 * must agree, and both only ever surface approved rows.
 */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { computePalette } from "../../src/shared/palette";
import type { GalleryPhoto } from "../../src/shared/types";
import { testEnv } from "./helpers";

const BASE = "https://skypalette.test";
const PALETTE = JSON.stringify(computePalette({ elevation: 2 }));

interface Seed {
  id: string;
  handle: string;
  status: "pending" | "approved" | "rejected";
  createdAt?: string;
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
      row.handle,
      `photos/2026/11/${row.id}.jpg`,
      "image/jpeg",
      4,
      800,
      600,
      "2026-11-14T14:51:00.000Z",
      44.4268,
      26.1025,
      PALETTE,
      row.status,
      "a".repeat(64),
      row.createdAt ?? new Date().toISOString(),
    )
    .run();
}

interface PhotoBody {
  success: boolean;
  photo: GalleryPhoto;
}

function fetchPhoto(query: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/photo?${query}`);
}

const APPROVED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVED_HANDLE = "sky-bucharest-extra8";
const PENDING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PENDING_HANDLE = "sky-bucharest-pending1";
const REJECTED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REJECTED_HANDLE = "sky-bucharest-reject1";

async function seedAll(): Promise<void> {
  await seed({ id: APPROVED_ID, handle: APPROVED_HANDLE, status: "approved" });
  await seed({ id: PENDING_ID, handle: PENDING_HANDLE, status: "pending" });
  await seed({ id: REJECTED_ID, handle: REJECTED_HANDLE, status: "rejected" });
}

describe("GET /api/photo by handle", () => {
  it("serves an approved handle with the same payload and headers as its id", async () => {
    await seedAll();

    const byHandle = await fetchPhoto(`handle=${APPROVED_HANDLE}`);
    expect(byHandle.status).toBe(200);
    expect(byHandle.headers.get("cache-control")).toContain("public");
    expect(byHandle.headers.get("x-content-type-options")).toBe("nosniff");

    const byId = await fetchPhoto(`id=${APPROVED_ID}`);
    expect(byId.status).toBe(200);

    const handleBody = (await byHandle.json()) as PhotoBody;
    const idBody = (await byId.json()) as PhotoBody;
    expect(handleBody).toEqual(idBody);
    expect(handleBody.photo).toMatchObject({
      id: APPROVED_ID,
      handle: APPROVED_HANDLE,
      citySlug: "bucharest-romania",
      width: 800,
      height: 600,
    });
    expect(handleBody.photo.url).toContain(`/api/photos/photos/2026/11/${APPROVED_ID}.jpg`);
    expect(handleBody.photo.palette.zenith).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("resolves a handle regardless of casing", async () => {
    await seedAll();
    const response = await fetchPhoto(`handle=${APPROVED_HANDLE.toUpperCase()}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as PhotoBody).photo.id).toBe(APPROVED_ID);
  });

  it("hides pending and rejected handles behind a 404", async () => {
    await seedAll();

    for (const handle of [PENDING_HANDLE, REJECTED_HANDLE]) {
      const response = await fetchPhoto(`handle=${handle}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Photo not found");
      expect(body).not.toHaveProperty("photo");
    }
  });

  it("returns 404 for an unknown or malformed handle", async () => {
    await seedAll();

    for (const handle of ["sky-nowhere-atall", "not a handle", "x", "-leading"]) {
      const response = await fetchPhoto(`handle=${encodeURIComponent(handle)}`);
      expect(response.status).toBe(404);
    }
  });

  it("rejects both identifiers and neither identifier with 400", async () => {
    await seedAll();

    const both = await fetchPhoto(`id=${APPROVED_ID}&handle=${APPROVED_HANDLE}`);
    expect(both.status).toBe(400);
    const bothBody = (await both.json()) as { success: boolean; error: string };
    expect(bothBody.success).toBe(false);
    expect(bothBody.error).toContain("either id or handle");

    for (const query of ["", "id=", "handle=", "handle=%20"]) {
      const response = await fetchPhoto(query);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Missing photo id or handle");
    }
  });

  it("reports an unknown id as 404", async () => {
    await seedAll();
    for (const id of ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "nope"]) {
      const response = await fetchPhoto(`id=${id}`);
      expect(response.status).toBe(404);
    }
  });
});
