import { describe, expect, it } from "vitest";
import {
  assertMaximumDimensions,
  assertMinimumDimensions,
  ImageError,
  inspectImage,
  MIN_SHORT_SIDE,
  MAX_DIMENSION,
  stripMetadata,
} from "../../src/worker/lib/image";
import { jpegFixture, pngFixture, webpFixture } from "./helpers";

const text = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);

describe("image inspection", () => {
  it("reads JPEG dimensions from the frame header", () => {
    const info = inspectImage(jpegFixture(1024, 768));
    expect(info).toMatchObject({ format: "jpeg", contentType: "image/jpeg", extension: "jpg", width: 1024, height: 768 });
    expect(info.shortSide).toBe(768);
  });

  it("reads PNG dimensions from IHDR", () => {
    const info = inspectImage(pngFixture(1200, 900));
    expect(info).toMatchObject({ format: "png", contentType: "image/png", width: 1200, height: 900 });
  });

  it("reads WebP dimensions from VP8X", () => {
    const info = inspectImage(webpFixture(640, 480));
    expect(info).toMatchObject({ format: "webp", contentType: "image/webp", width: 640, height: 480 });
  });

  it("reads WebP dimensions from a VP8L image when there is no VP8X", () => {
    const bytes = webpFixture(500, 700);
    const vp8xEnd = 12 + 8 + 10;
    const withoutVp8x = new Uint8Array([...bytes.slice(0, 12), ...bytes.slice(vp8xEnd)]);
    const size = withoutVp8x.length - 8;
    new DataView(withoutVp8x.buffer).setUint32(4, size, true);

    const info = inspectImage(withoutVp8x);
    expect(info.width).toBe(500);
    expect(info.height).toBe(700);
  });

  it("rejects unrecognised containers", () => {
    const gif = new TextEncoder().encode("GIF89a0000000000");
    expect(() => inspectImage(gif)).toThrow(ImageError);
  });

  it("rejects a JPEG with no frame header", () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(() => inspectImage(broken)).toThrow(ImageError);
  });

  it("enforces the minimum short side", () => {
    const small = inspectImage(jpegFixture(1200, MIN_SHORT_SIDE - 1));
    expect(() => assertMinimumDimensions(small)).toThrow(ImageError);
    expect(() => assertMinimumDimensions(inspectImage(jpegFixture(1200, MIN_SHORT_SIDE)))).not.toThrow();
  });

  it("rejects absurd header dimensions", () => {
    const huge = inspectImage(jpegFixture(MAX_DIMENSION + 1, 1200));
    expect(() => assertMaximumDimensions(huge)).toThrow(ImageError);
    expect(() => assertMinimumDimensions(huge)).not.toThrow();
    expect(() => assertMaximumDimensions(inspectImage(jpegFixture(MAX_DIMENSION, 1200)))).not.toThrow();
  });

  it("rejects images above the pixel budget even when each side is legal", () => {
    const bomb = inspectImage(jpegFixture(9_000, 5_000));
    expect(bomb.width).toBeLessThanOrEqual(MAX_DIMENSION);
    expect(() => assertMaximumDimensions(bomb)).toThrow(/megapixels/);
  });
});

describe("metadata stripping", () => {
  it("drops JPEG APP1 and COM segments but keeps the image structure", () => {
    const original = jpegFixture(800, 600);
    expect(text(original)).toContain("Exif GPS");

    const cleaned = stripMetadata(original, "jpeg");
    const asText = text(cleaned);

    expect(asText).not.toContain("Exif GPS");
    expect(asText).not.toContain("camera serial");
    expect(cleaned[0]).toBe(0xff);
    expect(cleaned[1]).toBe(0xd8);
    expect(cleaned[cleaned.length - 1]).toBe(0xd9);
    expect(cleaned.length).toBeLessThan(original.length);

    // Dimensions survive the rewrite.
    expect(inspectImage(cleaned).width).toBe(800);
  });

  it("drops PNG text chunks", () => {
    const original = pngFixture(800, 600);
    expect(text(original)).toContain("sky photographer");

    const cleaned = stripMetadata(original, "png");
    expect(text(cleaned)).not.toContain("sky photographer");
    expect(text(cleaned)).toContain("IHDR");
    expect(text(cleaned)).toContain("IDAT");
    expect(text(cleaned)).toContain("IEND");
    expect(inspectImage(cleaned).width).toBe(800);
  });

  it("drops WebP EXIF, clears the VP8X flag and fixes the RIFF size", () => {
    const original = webpFixture(800, 600);
    expect(text(original)).toContain("EXIF");

    const cleaned = stripMetadata(original, "webp");
    expect(text(cleaned)).not.toContain("EXIF");
    expect(text(cleaned)).not.toContain("GPS 44.4268");

    const riffSize = new DataView(cleaned.buffer).getUint32(4, true);
    expect(riffSize).toBe(cleaned.length - 8);

    // VP8X flags byte: EXIF bit cleared, chunk still present.
    const vp8xPayload = 12 + 8;
    expect(cleaned[vp8xPayload] ?? 0).toBe(0);
    expect(inspectImage(cleaned).width).toBe(800);
  });

  it("is idempotent", () => {
    const once = stripMetadata(jpegFixture(), "jpeg");
    const twice = stripMetadata(once, "jpeg");
    expect(Array.from(twice)).toEqual(Array.from(once));
  });
});
