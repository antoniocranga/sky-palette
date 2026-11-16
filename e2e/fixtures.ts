import { test as base, expect, type Page, type Route } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { computePalette } from "../src/shared/palette";
import { getSolarPosition, getSunTimes } from "../src/shared/solar";
import { addDays, clockInZone, isoDayInZone, zonedTimeToUtc } from "../src/shared/time";
import type {
  CitiesResponse,
  City,
  DayPalette,
  GalleryPhoto,
  HistoryResponse,
  PaletteResponse,
  SubmissionResponse,
} from "../src/shared/types";

/**
 * Deterministic API fixtures. Every /api/** call is fulfilled here, and the
 * Turnstile script is stubbed locally, so the suite never touches the network.
 */

const CITIES: City[] = [
  {
    slug: "bucharest-romania",
    name: "Bucharest",
    country: "Romania",
    countryCode: "RO",
    admin1: "Bucharest",
    lat: 44.4268,
    lon: 26.1025,
    timezone: "Europe/Bucharest",
    population: 1_883_425,
  },
  {
    slug: "tokyo-japan",
    name: "Tokyo",
    country: "Japan",
    countryCode: "JP",
    admin1: "Tokyo",
    lat: 35.6762,
    lon: 139.6503,
    timezone: "Asia/Tokyo",
    population: 13_960_000,
  },
  {
    slug: "paris-france",
    name: "Paris",
    country: "France",
    countryCode: "FR",
    admin1: "Île-de-France",
    lat: 48.8566,
    lon: 2.3522,
    timezone: "Europe/Paris",
    population: 2_161_000,
  },
  {
    slug: "reykjavik-iceland",
    name: "Reykjavik",
    country: "Iceland",
    countryCode: "IS",
    admin1: "Capital Region",
    lat: 64.1466,
    lon: -21.9426,
    timezone: "Atlantic/Reykjavik",
    population: 139_875,
  },
  {
    slug: "buenos-aires-argentina",
    name: "Buenos Aires",
    country: "Argentina",
    countryCode: "AR",
    admin1: "Buenos Aires",
    lat: -34.6037,
    lon: -58.3816,
    timezone: "America/Argentina/Buenos_Aires",
    population: 3_120_000,
  },
];

const WEATHER = {
  cloudCoverLow: 22,
  cloudCoverMid: 18,
  cloudCoverHigh: 44,
  visibility: 18_000,
  weatherCode: 2,
};

export interface ApiController {
  setSubmitStatus(status: number): void;
  failPaletteOnce(): void;
  failHistoryOnce(): void;
  emptyGallery(): void;
  delayPalette(ms: number): void;
  requests: string[];
  readonly lastThumbBytes: number | null;
  readonly lastSubmitBody: string | null;
}

export const test = base.extend<{ api: ApiController }>({
  api: [
    async ({ page }, use) => {
      const state = {
        submitStatus: 200,
        paletteFailures: 0,
        historyFailures: 0,
        galleryEmpty: false,
        paletteDelay: 0,
        requests: [] as string[],
        lastSubmitBody: null as string | null,
        lastThumbBytes: null as number | null,
      };

      const controller: ApiController = {
        setSubmitStatus(status: number) {
          state.submitStatus = status;
        },
        failPaletteOnce() {
          state.paletteFailures += 1;
        },
        failHistoryOnce() {
          state.historyFailures += 1;
        },
        emptyGallery() {
          state.galleryEmpty = true;
        },
        delayPalette(ms: number) {
          state.paletteDelay = ms;
        },
        get requests() {
          return state.requests;
        },
        get lastSubmitBody() {
          return state.lastSubmitBody;
        },
        get lastThumbBytes() {
          return state.lastThumbBytes;
        },
      };

      await page.route("**/api/**", async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        state.requests.push(`${request.method()} ${url.pathname}${url.search}`);

        try {
          if (url.pathname === "/api/config") {
            await json(route, {
              success: true,
              turnstileSiteKey: "1x00000000000000000000AA",
              appUrl: "https://skypalette.app",
              version: "2.0.0",
            });
            return;
          }

          if (url.pathname === "/api/palette") {
            if (state.paletteDelay > 0) {
              await new Promise((resolve) => setTimeout(resolve, state.paletteDelay));
            }
            if (state.paletteFailures > 0) {
              state.paletteFailures -= 1;
              await json(route, { success: false, error: "Weather upstream unavailable", requestId: "req-fail" }, 503);
              return;
            }
            await json(route, paletteResponse(url));
            return;
          }

          if (url.pathname === "/api/history") {
            if (state.historyFailures > 0) {
              state.historyFailures -= 1;
              await json(route, { success: false, error: "Forecast upstream unavailable", requestId: "req-history" }, 503);
              return;
            }
            await json(route, historyResponse(url));
            return;
          }

          if (url.pathname === "/api/handles/check") {
            const handle = (url.searchParams.get("handle") ?? "").trim();
            const reserved = new Set(["sky", "admin", "support", "palette"]);
            let reason: string | undefined;
            if (handle.length < 5) reason = "too_short";
            else if (handle.length > 24) reason = "too_long";
            else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) reason = "charset";
            else if (reserved.has(handle)) reason = "reserved";
            else if (handle === "taken-tag") reason = "taken";
            await json(route, {
              success: true,
              handle,
              valid: reason !== "too_short" && reason !== "too_long" && reason !== "charset",
              available: !reason,
              ...(reason ? { reason } : {}),
            });
            return;
          }

          if (url.pathname === "/api/cities") {
            const slug = (url.searchParams.get("slug") ?? "").trim();
            if (slug) {
              const results = CITIES.filter((city) => city.slug === slug);
              const body: CitiesResponse = { success: true, results };
              await json(route, body);
              return;
            }
            const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
            const results = query.length === 0 ? [] : searchCities(query);
            const body: CitiesResponse = { success: true, results };
            await json(route, body);
            return;
          }

          if (url.pathname === "/api/location") {
            const lat = Number(url.searchParams.get("lat"));
            const lon = Number(url.searchParams.get("lon"));
            let match: { city: City; distanceKm: number } | null = null;
            for (const city of CITIES) {
              const distance = haversine(lat, lon, city.lat, city.lon);
              if (distance <= 100 && (!match || distance < match.distanceKm)) {
                match = { city, distanceKm: Math.round(distance * 10) / 10 };
              }
            }
            await json(route, { success: true, match });
            return;
          }

          if (url.pathname === "/api/photo") {
            const id = url.searchParams.get("id");
            const photo = galleryPhotos().find((item) => item.id === id) ?? null;
            await json(route, photo ? { success: true, photo } : { success: false, error: "Not found" }, photo ? 200 : 404);
            return;
          }

          if (url.pathname === "/api/gallery") {
            if (state.galleryEmpty) {
              await json(route, { success: true, photos: [], nextCursor: null });
              return;
            }
            const all = galleryPhotos();
            const cursor = url.searchParams.get("cursor");
            const limit = Math.max(1, Math.min(12, Number(url.searchParams.get("limit") ?? 6)));
            const startIndex = cursor ? all.findIndex((photo) => photo.createdAt === cursor) + 1 : 0;
            const photos = all.slice(startIndex, startIndex + limit);
            const last = photos[photos.length - 1];
            const hasMore = startIndex + photos.length < all.length;
            await json(route, { success: true, photos, nextCursor: hasMore && last ? last.createdAt : null });
            return;
          }

          if (url.pathname === "/api/submit") {
            if (state.submitStatus !== 200) {
              await json(
                route,
                {
                  success: false,
                  error: state.submitStatus === 429 ? "Rate limit exceeded" : "Submission rejected",
                  requestId: "req-submit",
                },
                state.submitStatus,
              );
              return;
            }
            const body = request.postDataBuffer();
            const text = body ? body.toString("utf8") : "";
            state.lastSubmitBody = text;
            if (body) {
              const marker = Buffer.from('name="thumb"');
              const markerIndex = body.indexOf(marker);
              if (markerIndex >= 0) {
                const start = body.indexOf(Buffer.from("\r\n\r\n"), markerIndex);
                const end = start >= 0 ? body.indexOf(Buffer.from("\r\n--"), start + 4) : -1;
                state.lastThumbBytes = start >= 0 && end > start ? end - (start + 4) : 0;
              } else {
                state.lastThumbBytes = 0;
              }
            }
            if (!text.includes("citySlug") || !text.includes("turnstileToken")) {
              await json(route, { success: false, error: "Missing fields", requestId: "req-submit" }, 400);
              return;
            }
            const response: SubmissionResponse = {
              success: true,
              submissionId: "sub-test-1",
              handle: "sky-bucharest-48b",
              status: "pending",
              url: null,
            };
            await json(route, response, 201);
            return;
          }

          await json(route, { success: false, error: "Unknown test endpoint", requestId: "req-404" }, 404);
        } catch (error) {
          console.warn("API fixture route failed", error);
          await route.abort();
        }
      });

      await page.route("https://challenges.cloudflare.com/**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: TURNSTILE_STUB,
        });
      });

      await page.route("**/photos/*.svg", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const thumb = pathname.includes("/thumb-");
        const markup = decodeURIComponent(
          photoSvg(thumb ? "#16204A" : "#101533", thumb ? "#A23E4A" : "#5C2A48", thumb ? "#E05A34" : "#A8483C").split(",")[1] ?? "",
        );
        await route.fulfill({ status: 200, contentType: "image/svg+xml", body: markup });
      });

      await use(controller);
    },
    { auto: true },
  ],
});

export { expect };

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

function cityFor(url: URL): City {
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const exact = CITIES.find((city) => Math.abs(city.lat - lat) < 0.05 && Math.abs(city.lon - lon) < 0.05);
  return exact ?? CITIES[0]!;
}

function paletteResponse(url: URL): PaletteResponse {
  const city = cityFor(url);
  const at = url.searchParams.get("at");
  const instant = at ? new Date(at) : new Date("2026-11-14T14:51:00.000Z");
  const solar = getSolarPosition(city.lat, city.lon, instant);
  const palette = computePalette({
    elevation: solar.elevation,
    cloudCoverLow: WEATHER.cloudCoverLow,
    cloudCoverMid: WEATHER.cloudCoverMid,
    cloudCoverHigh: WEATHER.cloudCoverHigh,
    visibility: WEATHER.visibility,
  });
  const times = getSunTimes(city.lat, city.lon, instant);
  return {
    success: true,
    location: { lat: city.lat, lon: city.lon, timezone: city.timezone },
    at: instant.toISOString(),
    solar,
    weather: {
      time: instant.toISOString(),
      ...WEATHER,
    },
    palette,
    sunTimes: {
      sunrise: times.sunrise?.toISOString() ?? null,
      sunset: times.sunset?.toISOString() ?? null,
      goldenHourStart: times.goldenHourStart?.toISOString() ?? null,
      goldenHourEnd: times.goldenHourEnd?.toISOString() ?? null,
    },
    cached: false,
    requestId: "req-palette",
  };
}

function historyResponse(url: URL): HistoryResponse {
  const city = cityFor(url);
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") ?? 15)));
  const today = isoDayInZone(new Date("2026-11-14T12:00:00Z"), city.timezone);
  const items: DayPalette[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(today, -offset);
    const noon = new Date(`${date}T12:00:00Z`);
    const times = getSunTimes(city.lat, city.lon, noon);
    const sunsetClock = times.sunset ? clockInZone(times.sunset, city.timezone) : null;
    const instant = sunsetClock
      ? zonedTimeToUtc(date, sunsetClock, city.timezone)
      : zonedTimeToUtc(date, "12:00", city.timezone);
    const solar = getSolarPosition(city.lat, city.lon, instant);
    const palette = computePalette({
      elevation: solar.elevation,
      cloudCoverLow: WEATHER.cloudCoverLow + (offset % 4) * 4,
      cloudCoverMid: WEATHER.cloudCoverMid,
      cloudCoverHigh: WEATHER.cloudCoverHigh - (offset % 3) * 5,
      visibility: WEATHER.visibility,
    });
    items.push({
      date,
      sunset: sunsetClock,
      phase: palette.phase,
      colors: [palette.zenith, palette.midsky, palette.horizon, palette.sunglow, palette.cloudtint],
      weatherCode: offset % 2 === 0 ? 2 : 3,
    });
  }

  return {
    success: true,
    location: { lat: city.lat, lon: city.lon },
    days: items,
    cached: false,
  };
}

function searchCities(query: string): City[] {
  const needle = query.replace(/-/g, " ");
  return CITIES.filter((city) => {
    const haystack = `${city.name} ${city.country} ${city.admin1 ?? ""} ${city.slug.replace(/-/g, " ")}`.toLowerCase();
    return haystack.includes(needle);
  }).slice(0, 8);
}

function galleryPhotos(): GalleryPhoto[] {
  return Array.from({ length: 24 }, (_, index) => {
    const minute = 51 - index;
    return {
      id: `photo-${index + 1}`,
      handle: index === 1 ? "sky-bucharest-extra8" : index % 2 === 0 ? "sky-bucharest-48b" : "sky-bucharest-7af",
      citySlug: "bucharest-romania",
      url: `/photos/full-${(index % 2) + 1}.svg`,
      thumbUrl: `/photos/thumb-${(index % 2) + 1}.svg`,
      capturedAt: `2026-11-13T14:${String(minute).padStart(2, "0")}:00.000Z`,
      createdAt: `2026-11-13T15:${String(minute).padStart(2, "0")}:00.000Z`,
      palette: computePalette({ elevation: -1.5 - index * 0.2 }),
      width: 1200,
      height: 800,
    };
  });
}

function photoSvg(top: string, middle: string, bottom: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="213"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="0.6" stop-color="${middle}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="320" height="213" fill="url(#g)"/><circle cx="160" cy="150" r="28" fill="${bottom}" opacity="0.65"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Minimal solid-colour PNG, generated locally so upload fixtures are real images. */
export function makePng(
  width: number,
  height: number,
  rgb: [number, number, number] = [120, 150, 200],
  exif?: Buffer,
): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    ...(exif ? [pngChunk("eXIf", exif)] : []),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function makePngWithGps(width: number, height: number, lat: number, lon: number): Buffer {
  return makePng(width, height, [110, 140, 190], buildGpsTiff(lat, lon));
}

/** PNG whose EXIF carries only a capture instant (no GPS). */
export function makePngWithTakenAt(width: number, height: number, takenAt: string): Buffer {
  return makePng(width, height, [120, 170, 210], buildTakenAtTiff(takenAt));
}

function buildTakenAtTiff(takenAt: string): Buffer {
  const text = Buffer.from(`${takenAt}\0`, "ascii");
  const asciiOffset = 44;
  const bytes = Buffer.alloc(asciiOffset + text.length);
  bytes.write("II", 0, "ascii");
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  // IFD0: one entry, Exif IFD pointer at 26.
  bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(0x8769, 10);
  bytes.writeUInt16LE(4, 12);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt32LE(26, 18);
  bytes.writeUInt32LE(0, 22);
  // Exif IFD: one entry, DateTimeOriginal at 44.
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(0x9003, 28);
  bytes.writeUInt16LE(2, 30);
  bytes.writeUInt32LE(text.length, 32);
  bytes.writeUInt32LE(asciiOffset, 36);
  bytes.writeUInt32LE(0, 40);
  text.copy(bytes, asciiOffset);
  return bytes;
}

function buildGpsTiff(lat: number, lon: number): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write("II", 0, "ascii");
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(0x8825, 10);
  bytes.writeUInt16LE(4, 12);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt32LE(26, 18);
  bytes.writeUInt32LE(0, 22);
  bytes.writeUInt16LE(4, 26);
  const entry = (index: number, tag: number, type: number, count: number, value: number) => {
    const offset = 28 + index * 12;
    bytes.writeUInt16LE(tag, offset);
    bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4);
    bytes.writeUInt32LE(value, offset + 8);
  };
  entry(0, 0x0001, 2, 2, 0);
  bytes.write("N\0", 36, "ascii");
  entry(1, 0x0002, 5, 3, 80);
  entry(2, 0x0003, 2, 2, 0);
  bytes.write("E\0", 60, "ascii");
  entry(3, 0x0004, 5, 3, 104);
  bytes.writeUInt32LE(0, 76);
  const rational = (offset: number, value: number) => {
    const degrees = Math.floor(value);
    const minutesFloat = (value - degrees) * 60;
    const minutes = Math.floor(minutesFloat);
    const seconds = Math.round((minutesFloat - minutes) * 60 * 100);
    [[degrees, 1], [minutes, 1], [seconds, 100]].forEach(([numerator, denominator], index) => {
      bytes.writeUInt32LE(numerator ?? 0, offset + index * 8);
      bytes.writeUInt32LE(denominator ?? 1, offset + index * 8 + 4);
    });
  };
  rational(80, Math.abs(lat));
  rational(104, Math.abs(lon));
  return bytes;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const TURNSTILE_STUB = `
window.turnstile = {
  render: function (element, options) {
    window.__turnstileOptions = options;
    window.__turnstileOptions = options;
    window.__turnstileCallback = options.callback;
    return "test-widget";
  },
  execute: function () {
    if (window.__turnstileHang) return;
    setTimeout(function () { window.__turnstileCallback && window.__turnstileCallback("test-turnstile-token"); }, 10);
  },
  reset: function () {},
  remove: function () {}
};
`;

/** Wait until the module graph has booted and the first palette is painted. */
export async function gotoHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#home-elevation")).not.toHaveText("—", { timeout: 10_000 });
}

/** Navigate to the gallery and wait for at least one tile. */
export async function gotoGallery(page: Page): Promise<void> {
  if (!page.url().startsWith("http")) await page.goto("/");
  await page.locator("#nav-btn-gallery").click();
  await expect(page.locator("#screen-gallery")).toHaveClass(/active/);
  await expect(page.locator("#day-cards-grid .day-tile").first()).toBeVisible({ timeout: 10_000 });
}

/** Open the first gallery day. */
export async function openFirstDay(page: Page): Promise<void> {
  // No positional workaround: the centre of the tile must be tappable.
  await page.locator("#day-cards-grid .day-tile").first().click();
  await expect(page.locator("#screen-detail")).toHaveClass(/active/);
  await expect(page.locator("#screen-detail")).toHaveCSS("opacity", "1");
  await expect(page.locator("#swatch-zenith")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}
