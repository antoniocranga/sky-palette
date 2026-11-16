import { describe, expect, it } from "vitest";
import { parseExifCapture, parseExifGps } from "../../../src/client/lib/exif";

const BUCHAREST = { lat: 44.4268, lon: 26.1025 };

function buildTiff(little: boolean, lat = BUCHAREST.lat, lon = BUCHAREST.lon, withGps = true): Uint8Array {
  const bytes = new Uint8Array(withGps ? 128 : 26);
  const view = new DataView(bytes.buffer);
  const setU16 = (offset: number, value: number) => view.setUint16(offset, value, little);
  const setU32 = (offset: number, value: number) => view.setUint32(offset, value, little);
  bytes[0] = little ? 0x49 : 0x4d;
  bytes[1] = little ? 0x49 : 0x4d;
  setU16(2, 42);
  setU32(4, 8);

  const ifd0 = 8;
  setU16(ifd0, withGps ? 1 : 0);
  if (withGps) {
    const entry = ifd0 + 2;
    setU16(entry, 0x8825);
    setU16(entry + 2, 4);
    setU32(entry + 4, 1);
    setU32(entry + 8, 26);
    setU32(ifd0 + 14, 0);
    const gps = 26;
    setU16(gps, 4);
    const ref = (offset: number, text: string) => {
      bytes[offset] = text.charCodeAt(0);
      bytes[offset + 1] = 0;
    };
    const gpsEntry = (index: number, tag: number, type: number, count: number, valueField: number) => {
      const entryOffset = gps + 2 + index * 12;
      setU16(entryOffset, tag);
      setU16(entryOffset + 2, type);
      setU32(entryOffset + 4, count);
      setU32(entryOffset + 8, valueField);
    };
    gpsEntry(0, 0x0001, 2, 2, 0);
    ref(gps + 2 + 8, "N");
    gpsEntry(1, 0x0002, 5, 3, 80);
    gpsEntry(2, 0x0003, 2, 2, 0);
    ref(gps + 2 + 24 + 8, "E");
    gpsEntry(3, 0x0004, 5, 3, 104);
    setU32(gps + 2 + 48, 0);

    const rational = (offset: number, value: number) => {
      const degrees = Math.floor(value);
      const minutesFloat = (value - degrees) * 60;
      const minutes = Math.floor(minutesFloat);
      const seconds = Math.round((minutesFloat - minutes) * 60 * 100);
      const values = [
        [degrees, 1],
        [minutes, 1],
        [seconds, 100],
      ];
      values.forEach(([numerator, denominator], index) => {
        setU32(offset + index * 8, numerator ?? 0);
        setU32(offset + index * 8 + 4, denominator ?? 1);
      });
    };
    rational(80, Math.abs(lat));
    rational(104, Math.abs(lon));
  } else {
    setU32(ifd0 + 2, 0);
  }
  return bytes;
}

function jpegWith(tiff: Uint8Array): Uint8Array {
  const app1 = new Uint8Array(10 + tiff.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = ((app1.length - 2) >> 8) & 0xff;
  app1[3] = (app1.length - 2) & 0xff;
  app1.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  app1.set(tiff, 10);
  return new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xd9]);
}

function pngWith(tiff: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + tiff.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, tiff.length);
  chunk.set([0x65, 0x58, 0x49, 0x66], 4);
  chunk.set(tiff, 8);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk]);
}

function webpWith(tiff: Uint8Array): Uint8Array {
  const padded = tiff.length + (tiff.length % 2);
  const bytes = new Uint8Array(12 + 8 + padded);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x45, 0x58, 0x49, 0x46], 12);
  new DataView(bytes.buffer).setUint32(16, tiff.length, true);
  bytes.set(tiff, 20);
  return bytes;
}

describe("EXIF GPS parser", () => {
  it("reads JPEG GPS in little-endian TIFF", () => {
    const gps = parseExifGps(jpegWith(buildTiff(true)));
    expect(gps?.lat).toBeCloseTo(BUCHAREST.lat, 4);
    expect(gps?.lon).toBeCloseTo(BUCHAREST.lon, 4);
  });

  it("reads JPEG GPS in big-endian TIFF", () => {
    const gps = parseExifGps(jpegWith(buildTiff(false)));
    expect(gps?.lat).toBeCloseTo(BUCHAREST.lat, 4);
    expect(gps?.lon).toBeCloseTo(BUCHAREST.lon, 4);
  });

  it("returns null for JPEG without GPS", () => {
    expect(parseExifGps(jpegWith(buildTiff(true, 0, 0, false)))).toBeNull();
  });

  it("returns null for a truncated APP1 segment", () => {
    const jpeg = jpegWith(buildTiff(true));
    expect(parseExifGps(jpeg.subarray(0, 18))).toBeNull();
  });

  it("reads PNG eXIf GPS", () => {
    const gps = parseExifGps(pngWith(buildTiff(true)));
    expect(gps?.lat).toBeCloseTo(BUCHAREST.lat, 4);
    expect(gps?.lon).toBeCloseTo(BUCHAREST.lon, 4);
  });

  it("reads WebP EXIF GPS", () => {
    const gps = parseExifGps(webpWith(buildTiff(false)));
    expect(gps?.lat).toBeCloseTo(BUCHAREST.lat, 4);
    expect(gps?.lon).toBeCloseTo(BUCHAREST.lon, 4);
  });

  it("rejects absurd coordinates instead of throwing", () => {
    expect(parseExifGps(jpegWith(buildTiff(true, 123.4, 200.5)))).toBeNull();
  });

  it("never throws on random bytes", () => {
    expect(() => parseExifGps(new Uint8Array([1, 2, 3, 4, 5]))).not.toThrow();
    expect(parseExifGps(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });
});

function buildDateTiff(text: string): Uint8Array {
  const ascii = new TextEncoder().encode(text.slice(0, 19) + "\0");
  const bytes = new Uint8Array(44 + ascii.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  // IFD0: one entry, Exif IFD pointer at 26.
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8769, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint32(22, 0, true);
  // Exif IFD: one entry, DateTimeOriginal pointing at 44.
  view.setUint16(26, 1, true);
  view.setUint16(28, 0x9003, true);
  view.setUint16(30, 2, true);
  view.setUint32(32, ascii.length, true);
  view.setUint32(36, 44, true);
  view.setUint32(40, 0, true);
  bytes.set(ascii, 44);
  return bytes;
}

describe("EXIF capture time parser", () => {
  it("reads DateTimeOriginal from a JPEG", () => {
    const capture = parseExifCapture(jpegWith(buildDateTiff("2026:11:10 18:42:00")));
    expect(capture.takenAt).toEqual({ date: "2026-11-10", hours: 18, minutes: 42 });
    expect(capture.gps).toBeNull();
  });

  it("reads the same instant from PNG and WebP", () => {
    const tiff = buildDateTiff("2026:11:10 18:42:00");
    expect(parseExifCapture(pngWith(tiff)).takenAt?.date).toBe("2026-11-10");
    expect(parseExifCapture(webpWith(tiff)).takenAt?.hours).toBe(18);
  });

  it("ignores impossible dates", () => {
    expect(parseExifCapture(jpegWith(buildDateTiff("1888:01:01 00:00:00"))).takenAt).toBeNull();
  });
});
