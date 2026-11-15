import { describe, expect, it } from "vitest";
import { computePalette } from "../../../src/shared/palette";
import { contrastRatio } from "../../../src/shared/color";
import {
  HOME_CONTROL_PALETTES,
  gradientColorAt,
  homeBackdropColor,
  homeTextColors,
  nextHomeTone,
  resolveHomeTone,
  rulerTextColor,
} from "../../../src/client/lib/contrast";

const PALETTES = [
  { label: "bright noon", palette: computePalette({ elevation: 60 }) },
  { label: "golden hour", palette: computePalette({ elevation: 2 }) },
  { label: "sunset", palette: computePalette({ elevation: -2.5 }) },
  { label: "dusk", palette: computePalette({ elevation: -12 }) },
  { label: "night", palette: computePalette({ elevation: -40 }) },
];

describe("home hero contrast", () => {
  it("interpolates the sky gradient stops", () => {
    expect(gradientColorAt([{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }], 0)).toBe("#000000");
    expect(gradientColorAt([{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }], 1)).toBe("#FFFFFF");
    expect(gradientColorAt([{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }], 0.5)).toBe("#808080");
  });

  it.each(PALETTES)("reaches AA on $label", ({ palette }) => {
    const colors = homeTextColors(palette);
    expect(contrastRatio(colors.top, homeBackdropColor(palette, 0.29))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.bottom, homeBackdropColor(palette, 0.48))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the ruler label readable at the horizon", () => {
    for (const { palette } of PALETTES) {
      const ink = rulerTextColor(palette);
      const background = homeBackdropColor(palette, 0.79);
      expect(contrastRatio(ink, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("home tone control palette", () => {
  const DARK_SKY = "#090B10";
  const LIGHT_SKY = "#DCE7F2";

  it("maps a dark sky to inverted controls and a light sky to black controls", () => {
    expect(nextHomeTone(computePalette({ elevation: -40 }))).toBe("dark");
    expect(nextHomeTone(computePalette({ elevation: 60 }))).toBe("light");
    expect(HOME_CONTROL_PALETTES.dark.surface).toBe("#F5F5F7");
    expect(HOME_CONTROL_PALETTES.dark.surfaceInk).toBe("#000000");
    expect(HOME_CONTROL_PALETTES.light.surface).toBe("#000000");
    expect(HOME_CONTROL_PALETTES.light.surfaceInk).toBe("#FFFFFF");
  });

  it.each([
    ["dark", DARK_SKY],
    ["light", LIGHT_SKY],
  ] as const)("meets AA for every %s-tone control", (tone, sky) => {
    const control = HOME_CONTROL_PALETTES[tone];
    expect(contrastRatio(control.surfaceInk, control.surface), "pill text").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(control.placeholder, control.surface), "placeholder").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(control.infoInk, control.infoSurface), "info glyph").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(control.suggestInk, sky), "suggested chips").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(control.modeLive, sky), "live badge").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(control.modeForecast, sky), "forecast badge").toBeGreaterThanOrEqual(4.5);
  });

  it("uses a hysteresis band so threshold scrubbing does not flicker", () => {
    const background = "#777777";
    const aggressive = resolveHomeTone(background, "dark", 0.1);
    const damped = resolveHomeTone(background, "dark", 0.3);
    expect(aggressive).toBe("light");
    expect(damped).toBe("dark");
  });
});
