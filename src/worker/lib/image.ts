/**
 * Server-side image validation and metadata stripping.
 *
 * Photos arrive from anonymous browsers, so nothing about them is trusted:
 * the container is identified from magic bytes (never the declared MIME type),
 * dimensions are read from the container headers, and every metadata block that
 * could carry a camera serial or a GPS fix is removed before the bytes reach R2.
 *
 * Supported: JPEG, PNG, WebP. Everything else is rejected upstream of this file.
 */

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  contentType: string;
  extension: string;
  width: number;
  height: number;
  /** Short side in pixels — used for the minimum-dimension gate. */
  shortSide: number;
}

export class ImageError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "corrupt" | "too_small" | "too_large",
  ) {
    super(message);
    this.name = "ImageError";
  }
}

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

const FORMAT_META: Record<ImageFormat, { contentType: string; extension: string }> = {
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
  png: { contentType: "image/png", extension: "png" },
  webp: { contentType: "image/webp", extension: "webp" },
};

export const MIN_SHORT_SIDE = 400;
/** Rejects decompression-bomb sized headers before any decoding happens. */
export const MAX_DIMENSION = 12_000;
/** 40 MP ceiling: a 12000×12000 header is still a bomb even if each side passes. */
export const MAX_PIXELS = 40_000_000;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset + 3] ?? 0) * 0x1000000 +
      ((bytes[offset + 2] ?? 0) << 16) +
      ((bytes[offset + 1] ?? 0) << 8) +
      (bytes[offset] ?? 0)) >>>
    0
  );
}

/** Reads the container and its dimensions. Throws ImageError when unusable. */
export function inspectImage(bytes: Uint8Array): ImageInfo {
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    const dimensions = jpegDimensions(bytes);
    return buildInfo("jpeg", dimensions.width, dimensions.height);
  }
  if (startsWith(bytes, PNG_SIGNATURE)) {
    const dimensions = pngDimensions(bytes);
    return buildInfo("png", dimensions.width, dimensions.height);
  }
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) {
    const dimensions = webpDimensions(bytes);
    return buildInfo("webp", dimensions.width, dimensions.height);
  }
  throw new ImageError("Unsupported image format", "unsupported");
}

function buildInfo(format: ImageFormat, width: number, height: number): ImageInfo {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new ImageError("Image has no readable dimensions", "corrupt");
  }
  const meta = FORMAT_META[format];
  return {
    format,
    contentType: meta.contentType,
    extension: meta.extension,
    width,
    height,
    shortSide: Math.min(width, height),
  };
}

/** Rejects images whose short side is below the submission floor. */
export function assertMinimumDimensions(info: ImageInfo, minimum = MIN_SHORT_SIDE): void {
  if (info.shortSide < minimum) {
    throw new ImageError(`Image must be at least ${minimum}px on the short side`, "too_small");
  }
}

/** Rejects absurd header dimensions that would be a decode bomb downstream. */
export function assertMaximumDimensions(info: ImageInfo, maximum = MAX_DIMENSION, maxPixels = MAX_PIXELS): void {
  if (info.width > maximum || info.height > maximum) {
    throw new ImageError(`Image must be at most ${maximum}px on each side`, "too_large");
  }
  if (info.width * info.height > maxPixels) {
    throw new ImageError(`Image must be at most ${Math.round(maxPixels / 1_000_000)} megapixels`, "too_large");
  }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = u16be(bytes, offset + 2);
    if (length < 2) break;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame && offset + 8 < bytes.length) {
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  throw new ImageError("JPEG has no frame header", "corrupt");
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || !startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12)) {
    throw new ImageError("PNG has no IHDR chunk", "corrupt");
  }
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const size = u32le(bytes, offset + 4);
    const data = offset + 8;
    if (fourcc === "VP8X" && data + 10 <= bytes.length) {
      const width = 1 + ((bytes[data + 4] ?? 0) | ((bytes[data + 5] ?? 0) << 8) | ((bytes[data + 6] ?? 0) << 16));
      const height = 1 + ((bytes[data + 7] ?? 0) | ((bytes[data + 8] ?? 0) << 8) | ((bytes[data + 9] ?? 0) << 16));
      return { width, height };
    }
    if (fourcc === "VP8 " && data + 10 <= bytes.length) {
      if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) break;
      const width = u16be(bytes, data + 6) & 0x3fff;
      const height = u16be(bytes, data + 8) & 0x3fff;
      return { width, height };
    }
    if (fourcc === "VP8L" && data + 5 <= bytes.length) {
      if (bytes[data] !== 0x2f) break;
      const bits = u32le(bytes, data + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    offset = data + size + (size % 2);
  }
  throw new ImageError("WebP has no image chunk", "corrupt");
}

/**
 * Removes identifying metadata in place of the original bytes.
 *
 * JPEG: APP1 (EXIF/XMP), APP13 (IPTC) and COM segments.
 * PNG:  eXIf, tEXt, iTXt, zTXt and tIME chunks.
 * WebP: EXIF and XMP chunks, with the RIFF size and VP8X flags corrected.
 *
 * Entropy-coded pixel data is copied byte-for-byte, so the image is unchanged
 * visually and stays a valid file of the same format.
 */
export function stripMetadata(bytes: Uint8Array, format: ImageFormat): Uint8Array {
  switch (format) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    case "webp":
      return stripWebp(bytes);
  }
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Not a marker boundary: keep the remainder and stop parsing.
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }
    const marker = bytes[offset + 1] ?? 0;

    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }
    if (marker === 0xda) {
      // Start of scan: everything after this point is compressed image data.
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
      chunks.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = u16be(bytes, offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) {
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }

    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) chunks.push(bytes.subarray(offset, end));
    offset = end;
  }

  return concat(chunks);
}

const PNG_DROPPED_CHUNKS = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

function stripPng(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      chunks.push(bytes.subarray(offset));
      return concat(chunks);
    }
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    if (!PNG_DROPPED_CHUNKS.has(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") return concat(chunks);
  }

  return concat(chunks);
}

const WEBP_DROPPED_CHUNKS = new Set(["EXIF", "XMP "]);
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_XMP = 0x04;

function stripWebp(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const size = u32le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) break;

    if (!WEBP_DROPPED_CHUNKS.has(fourcc)) {
      let payload = bytes.subarray(dataStart, dataEnd);
      if (fourcc === "VP8X" && payload.length >= 1) {
        const copy = payload.slice();
        copy[0] = (copy[0] ?? 0) & ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP);
        payload = copy;
      }
      const chunk = new Uint8Array(8 + size + (size % 2));
      chunk.set(bytes.subarray(offset, offset + 4), 0);
      const view = new DataView(chunk.buffer);
      view.setUint32(4, size, true);
      chunk.set(payload, 8);
      chunks.push(chunk);
    }

    offset = dataEnd + (size % 2);
  }

  const body = concat(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 4), 0); // "RIFF"
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  out.set(bytes.subarray(8, 12), 8); // "WEBP"
  out.set(body, 12);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
