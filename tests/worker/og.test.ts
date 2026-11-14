import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { escapeHtml, normaliseHex } from "../../src/worker/routes/og";

const BASE = "https://skypalette.test";

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("GET /api/og", () => {
  it("renders a 1200x630 PNG with a day of cache", async () => {
    const response = await SELF.fetch(
      `${BASE}/api/og?city=Bucharest&date=2026-11-14&phase=Sunset&zenith=%230B1024&midsky=%2333507A&horizon=%23C9734A&sunglow=%23FFAE5C&cloudtint=%23FFC59C`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
  });

  it("computes the palette when colours are absent", async () => {
    const response = await SELF.fetch(`${BASE}/api/og?city=Cluj-Napoca&date=2026-06-21&lat=46.77&lon=23.62`);
    expect(response.status).toBe(200);

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    expect(pngSize(bytes).width).toBe(1200);
  });

  it("survives hostile text and invalid colours", async () => {
    const response = await SELF.fetch(
      `${BASE}/api/og?city=${encodeURIComponent('<script>alert("x")</script>')}&phase=${encodeURIComponent('"><img src=x onerror=alert(1)>')}&zenith=%22red`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("rejects an out-of-range latitude", async () => {
    const response = await SELF.fetch(`${BASE}/api/og?lat=999`);
    expect(response.status).toBe(400);
  });
});

describe("OG helpers", () => {
  it("escapes every HTML metacharacter", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("accepts only valid hex colours", () => {
    expect(normaliseHex("#0b1024")).toBe("#0B1024");
    expect(normaliseHex("0B1024")).toBe("#0B1024");
    expect(normaliseHex("#abc")).toBe("#AABBCC");
    expect(normaliseHex("red")).toBeNull();
    expect(normaliseHex("#12345")).toBeNull();
    expect(normaliseHex(null)).toBeNull();
  });
});
