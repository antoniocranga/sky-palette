import { describe, expect, it } from "vitest";
import {
  MAX_DIMENSION,
  MAX_UPLOAD_BYTES,
  MIN_SHORT_SIDE,
  detectImageFormat,
  validateImage,
} from "../../../src/client/lib/image-validation";

function header(bytes: number[]): Uint8Array {
  const out = new Uint8Array(16);
  out.set(bytes.slice(0, 16));
  return out;
}

const JPEG = header([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = header([0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const GIF = header([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const HEIC = header([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

describe("image validation", () => {
  it("detects formats from magic bytes", () => {
    expect(detectImageFormat(JPEG)).toBe("jpeg");
    expect(detectImageFormat(PNG)).toBe("png");
    expect(detectImageFormat(WEBP)).toBe("webp");
    expect(detectImageFormat(GIF)).toBeNull();
    expect(detectImageFormat(HEIC)).toBeNull();
  });

  it.each([
    ["JPEG", JPEG],
    ["PNG", PNG],
    ["WebP", WEBP],
  ])("accepts a good %s", (_label, bytes) => {
    expect(validateImage({ size: 2 * 1024 * 1024, header: bytes, width: 800, height: 600 })).toEqual({
      ok: true,
      format: detectImageFormat(bytes),
    });
  });

  it("rejects GIF and HEIC before size or dimensions", () => {
    expect(validateImage({ size: 100 * 1024 * 1024, header: GIF, width: 100, height: 100 })).toMatchObject({
      ok: false,
      code: "format",
    });
    expect(validateImage({ size: 10, header: HEIC, width: 800, height: 600 })).toMatchObject({
      ok: false,
      code: "format",
    });
  });

  it("accepts exactly 30 MB and rejects one byte over", () => {
    expect(validateImage({ size: MAX_UPLOAD_BYTES, header: JPEG, width: 800, height: 600 }).ok).toBe(true);
    const over = validateImage({ size: MAX_UPLOAD_BYTES + 1, header: JPEG, width: 800, height: 600 });
    expect(over).toEqual({
      ok: false,
      code: "size",
      message: "That photo is 30.0 MB — the limit is 30 MB.",
    });
  });

  it("accepts exactly 400 px on the short side and rejects 399", () => {
    expect(validateImage({ size: 1000, header: PNG, width: 400, height: 800 }).ok).toBe(true);
    expect(validateImage({ size: 1000, header: PNG, width: 399, height: 800 })).toEqual({
      ok: false,
      code: "dimensions",
      message: "That image is 399×800 px — it needs at least 400 px on the short side.",
    });
    expect(MIN_SHORT_SIDE).toBe(400);
  });

  it("accepts exactly 12000 px and rejects 12001", () => {
    expect(validateImage({ size: 1000, header: WEBP, width: 12_000, height: 400 }).ok).toBe(true);
    expect(validateImage({ size: 1000, header: WEBP, width: 12_001, height: 400 })).toEqual({
      ok: false,
      code: "dimensions",
      message: "That image is 12001×400 px — the maximum is 12000 px on either side.",
    });
    expect(MAX_DIMENSION).toBe(12_000);
  });

  it("uses the short side for the minimum, not the long side", () => {
    expect(validateImage({ size: 1000, header: JPEG, width: 5000, height: 300 })).toMatchObject({
      ok: false,
      code: "dimensions",
    });
  });
});
