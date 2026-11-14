/** Nearest-city lookup used to autofill the location from photo GPS. */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { testEnv } from "./helpers";

const BASE = "https://skypalette.test";

async function seed(slug: string, name: string, lat: number, lon: number, country = "Romania"): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO cities (slug, name, country, country_code, admin1, lat, lon, timezone, population, updated_at)
     VALUES (?, ?, ?, 'RO', NULL, ?, ?, 'Europe/Bucharest', 1000, ?)`,
  )
    .bind(slug, name, country, lat, lon, new Date().toISOString())
    .run();
}

describe("GET /api/location", () => {
  it("returns the nearest cached city within the radius", async () => {
    await seed("bucharest-romania", "Bucharest", 44.4268, 26.1025);
    await seed("otopeni-romania", "Otopeni", 44.55, 26.06);

    const response = await SELF.fetch(`${BASE}/api/location?lat=44.44&lon=26.10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      match: { city: { slug: string; name: string }; distanceKm: number } | null;
    };
    expect(body.success).toBe(true);
    expect(body.match?.city.slug).toBe("bucharest-romania");
    expect(body.match?.distanceKm).toBeLessThan(5);
  });

  it("returns null when nothing is within 100 km", async () => {
    await seed("bucharest-romania", "Bucharest", 44.4268, 26.1025);

    const response = await SELF.fetch(`${BASE}/api/location?lat=35.68&lon=139.69`);
    const body = (await response.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  it("handles missing coordinates without failing", async () => {
    const response = await SELF.fetch(`${BASE}/api/location`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { match: unknown; reason: string };
    expect(body.match).toBeNull();
    expect(body.reason).toBe("missing_coordinates");
  });

  it("rejects coordinates outside the valid range", async () => {
    const response = await SELF.fetch(`${BASE}/api/location?lat=120&lon=0`);
    expect(response.status).toBe(400);
  });

  it("prefers the closer of two nearby cities", async () => {
    await seed("a-romania", "A", 44.4, 26.1);
    await seed("b-romania", "B", 44.5, 26.1);

    const response = await SELF.fetch(`${BASE}/api/location?lat=44.49&lon=26.1`);
    const body = (await response.json()) as { match: { city: { slug: string } } };
    expect(body.match.city.slug).toBe("b-romania");
  });
});
