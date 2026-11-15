/**
 * Tiny, defensive EXIF GPS reader. No dependency and no throwing: malformed,
 * truncated or absurd metadata simply yields null.
 */

export interface GpsCoordinates {
  lat: number;
  lon: number;
}

const JPEG_SIGNATURE = [0xff, 0xd8] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) if (bytes[offset + i] !== signature[i]) return false;
  return true;
}

/** Parse GPS from a JPEG, PNG or WebP byte buffer. Never throws. */
export function parseExifGps(bytes: Uint8Array): GpsCoordinates | null {
  try {
    if (startsWith(bytes, JPEG_SIGNATURE)) return jpegGps(bytes);
    if (startsWith(bytes, PNG_SIGNATURE)) return pngGps(bytes);
    if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return webpGps(bytes);
  } catch {
    return null;
  }
  return null;
}

export async function readExifGps(file: File): Promise<GpsCoordinates | null> {
  try {
    const buffer = await file.arrayBuffer();
    return parseExifGps(new Uint8Array(buffer));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Containers                                                                 */
/* -------------------------------------------------------------------------- */

function jpegGps(bytes: Uint8Array): GpsCoordinates | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1] ?? 0;
    offset += 2;
    while (marker === 0xff && offset < bytes.length) {
      marker = bytes[offset] ?? 0;
      offset += 1;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker < 0xd0 || marker > 0xd8) {
      const length = u16be(bytes, offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (marker === 0xe1) {
        const start = offset + 2;
        if (startsWith(bytes, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00], start)) {
          return parseTiff(bytes.subarray(start + 6, offset + length));
        }
      }
      offset += length;
    }
  }
  return null;
}

function pngGps(bytes: Uint8Array): GpsCoordinates | null {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const typeOffset = offset + 4;
    if (length > bytes.length - typeOffset - 8) return null;
    const type = String.fromCharCode(
      bytes[typeOffset] ?? 0,
      bytes[typeOffset + 1] ?? 0,
      bytes[typeOffset + 2] ?? 0,
      bytes[typeOffset + 3] ?? 0,
    );
    if (type === "eXIf") return parseTiff(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") return null;
    offset += 12 + length;
  }
  return null;
}

function webpGps(bytes: Uint8Array): GpsCoordinates | null {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const length = u32le(bytes, offset + 4);
    const start = offset + 8;
    if (length > bytes.length - start) return null;
    if (type === "EXIF") {
      const exif = bytes.subarray(start, start + length);
      return parseTiff(startsWith(exif, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) ? exif.subarray(6) : exif);
    }
    offset = start + length + (length % 2);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* TIFF / GPS                                                                 */
/* -------------------------------------------------------------------------- */

function parseTiff(tiff: Uint8Array): GpsCoordinates | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const magic = readU16(tiff, 2, little);
  if (magic !== 42) return null;
  const ifd0 = readU32(tiff, 4, little);
  const gpsIfd = findGpsIfd(tiff, ifd0, little);
  if (gpsIfd === null) return null;

  const count = readU16(tiff, gpsIfd, little);
  if (count <= 0 || count > 512) return null;
  let lat: number | null = null;
  let lon: number | null = null;
  let latRef: string | null = null;
  let lonRef: string | null = null;

  for (let index = 0; index < count; index += 1) {
    const entry = gpsIfd + 2 + index * 12;
    if (entry + 12 > tiff.length) return null;
    const tag = readU16(tiff, entry, little);
    const type = readU16(tiff, entry + 2, little);
    const valueCount = readU32(tiff, entry + 4, little);
    if (tag === 0x0001 || tag === 0x0003) {
      const text = readAscii(tiff, entry + 8, type, valueCount, little);
      if (tag === 0x0001) latRef = text;
      else lonRef = text;
    } else if (tag === 0x0002 || tag === 0x0004) {
      const value = readCoordinate(tiff, entry + 8, type, valueCount, little);
      if (tag === 0x0002) lat = value;
      else lon = value;
    }
  }

  if (lat === null || lon === null) return null;
  if (latRef === "S") lat = -lat;
  if (lonRef === "W") lon = -lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: round(lat, 6), lon: round(lon, 6) };
}

function findGpsIfd(tiff: Uint8Array, ifdOffset: number, little: boolean): number | null {
  if (ifdOffset + 2 > tiff.length) return null;
  const count = readU16(tiff, ifdOffset, little);
  if (count > 1024) return null;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > tiff.length) return null;
    if (readU16(tiff, entry, little) === 0x8825) {
      const type = readU16(tiff, entry + 2, little);
      const valueCount = readU32(tiff, entry + 4, little);
      if (type !== 4 || valueCount !== 1) return null;
      return readU32(tiff, entry + 8, little);
    }
  }
  return null;
}

function readCoordinate(
  tiff: Uint8Array,
  valueField: number,
  type: number,
  count: number,
  little: boolean,
): number | null {
  if ((type !== 5 && type !== 10) || count !== 3) return null;
  const offset = readU32(tiff, valueField, little);
  if (offset + 24 > tiff.length) return null;
  let total = 0;
  for (let index = 0; index < 3; index += 1) {
    const position = offset + index * 8;
    const numerator = type === 10 ? readI32(tiff, position, little) : readU32(tiff, position, little);
    const denominator = type === 10 ? readI32(tiff, position + 4, little) : readU32(tiff, position + 4, little);
    if (denominator === 0) return null;
    total += numerator / denominator / (index === 0 ? 1 : index === 1 ? 60 : 3600);
  }
  return Number.isFinite(total) ? total : null;
}

function readAscii(
  tiff: Uint8Array,
  valueField: number,
  type: number,
  count: number,
  little: boolean,
): string | null {
  if (type !== 2 || count === 0 || count > 32) return null;
  const offset = count <= 4 ? valueField : readU32(tiff, valueField, little);
  if (offset + count > tiff.length) return null;
  let text = "";
  for (let index = 0; index < count; index += 1) {
    const code = tiff[offset + index] ?? 0;
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text.toUpperCase();
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) * 0x1000000 + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0)) >>> 0);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return ((((bytes[offset + 3] ?? 0) << 24) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0)) >>> 0);
}

function readU16(bytes: Uint8Array, offset: number, little: boolean): number {
  if (offset + 2 > bytes.length) return 0;
  return little ? (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) : u16be(bytes, offset);
}

function readU32(bytes: Uint8Array, offset: number, little: boolean): number {
  if (offset + 4 > bytes.length) return 0;
  return little ? u32le(bytes, offset) : u32be(bytes, offset);
}

function readI32(bytes: Uint8Array, offset: number, little: boolean): number {
  const value = readU32(bytes, offset, little);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
