/** Daily orphan sweep: R2 objects without a D1 row. */

import { describe, expect, it } from "vitest";
import { reapOrphans } from "../../src/worker/lib/orphans";
import { testEnv } from "./helpers";

const FUTURE = new Date(Date.now() + 25 * 60 * 60 * 1000);

async function put(key: string): Promise<void> {
  await testEnv.PHOTOS.put(key, new Uint8Array([1, 2, 3]), {
    httpMetadata: { contentType: "image/jpeg" },
  });
}

async function row(r2Key: string, thumbKey: string | null = null): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO submissions (id, city_slug, handle, r2_key, thumb_key, content_type, bytes, width, height,
       captured_at, lat, lon, palette_json, status, ip_hash, created_at)
     VALUES (?, 'bucharest-romania', 'sky-test', ?, ?, 'image/jpeg', 3, 800, 600,
       '2026-11-14T14:51:00Z', 44.4, 26.1, '{}', 'approved', 'hash', '2026-11-14T14:51:00Z')`,
  )
    .bind(crypto.randomUUID(), r2Key, thumbKey)
    .run();
}

describe("reapOrphans", () => {
  it("deletes objects without a row and keeps referenced ones", async () => {
    const kept = "photos/2026/11/kept.jpg";
    const orphan = "photos/2026/11/orphan.jpg";
    await put(kept);
    await put(orphan);
    await row(kept);

    const result = await reapOrphans(testEnv, FUTURE);

    expect(result.deleted).toBe(1);
    expect(await testEnv.PHOTOS.get(orphan)).toBeNull();
    expect(await testEnv.PHOTOS.get(kept)).not.toBeNull();
  });

  it("keeps thumbnail variants that are referenced by thumb_key", async () => {
    const full = "photos/2026/11/full.jpg";
    const thumb = "photos/2026/11/thumb-abc.webp";
    await put(full);
    await put(thumb);
    await row(full, thumb);

    const result = await reapOrphans(testEnv, FUTURE);

    expect(result.deleted).toBe(0);
    expect(await testEnv.PHOTOS.get(thumb)).not.toBeNull();
  });

  it("never deletes an object younger than the safety window", async () => {
    const young = "photos/2026/11/young.jpg";
    await put(young);

    const result = await reapOrphans(testEnv);

    expect(result.deleted).toBe(0);
    expect(result.skippedYoung).toBe(1);
    expect(await testEnv.PHOTOS.get(young)).not.toBeNull();
  });
});
