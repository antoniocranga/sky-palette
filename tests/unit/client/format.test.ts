import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCoordinate,
  formatCoordinates,
  formatDateShort,
  formatDateUpper,
  formatDegrees,
  formatElevation,
  formatInstantClock,
  formatPercent,
  instantForLocalHour,
  parseDateTimeLocalValue,
  slugify,
  toDateTimeLocalValue,
  weatherLabel,
} from "../../../src/client/lib/format";

describe("client formatters", () => {
  it("formats date-only strings without timezone drift", () => {
    expect(formatDateShort("2026-11-14")).toBe("Nov 14");
    expect(formatDateUpper("2026-11-14")).toBe("NOV 14");
    expect(formatDateShort("not-a-date")).toBe("—");
  });

  it("formats coordinates with hemispheres", () => {
    expect(formatCoordinate(44.4268, "lat")).toBe("44.4268° N");
    expect(formatCoordinate(-34.6037, "lat")).toBe("34.6037° S");
    expect(formatCoordinate(26.1025, "lon")).toBe("26.1025° E");
    expect(formatCoordinate(-58.3816, "lon")).toBe("58.3816° W");
    expect(formatCoordinates(44.4268, 26.1025)).toBe("44.4268° N, 26.1025° E");
  });

  it("formats solar metrics", () => {
    expect(formatElevation(0.8)).toBe("+0.8°");
    expect(formatElevation(-4.2)).toBe("-4.2°");
    expect(formatDegrees(235.6)).toBe("236°");
    expect(formatDegrees(-5)).toBe("355°");
    expect(formatPercent(41.4)).toBe("41%");
    expect(formatPercent(null)).toBe("—");
  });

  it("round-trips datetime-local values in a zone", () => {
    const iso = parseDateTimeLocalValue("2026-11-14T16:51", "Europe/Bucharest");
    expect(iso).toBe("2026-11-14T14:51:00.000Z");
    expect(toDateTimeLocalValue(new Date(iso!), "Europe/Bucharest")).toBe("2026-11-14T16:51");
    expect(parseDateTimeLocalValue("14/11/2026 16:51", "Europe/Bucharest")).toBeNull();
  });

  it("rolls 24:00 into the next local day", () => {
    expect(instantForLocalHour("2026-11-14", 24, "Europe/Bucharest").toISOString()).toBe(
      "2026-11-14T22:00:00.000Z",
    );
  });

  it("formats instants in the city zone", () => {
    expect(formatInstantClock("2026-11-14T14:51:00.000Z", "Europe/Bucharest")).toBe("16:51");
    expect(formatInstantClock(null, "Europe/Bucharest")).toBe("—");
  });

  it("formats bytes and weather labels", () => {
    expect(formatBytes(900)).toBe("1 KB");
    expect(formatBytes(2_500_000)).toBe("2.4 MB");
    expect(weatherLabel(0)).toBe("Clear");
    expect(weatherLabel(3)).toBe("Overcast");
    expect(weatherLabel(61)).toBe("Rain");
    expect(weatherLabel(95)).toBe("Thunderstorm");
  });

  it("creates safe handle slugs", () => {
    expect(slugify("Buenos Aires")).toBe("buenos-aires");
    expect(slugify("  Île-de-France  ")).toBe("ile-de-france");
  });
});
