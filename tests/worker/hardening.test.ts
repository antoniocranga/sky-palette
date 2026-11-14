/**
 * Launch hardening checks that are easy to lose: polyglot uploads must never be
 * served as executable content, and unsupported containers stay rejected.
 */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { fileFrom, jpegFixture, mockUpstream, openMeteoHandler, submissionForm } from "./helpers";

const BASE = "https://skypalette.test";

describe("upload hardening", () => {
  it("serves a polyglot JPEG as an inert image, never as HTML", async () => {
    mockUpstream(openMeteoHandler());
    const jpeg = jpegFixture(1200, 800);
    const payload = new Uint8Array([...jpeg, ...new TextEncoder().encode("<script>alert(1)</script>")]);

    const response = await SELF.fetch(`${BASE}/api/submit`, {
      method: "POST",
      body: submissionForm({ photo: fileFrom(payload, "polyglot.jpg", "image/jpeg") }),
      headers: { "cf-connecting-ip": "203.0.113.180" },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string };

    const photo = await SELF.fetch(body.url);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(photo.headers.get("content-disposition")).toBe("inline");
    expect(photo.headers.get("content-security-policy")).toBeNull();
  });

  it("rejects SVG even when it claims to be a supported type", async () => {
    mockUpstream(openMeteoHandler());
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const response = await SELF.fetch(`${BASE}/api/submit`, {
      method: "POST",
      body: submissionForm({ photo: fileFrom(svg, "sky.png", "image/png") }),
      headers: { "cf-connecting-ip": "203.0.113.181" },
    });
    expect(response.status).toBe(415);
  });
});
