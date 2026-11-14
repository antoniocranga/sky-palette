import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { escapeHtml, isIsoDay, normaliseHex } from "../../src/worker/routes/og";

const BASE = "https://skypalette.test";

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("OG input validation", () => {
  it("accepts only real calendar days", () => {
    expect(isIsoDay("2026-11-14")).toBe(true);
    expect(isIsoDay("2024-02-29")).toBe(true);
    expect(isIsoDay("2026-02-28")).toBe(true);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("2026-13-01")).toBe(false);
    expect(isIsoDay("2026-00-10")).toBe(false);
    expect(isIsoDay("2026-99-99")).toBe(false);
    expect(isIsoDay("2026-11-14 ")).toBe(false);
    expect(isIsoDay("14-11-2026")).toBe(false);
    expect(isIsoDay("")).toBe(false);
  });

  it("still renders when the date is impossible", async () => {
    const response = await SELF.fetch(`${BASE}/api/og?city=Bucharest&date=2026-99-99`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
  });

  it("truncates over-long text and strips control characters", async () => {
    const city = "A".repeat(400) + "\u0000\n\t<script>alert(1)</script>";
    const response = await SELF.fetch(
      `${BASE}/api/og?city=${encodeURIComponent(city)}&phase=${encodeURIComponent("X".repeat(200))}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("rejects colours that are not plain hex", () => {
    for (const hostile of [
      "red",
      "#12345",
      "#1234567",
      "expression(alert(1))",
      "#fff;background:url(//evil.test)",
      "url(//evil.test)",
      "#FFF url(x)",
      "rgb(0,0,0)",
      "#gggggg",
      "&#35;fff",
    ]) {
      expect(normaliseHex(hostile)).toBeNull();
    }
    expect(normaliseHex("#0B1024")).toBe("#0B1024");
    expect(normaliseHex("  abc  ")).toBe("#AABBCC");
    expect(normaliseHex("#AbCdEf")).toBe("#ABCDEF");
  });

  it("escapes markup injected through city and phase", async () => {
    const city = `<svg onload="alert(1)"><style>*{}</style></svg>`;
    const phase = `"><img src=x onerror=alert(1)>`;
    const response = await SELF.fetch(
      `${BASE}/api/og?city=${encodeURIComponent(city)}&phase=${encodeURIComponent(phase)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
  });

  it("escapes every metacharacter exactly once", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(escapeHtml("Backslash \\ and ${template} survive")).toBe(
      "Backslash \\ and ${template} survive",
    );
  });

  it("rejects out-of-range coordinates and absurd timezones", async () => {
    expect((await SELF.fetch(`${BASE}/api/og?lon=181`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/og?lat=-91`)).status).toBe(400);

    const longZone = "A".repeat(200);
    const response = await SELF.fetch(
      `${BASE}/api/og?city=Bucharest&tz=${encodeURIComponent(longZone)}`,
    );
    // An unknown/long zone falls back to UTC instead of reaching Intl with junk.
    expect(response.status).toBe(200);
  });
});
