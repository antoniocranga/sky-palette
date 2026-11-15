import { describe, expect, it } from "vitest";
import { getSolarPosition, getSunTimes, phaseForElevation, BUCHAREST } from "../../src/shared/solar";
import { computePalette } from "../../src/shared/palette";
import { contrastRatio, hexToRgb, readableTextColor, relativeLuminance } from "../../src/shared/color";
import {
  addDays,
  clockInZone,
  fractionalHourInZone,
  isoDayInZone,
  parseClock,
  zonedTimeToUtc,
} from "../../src/shared/time";
import { SWATCH_LABELS, swatchesToArray, type Palette } from "../../src/shared/types";

describe("solar geometry", () => {
  it("puts the sun near its summer maximum at Bucharest solar noon", () => {
    const noon = new Date("2026-06-21T10:20:00Z");
    const pos = getSolarPosition(BUCHAREST.lat, BUCHAREST.lon, noon);
    expect(pos.elevation).toBeGreaterThan(66);
    expect(pos.elevation).toBeLessThan(70);
    expect(pos.elevation + pos.zenith).toBeCloseTo(90, 1);
  });

  it("puts the winter sun low at noon and below the horizon at midnight", () => {
    const winterNoon = getSolarPosition(BUCHAREST.lat, BUCHAREST.lon, new Date("2026-12-21T10:20:00Z"));
    expect(winterNoon.elevation).toBeGreaterThan(18);
    expect(winterNoon.elevation).toBeLessThan(25);

    const midnight = getSolarPosition(BUCHAREST.lat, BUCHAREST.lon, new Date("2026-12-21T22:00:00Z"));
    expect(midnight.elevation).toBeLessThan(-40);
    expect(midnight.zenith).toBeGreaterThan(130);
  });

  it("is near the horizon at the November sunset in Bucharest", () => {
    const pos = getSolarPosition(BUCHAREST.lat, BUCHAREST.lon, new Date("2026-11-14T14:51:00Z"));
    expect(pos.elevation).toBeGreaterThan(-2);
    expect(pos.elevation).toBeLessThan(3);
    expect(pos.azimuth).toBeGreaterThan(230);
    expect(pos.azimuth).toBeLessThan(260);
  });

  it("places sunrise in the east and sunset in the west", () => {
    const sunrise = getSolarPosition(BUCHAREST.lat, BUCHAREST.lon, new Date("2026-03-20T04:20:00Z"));
    const sunset = getSolarPosition(BUCHAREST.lat, BUCHAREST.lon, new Date("2026-03-20T16:20:00Z"));
    expect(sunrise.azimuth).toBeGreaterThan(80);
    expect(sunrise.azimuth).toBeLessThan(120);
    expect(sunset.azimuth).toBeGreaterThan(240);
    expect(sunset.azimuth).toBeLessThan(290);
  });

  it("computes sunrise and sunset within a quarter hour of published times", () => {
    const times = getSunTimes(BUCHAREST.lat, BUCHAREST.lon, new Date("2026-06-21T10:00:00Z"));
    const sunrise = times.sunrise!.getTime();
    const sunset = times.sunset!.getTime();
    // Bucharest, 21 June 2026: ~05:32 and ~21:03 local (EEST, UTC+3).
    expect(Math.abs(sunrise - Date.parse("2026-06-21T02:32:00Z"))).toBeLessThan(15 * 60_000);
    expect(Math.abs(sunset - Date.parse("2026-06-21T18:03:00Z"))).toBeLessThan(15 * 60_000);
    expect(times.goldenHourStart!.getTime()).toBeLessThan(times.sunset!.getTime());
  });

  it("returns null sun times inside the polar day and night", () => {
    const polarDay = getSunTimes(78.2, 15.6, new Date("2026-06-21T12:00:00Z"));
    expect(polarDay.sunrise).toBeNull();
    expect(polarDay.sunset).toBeNull();

    const polarNight = getSunTimes(78.2, 15.6, new Date("2026-12-21T12:00:00Z"));
    expect(polarNight.sunrise).toBeNull();
  });

  it("maps elevation to the documented phases", () => {
    expect(phaseForElevation(40)).toBe("Solar Day");
    expect(phaseForElevation(12)).toBe("Afternoon");
    expect(phaseForElevation(1)).toBe("Golden Hour");
    expect(phaseForElevation(-3)).toBe("Sunset");
    expect(phaseForElevation(-9)).toBe("Dusk");
    expect(phaseForElevation(-30)).toBe("Night");
  });
});

describe("palette engine", () => {
  const elevations = [-90, -18, -12, -6, -3, 0, 3, 8, 20, 45, 90];

  it("always returns five valid uppercase hex swatches", () => {
    for (const elevation of elevations) {
      const palette = computePalette({ elevation, cloudCoverLow: 20, cloudCoverHigh: 30, visibility: 18_000 });
      for (const label of SWATCH_LABELS) {
        expect(palette[label]).toMatch(/^#[0-9A-F]{6}$/);
      }
      expect(swatchesToArray(palette)).toHaveLength(5);
      expect(palette.gradientCss).toContain(palette.zenith);
    }
  });

  it("is deterministic", () => {
    const a = computePalette({ elevation: 4.2, cloudCoverLow: 12, cloudCoverHigh: 44 });
    const b = computePalette({ elevation: 4.2, cloudCoverLow: 12, cloudCoverHigh: 44 });
    expect(a).toEqual(b);
  });

  it("is continuous while scrubbing: no perceptible jump between adjacent steps", () => {
    let previous = computePalette({ elevation: -20 });
    for (let elevation = -19.95; elevation <= 60; elevation += 0.05) {
      const current = computePalette({ elevation });
      for (const label of SWATCH_LABELS) {
        const a = hexToRgb(previous[label]);
        const b = hexToRgb(current[label]);
        const delta = Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
        expect(delta, `${label} jumped at ${elevation}`).toBeLessThanOrEqual(3);
      }
      previous = current;
    }
  });

  it("gets darker as the sun sets", () => {
    const day = relativeLuminance(computePalette({ elevation: 45 }).zenith);
    const golden = relativeLuminance(computePalette({ elevation: 1 }).zenith);
    const night = relativeLuminance(computePalette({ elevation: -30 }).zenith);
    expect(day).toBeGreaterThan(golden);
    expect(golden).toBeGreaterThan(night);
  });

  it("warms the cloud tint with high cloud at low sun, and greys it under overcast", () => {
    const clear = computePalette({ elevation: 2, cloudCoverHigh: 0, cloudCoverLow: 0 });
    const cirrus = computePalette({ elevation: 2, cloudCoverHigh: 90, cloudCoverLow: 0 });
    expect(relativeLuminance(cirrus.cloudtint)).toBeGreaterThan(relativeLuminance(clear.cloudtint));

    const overcast = computePalette({ elevation: 2, cloudCoverLow: 95, cloudCoverHigh: 0 });
    expect(relativeLuminance(overcast.horizon)).toBeGreaterThan(relativeLuminance(clear.horizon));
  });

  it("desaturates toward haze when visibility drops", () => {
    const clear = computePalette({ elevation: 10, visibility: 30_000 });
    const hazy = computePalette({ elevation: 10, visibility: 800 });
    const spread = (palette: Palette) => {
      const rgb = hexToRgb(palette.horizon);
      return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
    };
    expect(spread(hazy)).toBeLessThan(spread(clear));
  });

  it("labels phases from the same thresholds as the solar module", () => {
    expect(computePalette({ elevation: 30 }).phase).toBe("Solar Day");
    expect(computePalette({ elevation: -30 }).phase).toBe("Night");
  });
});

describe("colour contrast", () => {
  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });

  it("picks readable foregrounds for both light and dark skies", () => {
    expect(readableTextColor("#FFFFFF")).toBe("#0B0D12");
    expect(readableTextColor("#05070F")).toBe("#FFFFFF");
  });

  it("rejects malformed hex values", () => {
    expect(() => hexToRgb("blue")).toThrow();
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe("timezone handling", () => {
  it("converts Bucharest wall time to UTC across DST boundaries", () => {
    expect(zonedTimeToUtc("2026-11-14", "16:51", "Europe/Bucharest").toISOString()).toBe("2026-11-14T14:51:00.000Z");
    expect(zonedTimeToUtc("2026-06-21", "16:51", "Europe/Bucharest").toISOString()).toBe("2026-06-21T13:51:00.000Z");
    expect(zonedTimeToUtc("2026-06-21", "12:00", "America/New_York").toISOString()).toBe("2026-06-21T16:00:00.000Z");
  });

  it("round-trips an instant back to the same wall clock", () => {
    const instant = zonedTimeToUtc("2026-03-29", "09:15", "Europe/Bucharest");
    expect(clockInZone(instant, "Europe/Bucharest")).toBe("09:15");
    expect(isoDayInZone(instant, "Europe/Bucharest")).toBe("2026-03-29");
  });

  it("reports fractional hours for the scrubber", () => {
    const instant = zonedTimeToUtc("2026-11-14", "15:17", "Europe/Bucharest");
    expect(fractionalHourInZone(instant, "Europe/Bucharest")).toBeCloseTo(15.283, 2);
  });

  it("parses and rejects clock strings", () => {
    expect(parseClock("16:51")).toEqual({ hours: 16, minutes: 51 });
    expect(parseClock("24:01")).toBeNull();
    expect(parseClock("nope")).toBeNull();
  });

  it("adds days without drifting across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});
