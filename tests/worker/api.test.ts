import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import type { ConfigResponse, PaletteResponse } from "../../src/shared/types";
import { jsonBody, mockUpstream, openMeteoHandler, withEnvVar } from "./helpers";

const BASE = "https://skypalette.test";

describe("GET /api/health", () => {
  it("reports a healthy database", async () => {
    const response = await SELF.fetch(`${BASE}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.database).toBe(true);
    expect(typeof body.requestId).toBe("string");
  });
});

describe("GET /api/palette", () => {
  it("returns a five-swatch palette for a point and instant", async () => {
    mockUpstream(openMeteoHandler());

    const response = await SELF.fetch(
      `${BASE}/api/palette?lat=44.4268&lon=26.1025&tz=Europe/Bucharest&at=2026-06-21T17:00:00Z`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("public");

    const body = (await response.json()) as PaletteResponse;
    expect(body.success).toBe(true);
    expect(body.location).toEqual({ lat: 44.4268, lon: 26.1025, timezone: "Europe/Bucharest" });
    expect(body.at).toBe("2026-06-21T17:00:00.000Z");
    for (const key of ["zenith", "midsky", "horizon", "sunglow", "cloudtint"] as const) {
      expect(body.palette[key]).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(body.palette.gradientCss).toContain(body.palette.zenith);
    expect(body.weather.weatherCode).toBe(1);
    expect(body.cached).toBe(false);
    expect(body.requestId).toBeTruthy();
  });

  it("degrades to clear-sky defaults when the upstream fails", async () => {
    mockUpstream((url) => (url.hostname.includes("open-meteo") ? new Response("nope", { status: 503 }) : null));

    const response = await SELF.fetch(`${BASE}/api/palette?lat=12.34&lon=56.78&at=2026-02-01T04:00:00Z`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-weather-source")).toBe("fallback");

    const body = (await response.json()) as PaletteResponse;
    expect(body.success).toBe(true);
    expect(body.palette.phase).toBe("Afternoon");
    expect(body.weather.visibility).toBe(20_000);
  });

  it("rejects out-of-range coordinates", async () => {
    const response = await SELF.fetch(`${BASE}/api/palette?lat=91&lon=0`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("out of range");
  });

  it("rejects an invalid timestamp", async () => {
    const response = await SELF.fetch(`${BASE}/api/palette?at=not-a-date`);
    expect(response.status).toBe(400);
  });
});

describe("GET /api/config", () => {
  it("exposes the public site key and never the secret", async () => {
    const response = await SELF.fetch(`${BASE}/api/config`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as ConfigResponse & Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body).toHaveProperty("turnstileSiteKey");
    expect(body.appUrl).toMatch(/^https?:\/\//);
    expect(typeof body.version).toBe("string");
    expect(JSON.stringify(body)).not.toContain("TURNSTILE_SECRET_KEY");
  });

  it("reads a configured site key at runtime", async () => {
    await withEnvVar("TURNSTILE_SITE_KEY", "0x4AAAAAAAtest", async () => {
      const response = await SELF.fetch(`${BASE}/api/config`);
      const body = (await response.json()) as ConfigResponse;
      expect(body.turnstileSiteKey).toBe("0x4AAAAAAAtest");
    });
  });
});

describe("router", () => {
  it("returns 404 for an unknown API path", async () => {
    const response = await SELF.fetch(`${BASE}/api/does-not-exist`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unknown API endpoint");
  });

  it("returns 405 with an Allow header for the wrong method", async () => {
    const response = await SELF.fetch(`${BASE}/api/palette`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("does not allow GET on the submission endpoint", async () => {
    const response = await SELF.fetch(`${BASE}/api/submit`);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("never leaks an upstream error body", async () => {
    mockUpstream(() => jsonBody({ error: "internal upstream detail" }, 500));
    const response = await SELF.fetch(`${BASE}/api/cities?q=Cluj`);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("internal upstream detail");
  });
});
