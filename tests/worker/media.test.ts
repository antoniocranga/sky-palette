import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { computePalette } from "../../src/shared/palette";
import type { GalleryResponse } from "../../src/shared/types";
import { testEnv } from "./helpers";

const BASE = "https://skypalette.test";

async function putPhoto(key: string, contentType: string): Promise<void> {
  await testEnv.PHOTOS.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    httpMetadata: { contentType },
  });
}

interface SubmissionSeed {
  id: string;
  handle: string;
  key: string;
  lat: number;
  lon: number;
  capturedAt: string;
  status: "pending" | "approved" | "rejected";
}

async function seedSubmission(seed: SubmissionSeed): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO submissions (
       id, city_slug, handle, r2_key, content_type, bytes, width, height,
       captured_at, lat, lon, palette_json, status, ip_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      seed.id,
      "bucharest-romania",
      seed.handle,
      seed.key,
      "image/jpeg",
      4,
      800,
      600,
      seed.capturedAt,
      seed.lat,
      seed.lon,
      JSON.stringify(computePalette({ elevation: 2 })),
      seed.status,
      "a".repeat(64),
      new Date().toISOString(),
    )
    .run();
}

describe("GET /api/photos/*", () => {
  it("streams a stored photo with immutable caching", async () => {
    await putPhoto("photos/2026/11/abc.jpg", "image/jpeg");

    const response = await SELF.fetch(`${BASE}/api/photos/photos/2026/11/abc.jpg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(4);
  });

  it("returns 304 when the etag matches", async () => {
    await putPhoto("photos/2026/11/etag.jpg", "image/jpeg");

    const first = await SELF.fetch(`${BASE}/api/photos/photos/2026/11/etag.jpg`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await SELF.fetch(`${BASE}/api/photos/photos/2026/11/etag.jpg`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(second.status).toBe(304);
  });

  it("returns 404 for a missing object", async () => {
    const response = await SELF.fetch(`${BASE}/api/photos/photos/2026/11/missing.jpg`);
    expect(response.status).toBe(404);
  });

  it("refuses keys outside the photos prefix", async () => {
    await testEnv.PHOTOS.put("secret.txt", "top secret");

    const response = await SELF.fetch(`${BASE}/api/photos/secret.txt`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("top secret");
  });

  it("refuses path traversal", async () => {
    const response = await SELF.fetch(`${BASE}/api/photos/photos/%2E%2E%2F%2E%2E%2Fsecret.jpg`);
    expect(response.status).toBe(404);
  });

  it("returns 404 when no key is given", async () => {
    const response = await SELF.fetch(`${BASE}/api/photos/`);
    expect(response.status).toBe(404);
  });
});

describe("GET /api/gallery", () => {
  it("returns only approved photos inside the bounding box", async () => {
    await seedSubmission({
      id: "11111111-1111-4111-8111-111111111111",
      handle: "sky-bucharest-1a2b",
      key: "photos/2026/11/one.jpg",
      lat: 44.43,
      lon: 26.1,
      capturedAt: "2026-11-13T15:00:00.000Z",
      status: "approved",
    });
    await seedSubmission({
      id: "22222222-2222-4222-8222-222222222222",
      handle: "sky-bucharest-3c4d",
      key: "photos/2026/11/two.jpg",
      lat: 44.45,
      lon: 26.12,
      capturedAt: "2026-11-14T15:00:00.000Z",
      status: "approved",
    });
    await seedSubmission({
      id: "33333333-3333-4333-8333-333333333333",
      handle: "sky-bucharest-5e6f",
      key: "photos/2026/11/pending.jpg",
      lat: 44.43,
      lon: 26.1,
      capturedAt: "2026-11-14T16:00:00.000Z",
      status: "pending",
    });
    await seedSubmission({
      id: "44444444-4444-4444-8444-444444444444",
      handle: "sky-paris-7a8b",
      key: "photos/2026/11/far.jpg",
      lat: 48.85,
      lon: 2.35,
      capturedAt: "2026-11-14T17:00:00.000Z",
      status: "approved",
    });

    const response = await SELF.fetch(`${BASE}/api/gallery?lat=44.43&lon=26.1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("public");

    const body = (await response.json()) as GalleryResponse;
    expect(body.success).toBe(true);
    expect(body.photos).toHaveLength(2);
    expect(body.photos[0]?.capturedAt).toBe("2026-11-14T15:00:00.000Z");
    expect(body.photos[0]).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      handle: "sky-bucharest-3c4d",
      width: 800,
      height: 600,
    });
    expect(body.photos[0]?.url).toContain("/api/photos/photos/2026/11/two.jpg");
    expect(body.photos[0]?.palette.zenith).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("returns an empty list when nothing is nearby", async () => {
    const response = await SELF.fetch(`${BASE}/api/gallery?lat=-33.86&lon=151.2`);
    const body = (await response.json()) as GalleryResponse;
    expect(body.photos).toEqual([]);
  });

  it("requires coordinates", async () => {
    const response = await SELF.fetch(`${BASE}/api/gallery?lat=44`);
    expect(response.status).toBe(400);
  });

  it("rejects a radius beyond the allowed maximum", async () => {
    const response = await SELF.fetch(`${BASE}/api/gallery?lat=44&lon=26&radius=90`);
    expect(response.status).toBe(400);
  });
});
