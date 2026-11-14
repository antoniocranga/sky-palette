import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import type { CitiesResponse } from "../../src/shared/types";
import { geocodingPlace, geocoderHandler, mockUpstream, testEnv } from "./helpers";

const BASE = "https://skypalette.test";

async function cityCount(): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM cities").first<{ count: number }>();
  return row?.count ?? 0;
}

async function insertCity(slug: string, name: string, lat: number, lon: number): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO cities (slug, name, country, country_code, admin1, lat, lon, timezone, population, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(slug, name, "United States", "US", "Illinois", lat, lon, "America/Chicago", 100_000, new Date().toISOString())
    .run();
}

describe("GET /api/cities", () => {
  it("maps the geocoder into the shared City contract and caches it in D1", async () => {
    mockUpstream(
      geocoderHandler([
        geocodingPlace(),
        geocodingPlace({
          id: 683844,
          name: "Cluj-Napoca",
          latitude: 46.7712,
          longitude: 23.6236,
          admin1: "Cluj",
          population: 321_687,
        }),
      ]),
    );

    const response = await SELF.fetch(`${BASE}/api/cities?q=Bucharest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
    expect(response.headers.get("x-cities-source")).toBe("open-meteo");

    const body = (await response.json()) as CitiesResponse;
    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      slug: "bucharest-romania",
      name: "Bucharest",
      country: "Romania",
      countryCode: "RO",
      admin1: "Bucharest",
      timezone: "Europe/Bucharest",
    });
    expect(body.results[0]?.lat).toBeCloseTo(44.432, 3);
    expect(body.results[1]?.slug).toBe("cluj-napoca-romania");
    expect(await cityCount()).toBe(2);

    // A second identical search must not duplicate rows.
    const second = await SELF.fetch(`${BASE}/api/cities?q=Bucharest`);
    expect(second.status).toBe(200);
    expect(await cityCount()).toBe(2);
  });

  it("disambiguates a slug already owned by a different place", async () => {
    // Springfield, Missouri already owns the plain slug.
    await insertCity("springfield-united-states", "Springfield", 37.208, -93.292);
    mockUpstream(
      geocoderHandler([
        geocodingPlace({
          id: 4250542,
          name: "Springfield",
          latitude: 39.799,
          longitude: -89.644,
          country: "United States",
          country_code: "US",
          admin1: "Illinois",
          timezone: "America/Chicago",
        }),
      ]),
    );

    const response = await SELF.fetch(`${BASE}/api/cities?q=Springfield`);
    const body = (await response.json()) as CitiesResponse;
    expect(body.results[0]?.slug).toBe("springfield-united-states-illinois");
  });

  it("falls back to the database when the geocoder is down", async () => {
    await insertCity("springfield-united-states", "Springfield", 37.208, -93.292);
    await insertCity("springfield-united-states-illinois", "Springfield", 39.799, -89.644);
    await insertCity("denver-united-states", "Denver", 39.7, -105.0);

    mockUpstream((url) =>
      url.hostname === "geocoding-api.open-meteo.com" ? new Response("down", { status: 502 }) : null,
    );

    const response = await SELF.fetch(`${BASE}/api/cities?q=Spring`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-cities-source")).toBe("database");

    const body = (await response.json()) as CitiesResponse;
    expect(body.results.map((city) => city.name)).toEqual(["Springfield", "Springfield"]);
  });

  it("returns an empty list when nothing matches and the geocoder is down", async () => {
    mockUpstream((url) =>
      url.hostname === "geocoding-api.open-meteo.com" ? new Response("down", { status: 500 }) : null,
    );

    const response = await SELF.fetch(`${BASE}/api/cities?q=Atlantis`);
    const body = (await response.json()) as CitiesResponse;
    expect(body.success).toBe(true);
    expect(body.results).toEqual([]);
  });

  it("rejects queries shorter than two characters", async () => {
    const response = await SELF.fetch(`${BASE}/api/cities?q=B`);
    expect(response.status).toBe(400);
  });

  it("rejects queries longer than eighty characters", async () => {
    const response = await SELF.fetch(`${BASE}/api/cities?q=${"a".repeat(81)}`);
    expect(response.status).toBe(400);
  });

  it("rejects a missing query", async () => {
    const response = await SELF.fetch(`${BASE}/api/cities`);
    expect(response.status).toBe(400);
  });

  it("strips control characters before validating", async () => {
    mockUpstream(geocoderHandler([geocodingPlace()]));
    const response = await SELF.fetch(`${BASE}/api/cities?q=%00Bu%0Acharest`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CitiesResponse;
    expect(body.results).toHaveLength(1);
  });

  it("survives a geocoder payload with missing fields", async () => {
    mockUpstream(geocoderHandler([{ name: "Nowhere" }, geocodingPlace()]));
    const response = await SELF.fetch(`${BASE}/api/cities?q=Now`);
    const body = (await response.json()) as CitiesResponse;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.country).toBe("Romania");
  });
});
