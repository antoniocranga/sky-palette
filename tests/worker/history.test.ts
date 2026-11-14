import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { addDays, isoDayInZone } from "../../src/shared/time";
import type { HistoryResponse } from "../../src/shared/types";
import { hourlyPayload, jsonBody, mockUpstream, openMeteoHandler, testEnv } from "./helpers";

const BASE = "https://skypalette.test";
const LAT = 44.4268;
const LON = 26.1025;
const TZ = "Europe/Bucharest";

function today(): string {
  return isoDayInZone(new Date(), TZ);
}

async function history(query: string): Promise<HistoryResponse> {
  const response = await SELF.fetch(`${BASE}/api/history?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as HistoryResponse;
}

describe("GET /api/history", () => {
  it("computes one palette per local sunset, newest first", async () => {
    mockUpstream(openMeteoHandler());

    const body = await history(`lat=${LAT}&lon=${LON}&days=3&tz=${TZ}`);
    expect(body.success).toBe(true);
    expect(body.location).toEqual({ lat: LAT, lon: LON });
    expect(body.cached).toBe(false);
    expect(body.days).toHaveLength(3);

    const expectedDates = [0, -1, -2].map((offset) => addDays(today(), offset));
    expect(body.days.map((day) => day.date)).toEqual(expectedDates);

    for (const day of body.days) {
      expect(day.sunset).toMatch(/^\d{2}:\d{2}$/);
      expect(day.colors).toHaveLength(5);
      for (const colour of day.colors) expect(colour).toMatch(/^#[0-9A-F]{6}$/);
      expect(typeof day.phase).toBe("string");
      expect(day.weatherCode).toBe(1);
    }

    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM daily_palettes").first<{ count: number }>();
    expect(row?.count).toBe(3);
  });

  it("serves the second request from D1 and reports cached", async () => {
    mockUpstream(openMeteoHandler());
    await history(`lat=48.2082&lon=16.3738&days=2&tz=Europe/Vienna`);

    const response = await SELF.fetch(`${BASE}/api/history?lat=48.2082&lon=16.3738&days=2&tz=Europe/Vienna`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-history-source")).toBe("database");

    const body = (await response.json()) as HistoryResponse;
    expect(body.cached).toBe(true);
    expect(body.days).toHaveLength(2);
  });

  it("only fetches the dates that are missing from the cache", async () => {
    const ranges: Array<{ start: string | null; end: string | null }> = [];
    mockUpstream((url) => {
      if (!url.hostname.includes("open-meteo")) return null;
      ranges.push({ start: url.searchParams.get("start_date"), end: url.searchParams.get("end_date") });
      return openMeteoHandler()(url, new Request(url));
    });

    await history(`lat=41.3874&lon=2.1686&days=3&tz=Europe/Madrid`);
    expect(ranges.length).toBeGreaterThan(0);

    ranges.length = 0;
    await history(`lat=41.3874&lon=2.1686&days=5&tz=Europe/Madrid`);

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.start).toBe(addDays(today(), -4));
    expect(ranges[0]?.end).toBe(addDays(today(), -3));
  });

  it("degrades to clear-sky palettes when the upstream is unavailable", async () => {
    mockUpstream((url) => (url.hostname.includes("open-meteo") ? new Response("down", { status: 503 }) : null));

    const response = await SELF.fetch(`${BASE}/api/history?lat=35.6762&lon=139.6503&days=2&tz=Asia/Tokyo`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-history-source")).toBe("fallback");

    const body = (await response.json()) as HistoryResponse;
    expect(body.cached).toBe(false);
    expect(body.days).toHaveLength(2);
    for (const day of body.days) {
      expect(day.weatherCode).toBe(0);
      expect(day.colors).toHaveLength(5);
    }

    // Degraded days are not cached, so a retry can still fetch real weather.
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM daily_palettes").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("reports a null sunset during polar night", async () => {
    mockUpstream(openMeteoHandler());
    const body = await history(`lat=78.2232&lon=15.6267&days=2&tz=Arctic/Longyearbyen`);

    expect(body.days).toHaveLength(2);
    for (const day of body.days) {
      expect(day.sunset).toBeNull();
      expect(["Dusk", "Night"]).toContain(day.phase);
      expect(day.colors).toHaveLength(5);
    }
  });

  it("falls back per day when the upstream range has gaps", async () => {
    const todayDate = isoDayInZone(new Date(), "UTC");
    mockUpstream((url) => {
      if (!url.hostname.includes("open-meteo")) return null;
      return jsonBody(hourlyPayload(todayDate, todayDate));
    });

    const response = await SELF.fetch(`${BASE}/api/history?lat=52.52&lon=13.405&days=3&tz=Europe/Berlin`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-history-source")).toBe("fallback");

    const body = (await response.json()) as HistoryResponse;
    expect(body.days).toHaveLength(3);
    expect(body.days[0]?.weatherCode).toBe(1);
    expect(body.days[1]?.weatherCode).toBe(0);
    expect(body.days[2]?.weatherCode).toBe(0);

    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM daily_palettes").first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("rejects an out-of-range day count", async () => {
    for (const days of ["0", "31", "2.5"]) {
      const response = await SELF.fetch(`${BASE}/api/history?days=${days}`);
      expect(response.status, `days=${days}`).toBe(400);
    }
  });

  it("rejects an invalid timezone", async () => {
    const response = await SELF.fetch(`${BASE}/api/history?tz=Mars/Olympus_Mons`);
    expect(response.status).toBe(400);
  });

  it("accepts a missing timezone and defaults to UTC", async () => {
    mockUpstream((url) => (url.hostname.includes("open-meteo") ? jsonBody({ hourly: { time: [] } }) : null));
    const response = await SELF.fetch(`${BASE}/api/history?lat=10&lon=10&days=1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as HistoryResponse;
    expect(body.days).toHaveLength(1);
  });
});
