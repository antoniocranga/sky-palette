/** Nearest-city lookup used to autofill the location from photo GPS. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { jsonBody, mockUpstream, testEnv } from "./helpers";

const BASE = "https://skypalette.test";
const CONSTANTA = { lat: 44.1598, lon: 28.6348 };
const MURFATLAR = { lat: 44.183, lon: 28.417 };

async function seed(slug: string, name: string, lat: number, lon: number, country = "Romania"): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO cities (slug, name, country, country_code, admin1, lat, lon, timezone, population, updated_at)
     VALUES (?, ?, ?, 'RO', NULL, ?, ?, 'Europe/Bucharest', 1000, ?)`,
  )
    .bind(slug, name, country, lat, lon, new Date().toISOString())
    .run();
}

interface LocationBody {
  success: boolean;
  match: { city: { slug: string; name: string; timezone: string }; distanceKm: number } | null;
}

async function locate(lat: number, lon: number): Promise<LocationBody> {
  const response = await SELF.fetch(`${BASE}/api/location?lat=${lat}&lon=${lon}`);
  return (await response.json()) as LocationBody;
}

function nominatim(city: string, countryCode = "ro"): void {
  mockUpstream((url) => {
    if (url.hostname === "nominatim.openstreetmap.org") {
      return jsonBody({
        name: city,
        address: { city, country_code: countryCode },
      });
    }
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonBody({
        results: [
          {
            name: city,
            latitude: CONSTANTA.lat,
            longitude: CONSTANTA.lon,
            country: "Romania",
            country_code: "RO",
            admin1: "Constanța County",
            timezone: "Europe/Bucharest",
            population: 283872,
          },
        ],
      });
    }
    return null;
  });
}

describe("GET /api/location", () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("DELETE FROM geo_cache").run();
    await testEnv.DB.prepare("DELETE FROM cities").run();
  });

  it("returns a cached city that is already on top of the coordinate", async () => {
    await seed("bucharest-romania", "Bucharest", 44.4268, 26.1025);
    const upstream = vi.fn();
    mockUpstream((url) => {
      upstream(url.hostname);
      return null;
    });

    const body = await locate(44.4269, 26.1026);
    expect(body.match?.city.slug).toBe("bucharest-romania");
    expect(body.match?.distanceKm).toBeLessThan(1);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reverse geocodes instead of trusting a distant cached town", async () => {
    await seed("murfatlar-romania", "Murfatlar", MURFATLAR.lat, MURFATLAR.lon);
    nominatim("Constanța");

    const body = await locate(CONSTANTA.lat, CONSTANTA.lon);
    expect(body.match?.city.name).toBe("Constanța");
    expect(body.match?.city.timezone).toBe("Europe/Bucharest");
    expect(body.match?.city.slug).toBe("constanta-romania");
    expect(body.match?.distanceKm).toBeLessThan(1);
  });

  it("serves the reverse result from D1 on the next upload", async () => {
    await seed("murfatlar-romania", "Murfatlar", MURFATLAR.lat, MURFATLAR.lon);
    nominatim("Constanța");
    await locate(CONSTANTA.lat, CONSTANTA.lon);

    const upstream = vi.fn();
    mockUpstream((url) => {
      upstream(url.hostname);
      return null;
    });
    const cached = await locate(CONSTANTA.lat, CONSTANTA.lon);
    expect(cached.match?.city.name).toBe("Constanța");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns no match rather than a town 18 km away when the geocoder is down", async () => {
    await seed("murfatlar-romania", "Murfatlar", MURFATLAR.lat, MURFATLAR.lon);
    mockUpstream(() => new Response("upstream down", { status: 503 }));

    const body = await locate(CONSTANTA.lat, CONSTANTA.lon);
    expect(body.match).toBeNull();
  });

  it("falls back to a very close cached city when the geocoder fails", async () => {
    await seed("otopeni-romania", "Otopeni", 44.55, 26.06);
    mockUpstream(() => new Response("upstream down", { status: 503 }));

    const body = await locate(44.552, 26.062);
    expect(body.match?.city.slug).toBe("otopeni-romania");
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

    const body = await locate(44.49, 26.1);
    expect(body.match?.city.slug).toBe("b-romania");
  });
});
