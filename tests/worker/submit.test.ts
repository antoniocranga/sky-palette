import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import type { Palette, SubmissionResponse } from "../../src/shared/types";
import {
  fileFrom,
  jpegFixture,
  jsonBody,
  mockUpstream,
  openMeteoHandler,
  pngFixture,
  submissionForm,
  testEnv,
  webpFixture,
  withEnvVar,
} from "./helpers";

const BASE = "https://skypalette.test";

interface SubmitResult {
  response: Response;
  body: SubmissionResponse;
}

async function submit(form: FormData, ip = "203.0.113.10"): Promise<SubmitResult> {
  const response = await SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    body: form,
    headers: { "cf-connecting-ip": ip },
  });
  const text = await response.text();
  return { response, body: JSON.parse(text) as SubmissionResponse };
}

function keyFromUrl(url: string | null): string {
  if (!url) throw new Error("expected a photo url");
  const path = new URL(url).pathname;
  return decodeURIComponent(path.replace(/^\/api\/photos\//, ""));
}

describe("POST /api/submit", () => {
  it("stores a stripped photo and returns a handle", async () => {
    mockUpstream(openMeteoHandler());

    const { response, body } = await submit(
      submissionForm({
        photo: fileFrom(jpegFixture(1200, 800), "my-sky.jpg", "image/jpeg"),
      }),
    );

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.handle).toMatch(/^sky-bucharest-[0-9a-f]{4}$/);
    expect(body.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toContain("/api/photos/photos/");

    const key = keyFromUrl(body.url);
    expect(key).toMatch(/^photos\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);

    const stored = await testEnv.PHOTOS.get(key);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");

    const storedText = new TextDecoder("latin1").decode(await stored?.arrayBuffer());
    expect(storedText).not.toContain("Exif GPS");

    const row = await testEnv.DB.prepare("SELECT * FROM submissions WHERE id = ?")
      .bind(body.submissionId)
      .first<Record<string, unknown>>();

    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.width).toBe(1200);
    expect(row?.height).toBe(800);
    expect(row?.city_slug).toBe("bucharest-romania");
    expect(row?.content_type).toBe("image/jpeg");
    expect(row?.r2_key).toBe(key);
    expect(String(row?.ip_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row?.ip_hash)).not.toContain("203.0.113.10");
    expect(Number(row?.bytes)).toBeGreaterThan(0);

    const palette = JSON.parse(String(row?.palette_json)) as Palette;
    expect(palette.zenith).toMatch(/^#[0-9A-F]{6}$/);
    expect(["Golden Hour", "Sunset"]).toContain(palette.phase);
  });

  it("accepts PNG and WebP uploads", async () => {
    mockUpstream(openMeteoHandler());

    const png = await submit(submissionForm({ photo: fileFrom(pngFixture(), "sky.png", "image/png") }), "203.0.113.11");
    expect(png.response.status).toBe(201);
    expect(png.body.url).toMatch(/\.png$/);

    // The declared MIME type is irrelevant: the container is sniffed.
    const webp = await submit(
      submissionForm({ photo: fileFrom(webpFixture(), "sky.png", "image/png") }),
      "203.0.113.12",
    );
    expect(webp.response.status).toBe(201);
    expect(webp.body.url).toMatch(/\.webp$/);
  });

  it("rejects a declared body larger than 30 MB before buffering it", async () => {
    // The cap is enforced from Content-Length first, so an oversized upload is
    // refused without allocating the payload in the isolate.
    const response = await SELF.fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=----sky",
        "content-length": String(31 * 1024 * 1024),
        "cf-connecting-ip": "203.0.113.13",
      },
      body: "--x--",
    });

    expect(response.status).toBe(413);
    const body = await response.json() as { success: boolean };
    expect(body.success).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a file that is not an image", async () => {
    const gif = new TextEncoder().encode("GIF89a-not-really-an-image");
    const { response } = await submit(
      submissionForm({ photo: fileFrom(gif, "sky.gif", "image/gif") }),
      "203.0.113.14",
    );
    expect(response.status).toBe(415);
  });

  it("rejects a corrupt image whose magic bytes lie", async () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x33]);
    const { response } = await submit(
      submissionForm({ photo: fileFrom(broken, "broken.jpg", "image/jpeg") }),
      "203.0.113.15",
    );
    expect(response.status).toBe(400);
  });

  it("rejects an image below the 400px short side", async () => {
    mockUpstream(openMeteoHandler());
    const { response } = await submit(
      submissionForm({ photo: fileFrom(jpegFixture(1200, 300), "thin.jpg", "image/jpeg") }),
      "203.0.113.16",
    );
    expect(response.status).toBe(422);
  });

  it("rejects a submission without a photo", async () => {
    const { response } = await submit(submissionForm({ photo: null }), "203.0.113.17");
    expect(response.status).toBe(400);
  });

  it("rejects missing or invalid coordinates", async () => {
    mockUpstream(openMeteoHandler());
    for (const overrides of [{ lat: null }, { lon: null }, { lat: "200" }, { lat: "abc" }]) {
      const { response } = await submit(submissionForm(overrides), `203.0.113.2${Math.random()}`);
      expect(response.status, JSON.stringify(overrides)).toBe(400);
    }
  });

  it("rejects an invalid capture time", async () => {
    mockUpstream(openMeteoHandler());
    for (const capturedAt of [null, "yesterday", "1850-01-01T00:00:00Z"]) {
      const { response } = await submit(submissionForm({ capturedAt }), `203.0.113.3${Math.random()}`);
      expect(response.status, String(capturedAt)).toBe(400);
    }
  });

  it("rejects an invalid city slug", async () => {
    mockUpstream(openMeteoHandler());
    const { response } = await submit(submissionForm({ citySlug: "Bucharest; DROP TABLE" }), "203.0.113.40");
    expect(response.status).toBe(400);
  });

  it("verifies Turnstile when a secret is configured", async () => {
    const captured: { form: FormData | null } = { form: null };
    await withEnvVar("TURNSTILE_SECRET_KEY", "test-secret", async () => {
      mockUpstream(async (url, request) => {
        if (url.hostname === "challenges.cloudflare.com") {
          captured.form = await request.formData();
          return jsonBody({ success: true });
        }
        return openMeteoHandler()(url, request);
      });

      const { response, body } = await submit(
        submissionForm({ turnstileToken: "valid-token" }),
        "203.0.113.50",
      );
      expect(response.status).toBe(201);
      expect(body.status).toBe("pending");
      expect(JSON.stringify(body)).not.toContain("test-secret");
    });

    expect(captured.form).not.toBeNull();
    expect(captured.form?.get("response")).toBe("valid-token");
    expect(captured.form?.get("secret")).toBe("test-secret");
    expect(captured.form?.get("remoteip")).toBe("203.0.113.50");
  });

  it("rejects a failed Turnstile challenge with 403", async () => {
    await withEnvVar("TURNSTILE_SECRET_KEY", "test-secret", async () => {
      mockUpstream((url) =>
        url.hostname === "challenges.cloudflare.com"
          ? jsonBody({ success: false, "error-codes": ["invalid-input-response"] })
          : null,
      );

      const { response, body } = await submit(submissionForm({ turnstileToken: "bad-token" }), "203.0.113.51");
      expect(response.status).toBe(403);
      expect(JSON.stringify(body)).not.toContain("invalid-input-response");
    });
  });

  it("answers 503 when Siteverify itself is unreachable", async () => {
    await withEnvVar("TURNSTILE_SECRET_KEY", "test-secret", async () => {
      mockUpstream((url) => (url.hostname === "challenges.cloudflare.com" ? new Response("boom", { status: 500 }) : null));

      const { response } = await submit(submissionForm({ turnstileToken: "any" }), "203.0.113.52");
      expect(response.status).toBe(503);
    });
  });

  it("allows the check to be skipped when no secret is provisioned", async () => {
    mockUpstream(openMeteoHandler());
    expect(testEnv.TURNSTILE_SECRET_KEY).toBeUndefined();

    const { response } = await submit(submissionForm({ turnstileToken: null }), "203.0.113.53");
    expect(response.status).toBe(201);
  });

  it("limits each client to five uploads per hour", async () => {
    mockUpstream(openMeteoHandler());
    const ip = "198.51.100.77";

    for (let index = 0; index < 5; index += 1) {
      const { response } = await submit(submissionForm(), ip);
      expect(response.status, `upload ${index + 1}`).toBe(201);
    }

    const blocked = await submit(submissionForm(), ip);
    expect(blocked.response.status).toBe(429);
    const retryAfter = Number(blocked.response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);

    // A different client is unaffected.
    const other = await submit(submissionForm(), "198.51.100.78");
    expect(other.response.status).toBe(201);
  });

  it("returns a sanitised error for an unparseable body", async () => {
    const response = await SELF.fetch(`${BASE}/api/submit`, {
      method: "POST",
      body: "not multipart",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.60" },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Expected multipart/form-data");
  });
});
