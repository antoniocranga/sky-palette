import { describe, expect, it } from "vitest";
import {
  CARD_SIZE,
  SHARE_HANDLE,
  SHARE_SITE,
  STORY_LAYOUT,
  STORY_SIZE,
  sharePngFilename,
  storyContent,
  storyTextInsideSafeArea,
  type StorySource,
} from "../../../src/client/lib/share-card";

const source: StorySource = {
  city: { name: "Bucharest", country: "Romania", lat: 44.4268, lon: 26.1025 },
  palette: {
    zenith: "#0a1430",
    midsky: "#24406e",
    horizon: "#d97a56",
    sunglow: "#f6c66b",
    cloudtint: "#b9a7b0",
    elevation: 8.4,
    phase: "Golden hour",
    gradientCss: "linear-gradient(#0a1430, #d97a56)",
  },
  dateIso: "2026-11-14",
  timeLabel: "16:49",
  phase: "Golden hour",
  elevation: 8.4,
  azimuth: 244.2,
  cloudLabel: "22% / 18% / 44%",
};

describe("share card geometry", () => {
  it("keeps the existing 4:5 card and adds a 9:16 story", () => {
    expect(CARD_SIZE).toEqual({ width: 1080, height: 1350 });
    expect(STORY_SIZE).toEqual({ width: 1080, height: 1920 });
    expect(STORY_SIZE.width / STORY_SIZE.height).toBeCloseTo(9 / 16, 5);
  });

  it("keeps every story label inside the safe area", () => {
    expect(STORY_LAYOUT.margin).toBeGreaterThanOrEqual(STORY_LAYOUT.safeMargin);
    expect(STORY_LAYOUT.safeMargin).toBeGreaterThanOrEqual(96);
    expect(STORY_LAYOUT.contentTop).toBeGreaterThanOrEqual(120);
    expect(STORY_LAYOUT.contentBottom).toBeLessThanOrEqual(STORY_SIZE.height - 120);
    expect(storyTextInsideSafeArea()).toBe(true);
  });

  it("names card and story downloads distinctly", () => {
    expect(sharePngFilename("card", "bucharest-romania", "2026-11-14")).toBe(
      "sky-palette-bucharest-romania-2026-11-14.png",
    );
    expect(sharePngFilename("story", "bucharest-romania", "2026-11-14")).toBe(
      "sky-palette-bucharest-romania-2026-11-14-story.png",
    );
  });
});

describe("story content", () => {
  it("carries city, date, time, phase, solar metrics, cloud cover and swatches", () => {
    const content = storyContent(source);
    expect(content.city).toBe("BUCHAREST");
    expect(content.coords).toContain("ROMANIA");
    expect(content.date).toBe("NOV 14");
    expect(content.time).toBe("16:49");
    expect(content.phase).toBe("Golden hour");
    expect(content.metrics.map((metric) => metric.label)).toEqual([
      "SOLAR ELEVATION",
      "AZIMUTH",
      "CLOUD COVER",
      "PHASE",
    ]);
    expect(content.metrics[0]?.value).toBe("+8.4°");
    expect(content.metrics[1]?.value).toBe("244°");
    expect(content.metrics[2]?.value).toBe("22% / 18% / 44%");
    expect(content.hexes).toEqual(["#0A1430", "#24406E", "#D97A56", "#F6C66B", "#B9A7B0"]);
    expect(content.colors).toHaveLength(5);
    expect(content.handle).toBe(SHARE_HANDLE);
    expect(content.site).toBe(SHARE_SITE);
  });
});

import { cardMetaText } from "../../../src/client/features/share";
import type { ShareSnapshot } from "../../../src/client/state";

describe("card handle meta", () => {
  const snapshot = {
    city: { slug: "bucharest-romania", name: "Bucharest", country: "Romania", countryCode: "RO", admin1: null, lat: 44.4, lon: 26.1, timezone: "Europe/Bucharest" },
    palette: source.palette,
    dateIso: source.dateIso,
    timeLabel: source.timeLabel,
    phase: source.phase,
    elevation: source.elevation,
    azimuth: source.azimuth,
    cloudLabel: source.cloudLabel,
    mode: "live",
    sunsetLabel: "16:49",
  } satisfies ShareSnapshot;

  it.each(["studio", "telemetry", "horizon", "monolith"] as const)("%s artwork includes the tag", (style) => {
    expect(cardMetaText(style, snapshot, "sky-bucharest-48b")).toContain("@sky-bucharest-48b");
  });
});
