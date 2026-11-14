/**
 * Concurrency and abuse-limit tests.
 *
 * The interesting failure mode is not "does a limiter exist" but "does it hold
 * under parallel requests". A read-then-write quota lets 20 simultaneous
 * uploads all read 0 and all pass, which is exactly how a bucket gets filled.
 * These tests fire requests in parallel and assert exact counts.
 */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { consumeQuota } from "../../src/worker/lib/rate-limit";
import { DAILY_SUBMISSION_LIMIT, HOURLY_SUBMISSION_LIMIT, MAX_UPLOAD_BYTES } from "../../src/worker/routes/submit";
import { fileFrom, jpegFixture, mockUpstream, openMeteoHandler, submissionForm, testEnv } from "./helpers";

const BASE = "https://skypalette.test";

async function submitOnce(ip: string): Promise<Response> {
  const form = submissionForm({
    photo: fileFrom(jpegFixture(1200, 800), "sky.jpg", "image/jpeg"),
  });
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    body: form,
    headers: { "cf-connecting-ip": ip },
  });
}

describe("atomic quotas", () => {
  it("allows exactly the limit under parallel increments", async () => {
    const key = `unit:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeQuota(testEnv.DB, { key, limit: 5, windowSeconds: 3600 }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
    expect(new Set(results.map((result) => result.remaining)).size).toBeGreaterThan(1);
  });

  it("separates windows and reports a retry delay", async () => {
    const key = `unit:${crypto.randomUUID()}`;
    const now = new Date("2026-11-14T12:00:00Z");
    const first = await consumeQuota(testEnv.DB, { key, limit: 1, windowSeconds: 60, now });
    const second = await consumeQuota(testEnv.DB, { key, limit: 1, windowSeconds: 60, now });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.retryAfter).toBeGreaterThan(0);
    expect(second.retryAfter).toBeLessThanOrEqual(60);

    const nextWindow = await consumeQuota(testEnv.DB, {
      key,
      limit: 1,
      windowSeconds: 60,
      now: new Date(now.getTime() + 60_000),
    });
    expect(nextWindow.allowed).toBe(true);
  });
});

describe("upload protection under load", () => {
  it(`accepts exactly ${HOURLY_SUBMISSION_LIMIT} of 20 parallel uploads from one client`, async () => {
    mockUpstream(openMeteoHandler());
    const ip = "203.0.113.201";

    const responses = await Promise.all(Array.from({ length: 20 }, () => submitOnce(ip)));
    const statuses = responses.map((response) => response.status);
    const accepted = statuses.filter((status) => status === 201);
    const limited = statuses.filter((status) => status === 429);

    expect(accepted).toHaveLength(HOURLY_SUBMISSION_LIMIT);
    expect(limited).toHaveLength(20 - HOURLY_SUBMISSION_LIMIT);
    expect(statuses.every((status) => status === 201 || status === 429)).toBe(true);

    // Storage is the thing being protected: only accepted uploads reached R2.
    const listed = await testEnv.PHOTOS.list({ prefix: "photos/" });
    expect(listed.objects).toHaveLength(HOURLY_SUBMISSION_LIMIT);

    const rows = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM submissions").first<{ count: number }>();
    expect(rows?.count).toBe(HOURLY_SUBMISSION_LIMIT);

    const limitedResponse = responses[statuses.indexOf(429)]!;
    expect(limitedResponse.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limitedResponse.headers.get("cache-control")).toBe("no-store");
    const body = (await limitedResponse.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/limit reached/i);
  });

  it("does not let one client's burst block another client", async () => {
    mockUpstream(openMeteoHandler());

    const burst = await Promise.all(Array.from({ length: 10 }, () => submitOnce("203.0.113.202")));
    expect(burst.filter((response) => response.status === 201)).toHaveLength(HOURLY_SUBMISSION_LIMIT);

    const other = await submitOnce("203.0.113.203");
    expect(other.status).toBe(201);
  });

  it("pauses all uploads when the global daily storage ceiling is reached", async () => {
    mockUpstream(openMeteoHandler());

    const dayStart = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
    await testEnv.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES ('submit:global', ?, ?)",
    )
      .bind(dayStart, DAILY_SUBMISSION_LIMIT)
      .run();

    const response = await submitOnce("203.0.113.204");
    expect(response.status).toBe(429);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/paused for today/i);

    const listed = await testEnv.PHOTOS.list({ prefix: "photos/" });
    expect(listed.objects).toHaveLength(0);
  });

  it("keeps the documented upload ceiling at 30 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(30 * 1024 * 1024);
  });
});
