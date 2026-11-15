/** Handle validation endpoint. */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { testEnv } from "./helpers";

const BASE = "https://skypalette.test";

async function check(handle: string) {
  const response = await SELF.fetch(`${BASE}/api/handles/check?handle=${encodeURIComponent(handle)}`);
  return { status: response.status, body: (await response.json()) as { handle: string; valid: boolean; available?: boolean; reason?: string } };
}

describe("GET /api/handles/check", () => {
  it("accepts the generated shape", async () => {
    const { body } = await check("sky-bucharest-48bf");
    expect(body.valid).toBe(true);
    expect(body.handle).toBe("sky-bucharest-48bf");
  });

  it("normalises case and whitespace", async () => {
    const { body } = await check("  Sky-Tokyo-AB12  ");
    expect(body.valid).toBe(true);
    expect(body.handle).toBe("sky-tokyo-ab12");
  });

  it.each([
    ["ab", "too_short"],
    ["a".repeat(25), "too_long"],
    ["sky_bucharest", "charset"],
    ["sky bucharest", "charset"],
    ["-sky-palette", "edges"],
    ["sky-palette-", "edges"],
    ["sky--palette", "edges"],
    ["admin", "reserved"],
    ["SkyPalette", "reserved"],
  ])("rejects %s with %s", async (handle, reason) => {
    const { status, body } = await check(handle);
    expect(status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe(reason);
  });

  it("reports a handle as taken once a submission uses it", async () => {
    await testEnv.DB.prepare(
      `INSERT INTO submissions (id, city_slug, handle, r2_key, content_type, bytes, width, height,
         captured_at, lat, lon, palette_json, status, ip_hash, created_at)
       VALUES (?, 'bucharest-romania', 'sky-taken-one', 'photos/2026/11/taken.jpg', 'image/jpeg', 1, 800, 600,
         '2026-11-14T14:51:00Z', 44.4, 26.1, '{}', 'approved', 'hash', '2026-11-14T14:51:00Z')`,
    )
      .bind(crypto.randomUUID())
      .run();

    const { body } = await check("sky-taken-one");
    expect(body.valid).toBe(true);
    expect(body.available).toBe(false);
    expect(body.reason).toBe("taken");

    const free = await check("sky-free-one");
    expect(free.body.valid).toBe(true);
    expect(free.body.available).toBe(true);
  });

  it("keeps the response uncached", async () => {
    const response = await SELF.fetch(`${BASE}/api/handles/check?handle=sky-test`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
