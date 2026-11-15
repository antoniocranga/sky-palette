/**
 * Test helpers: upstream mocking, image fixtures and request builders.
 *
 * Upstream HTTP is intercepted by replacing `globalThis.fetch` for the duration
 * of a test. The worker runs in the same isolate as the tests, so it sees the
 * patched global; nothing ever reaches the network.
 */

import { afterEach } from "vitest";
import { env } from "cloudflare:test";

type UpstreamHandler = (
  url: URL,
  request: Request,
) => Response | null | Promise<Response | null>;

const UPSTREAM_HOSTS = ["open-meteo.com", "challenges.cloudflare.com"];
const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

export function mockUpstream(handler: UpstreamHandler): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : String(input), init);
    const url = new URL(request.url);
    const isUpstream = UPSTREAM_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    if (isUpstream) {
      const response = await handler(url, request);
      // An unmatched upstream call fails loudly instead of touching the network.
      return response ?? new Response("unmocked upstream", { status: 404 });
    }
    return original(input as RequestInfo, init);
  }) as unknown as typeof fetch;

  restorers.push(() => {
    globalThis.fetch = original;
  });
}

export function jsonBody(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Hourly Open-Meteo payload with one entry every three hours per day. */
export function hourlyPayload(startDate: string, endDate: string): Record<string, unknown> {
  const times: string[] = [];
  const day = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  while (day.getTime() <= end.getTime()) {
    const date = day.toISOString().slice(0, 10);
    for (const hour of [0, 3, 6, 9, 12, 15, 18, 21]) {
      times.push(`${date}T${String(hour).padStart(2, "0")}:00`);
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }

  return {
    hourly: {
      time: times,
      cloud_cover_low: times.map(() => 18),
      cloud_cover_mid: times.map(() => 12),
      cloud_cover_high: times.map(() => 32),
      visibility: times.map(() => 22_000),
      weather_code: times.map(() => 1),
    },
  };
}

/** Mock handler that answers every Open-Meteo request for the asked range. */
export function openMeteoHandler(): UpstreamHandler {
  return (url) => {
    if (!url.hostname.includes("open-meteo")) return null;
    const start = url.searchParams.get("start_date");
    const end = url.searchParams.get("end_date");
    if (!start || !end) return jsonBody({ hourly: { time: [] } });
    return jsonBody(hourlyPayload(start, end));
  };
}

export function geocoderHandler(results: unknown[]): UpstreamHandler {
  return (url) => {
    if (url.hostname !== "geocoding-api.open-meteo.com") return null;
    return jsonBody({ results });
  };
}

export const geocodingPlace = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 683506,
  name: "Bucharest",
  latitude: 44.43225,
  longitude: 26.10626,
  country: "Romania",
  country_code: "RO",
  admin1: "Bucharest",
  timezone: "Europe/Bucharest",
  population: 1_877_155,
  ...overrides,
});

/* ------------------------------------------------------------------ */
/* Image fixtures                                                      */
/* ------------------------------------------------------------------ */

function u16be(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** A structurally valid JPEG with an EXIF APP1 segment and a comment. */
export function jpegFixture(width = 800, height = 600, marker = "Exif GPS 44.4268,26.1025"): Uint8Array {
  const app1Body = [...ascii(marker), 0x00];
  const app1 = [0xff, 0xe1, ...u16be(app1Body.length + 2), ...app1Body];
  const commentBody = ascii("camera serial 12345");
  const comment = [0xff, 0xfe, ...u16be(commentBody.length + 2), ...commentBody];
  const sof = [
    0xff,
    0xc0,
    ...u16be(17),
    0x08,
    ...u16be(height),
    ...u16be(width),
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  const sos = [0xff, 0xda, ...u16be(8), 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const scan = [0x12, 0x34, 0x56, 0x78];

  return new Uint8Array([
    0xff,
    0xd8,
    ...app1,
    ...comment,
    ...sof,
    ...sos,
    ...scan,
    0xff,
    0xd9,
  ]);
}

function pngChunk(type: string, payload: number[]): number[] {
  return [...u32be(payload.length), ...ascii(type), ...payload, 0x00, 0x00, 0x00, 0x00];
}

/** A PNG with an IHDR, a tEXt chunk and an IDAT. */
export function pngFixture(width = 800, height = 600, text = "Author\u0000sky photographer"): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", [...u32be(width), ...u32be(height), 0x08, 0x06, 0x00, 0x00, 0x00]);
  const textChunk = pngChunk("tEXt", ascii(text));
  const idat = pngChunk("IDAT", [0x78, 0x9c, 0x01, 0x02, 0x03]);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...signature, ...ihdr, ...textChunk, ...idat, ...iend]);
}

function riffChunk(fourcc: string, payload: number[]): number[] {
  const padding = payload.length % 2 === 1 ? [0x00] : [];
  return [...ascii(fourcc), ...u32le(payload.length), ...payload, ...padding];
}

/** A WebP with a VP8X header (EXIF flag set), an EXIF chunk and a VP8L image. */
export function webpFixture(width = 800, height = 600): Uint8Array {
  const flags = [0x08, 0x00, 0x00, 0x00]; // EXIF present
  const canvas = [
    (width - 1) & 0xff,
    ((width - 1) >> 8) & 0xff,
    ((width - 1) >> 16) & 0xff,
    (height - 1) & 0xff,
    ((height - 1) >> 8) & 0xff,
    ((height - 1) >> 16) & 0xff,
  ];
  const vp8x = riffChunk("VP8X", [...flags, ...canvas]);
  const exif = riffChunk("EXIF", ascii("GPS 44.4268,26.1025"));
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const vp8l = riffChunk("VP8L", [0x2f, ...u32le(bits >>> 0)]);

  const chunks = [...vp8x, ...exif, ...vp8l];
  const size = 4 + chunks.length; // "WEBP" + chunks
  return new Uint8Array([...ascii("RIFF"), ...u32le(size), ...ascii("WEBP"), ...chunks]);
}

export function fileFrom(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes], name, { type });
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export interface SubmissionOverrides {
  photo?: File | null;
  lat?: string | null;
  lon?: string | null;
  capturedAt?: string | null;
  turnstileToken?: string | null;
  consent?: string | null;
  citySlug?: string | null;
}

export function submissionForm(overrides: SubmissionOverrides = {}): FormData {
  const form = new FormData();
  const fields: Array<[string, string | File | null]> = [
    ["lat", overrides.lat === undefined ? "44.4268" : overrides.lat],
    ["lon", overrides.lon === undefined ? "26.1025" : overrides.lon],
    ["capturedAt", overrides.capturedAt === undefined ? "2026-11-14T14:51:00.000Z" : overrides.capturedAt],
    ["turnstileToken", overrides.turnstileToken === undefined ? "test-token" : overrides.turnstileToken],
    ["consent", overrides.consent === undefined ? "true" : overrides.consent],
    ["citySlug", overrides.citySlug === undefined ? "bucharest-romania" : overrides.citySlug],
  ];
  for (const [key, value] of fields) {
    if (value !== null) form.set(key, value);
  }

  const photo =
    overrides.photo === undefined
      ? fileFrom(jpegFixture(), "sky.jpg", "image/jpeg")
      : overrides.photo;
  if (photo) form.set("photo", photo);

  return form;
}

export interface TestEnv {
  DB: D1Database;
  PHOTOS: R2Bucket;
  IP_SALT?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
}

export const testEnv = env as unknown as TestEnv;

/**
 * This version of the plugin shares storage across the tests in a file, so
 * every test starts from an explicit clean slate rather than relying on
 * per-test isolation.
 */
afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM submissions"),
    testEnv.DB.prepare("DELETE FROM daily_palettes"),
    testEnv.DB.prepare("DELETE FROM cities"),
    testEnv.DB.prepare("DELETE FROM rate_limits"),
  ]);

  const listed = await testEnv.PHOTOS.list();
  if (listed.objects.length > 0) {
    await testEnv.PHOTOS.delete(listed.objects.map((object) => object.key));
  }
});

/** Runs a callback with a temporary binding value, restoring it afterwards. */
export async function withEnvVar(name: string, value: unknown, run: () => Promise<void>): Promise<void> {
  const bindings = env as unknown as Record<string, unknown>;
  const previous = bindings[name];
  bindings[name] = value;
  try {
    await run();
  } finally {
    bindings[name] = previous;
  }
}
