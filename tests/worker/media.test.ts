import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { computePalette } from "../../src/shared/palette";
import type { GalleryResponse } from "../../src/shared/types";
import { testEnv, withEnvVar } from "./helpers";

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

const APPROVED_KEY = "photos/2026/11/11111111-1111-4111-8111-111111111111.jpg";
const ETAG_KEY = "photos/2026/11/22222222-2222-4222-8222-222222222222.jpg";
const PENDING_KEY = "photos/2026/11/33333333-3333-4333-8333-333333333333.jpg";
const MISSING_KEY = "photos/2026/11/44444444-4444-4444-8444-444444444444.jpg";

async function seedPhoto(key: string, status: "approved" | "pending"): Promise<void> {
  await putPhoto(key, "image/jpeg");
  await seedSubmission({
    id: crypto.randomUUID(),
    handle: "sky-test",
    key,
    lat: 44.4268,
    lon: 26.1025,
    capturedAt: "2026-11-14T14:51:00.000Z",
    status,
  });
}

describe("GET /api/photos/*", () => {
  it("streams an approved photo with immutable caching and image hardening", async () => {
    await seedPhoto(APPROVED_KEY, "approved");

    const response = await SELF.fetch(`${BASE}/api/photos/${APPROVED_KEY}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(4);
  });

  it("returns 304 when the etag matches", async () => {
    await seedPhoto(ETAG_KEY, "approved");

    const first = await SELF.fetch(`${BASE}/api/photos/${ETAG_KEY}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await SELF.fetch(`${BASE}/api/photos/${ETAG_KEY}`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(second.status).toBe(304);
  });

  it("hides a pending photo until it is approved", async () => {
    await seedPhoto(PENDING_KEY, "pending");

    const hidden = await SELF.fetch(`${BASE}/api/photos/${PENDING_KEY}`);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain(PENDING_KEY);

    await withEnvVar("ADMIN_TOKEN", "test-admin-token", async () => {
      const visible = await SELF.fetch(`${BASE}/api/photos/${PENDING_KEY}`, {
        headers: { authorization: "Bearer test-admin-token" },
      });
      expect(visible.status).toBe(200);
      expect(visible.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("returns 404 for an approved row whose object is missing", async () => {
    await seedSubmission({
      id: crypto.randomUUID(),
      handle: "sky-test",
      key: MISSING_KEY,
      lat: 44.4268,
      lon: 26.1025,
      capturedAt: "2026-11-14T14:51:00.000Z",
      status: "approved",
    });
    const response = await SELF.fetch(`${BASE}/api/photos/${MISSING_KEY}`);
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

  it("paginates with a cursor and caps the page size", async () => {
    for (let i = 0; i < 8; i += 1) {
      await seedSubmission({
        id: crypto.randomUUID(),
        handle: `sky-page-${i}`,
        key: `photos/2026/11/00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}.jpg`,
        lat: 44.4268,
        lon: 26.1025,
        capturedAt: `2026-11-${String(10 + i).padStart(2, "0")}T12:00:00.000Z`,
        status: "approved",
      });
    }

    const first = await SELF.fetch(`${BASE}/api/gallery?lat=44.4268&lon=26.1025&limit=3`);
    const firstBody = (await first.json()) as GalleryResponse & { nextCursor: string | null };
    expect(firstBody.photos).toHaveLength(3);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await SELF.fetch(
      `${BASE}/api/gallery?lat=44.4268&lon=26.1025&limit=3&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
    );
    const secondBody = (await second.json()) as GalleryResponse & { nextCursor: string | null };
    expect(secondBody.photos).toHaveLength(3);
    expect(secondBody.photos.map((p) => p.id)).not.toEqual(firstBody.photos.map((p) => p.id));

    const capped = await SELF.fetch(`${BASE}/api/gallery?lat=44.4268&lon=26.1025&limit=1000`);
    expect(capped.status).toBe(200);
    const cappedBody = (await capped.json()) as GalleryResponse;
    expect(cappedBody.photos.length).toBeLessThanOrEqual(12);

    const bad = await SELF.fetch(`${BASE}/api/gallery?lat=44.4268&lon=26.1025&cursor=not-a-date`);
    expect(bad.status).toBe(400);
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

describe("gallery ordering and photo metadata", () => {
  it("orders by upload time, not capture time", async () => {
    await seedSubmission({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      handle: "sky-old-upload",
      key: APPROVED_KEY,
      lat: 44.4268,
      lon: 26.1025,
      capturedAt: "2026-11-14T14:51:00.000Z",
      status: "approved",
    });
    await seedSubmission({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      handle: "sky-new-upload",
      key: ETAG_KEY,
      lat: 44.4268,
      lon: 26.1025,
      capturedAt: "2026-11-01T14:51:00.000Z",
      status: "approved",
    });
    await testEnv.DB.prepare("UPDATE submissions SET created_at = '2026-11-01T10:00:00.000Z' WHERE handle = 'sky-old-upload'").run();
    await testEnv.DB.prepare("UPDATE submissions SET created_at = '2026-11-15T09:00:00.000Z' WHERE handle = 'sky-new-upload'").run();

    const response = await SELF.fetch(`${BASE}/api/gallery?lat=44.4268&lon=26.1025`);
    const body = (await response.json()) as GalleryResponse;
    expect(body.photos[0]?.handle).toBe("sky-new-upload");
    expect(body.photos[0]?.createdAt).toBe("2026-11-15T09:00:00.000Z");
  });

  it("serves one approved photo by id and hides pending ones", async () => {
    await seedSubmission({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      handle: "sky-meta",
      key: APPROVED_KEY,
      lat: 44.4268,
      lon: 26.1025,
      capturedAt: "2026-11-14T14:51:00.000Z",
      status: "approved",
    });

    const ok = await SELF.fetch(`${BASE}/api/photo?id=cccccccc-cccc-4ccc-8ccc-cccccccccccc`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { photo: { handle: string; createdAt: string; citySlug: string | null } };
    expect(body.photo.handle).toBe("sky-meta");
    expect(body.photo.createdAt).toBeTruthy();
    expect(body.photo.citySlug).toBe("bucharest-romania");

    const bad = await SELF.fetch(`${BASE}/api/photo?id=nope`);
    expect(bad.status).toBe(404);
  });
});
