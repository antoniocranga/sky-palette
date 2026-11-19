// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_DARK, refreshThemeColor, scrimTint } from "../../../src/client/lib/theme";

/**
 * The strip above the web view is painted by the browser, so these values were
 * measured on a booted simulator (iPhone 15 Pro, iOS 17.5, Safari) with a
 * control page: `theme-color` painted the strip, and a full-page
 * rgba(5, 7, 15, 0.72) scrim over #ffffff resolved to #4b4c52. See
 * docs/assets/review/ios/safe-area-report.md.
 */
describe("dialog tint", () => {
  it("matches the scrim composite measured in Safari", () => {
    // control-scrim-15pro.png: theme-color #ffffff, page rgba(5, 7, 15, 0.72) over white.
    expect(scrimTint("#ffffff", 0.72)).toBe("#4b4c52");
  });

  it("dims a white screen instead of falling back to the dark default", () => {
    expect(scrimTint("#ffffff", 0.55)).toBe("#75777b");
    expect(scrimTint("#ffffff", 0.72)).not.toBe("#0b0d12");
  });

  it("keeps a dark screen dark", () => {
    expect(scrimTint("#0b0d12", 0.72)).toBe("#070910");
    expect(scrimTint("#000000", 0.72)).toBe("#04050b");
  });

  it("clamps alpha and the scrim bounds", () => {
    expect(scrimTint("#ffffff", 1)).toBe("#05070f");
    expect(scrimTint("#ffffff", 0)).toBe("#ffffff");
    expect(scrimTint("#ffffff", 4)).toBe("#05070f");
    expect(scrimTint("#ffffff", -1)).toBe("#ffffff");
    expect(scrimTint("#ffffff", Number.NaN)).toBe("#75777b");
  });

  it("falls back for a colour that is not six-digit hex", () => {
    expect(scrimTint("rebeccapurple", 1)).toBe("#05070f");
    expect(scrimTint("#FFF", 0.72)).toBe("#04050b");
  });
});

describe("screen tint", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000">';
    document.body.innerHTML = "";
    document.body.removeAttribute("data-booting");
    vi.restoreAllMocks();
  });

  const rgb = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgb(${r}, ${g}, ${b})`;
  };

  it("uses one pure black for the gallery", () => {
    document.body.innerHTML = '<div id="screen-gallery" class="active"></div>';
    refreshThemeColor();
    const root = getComputedStyle(document.documentElement);
    expect(CHROME_DARK).toBe("#000000");
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe("#000000");
    expect(root.getPropertyValue("--chrome-bottom").trim()).toBe("#000000");
    expect(root.backgroundColor).toBe(rgb("#000000"));
    expect(document.body.style.backgroundColor).toBe(rgb("#000000"));
  });

  it("keeps the detail screen white", () => {
    document.body.innerHTML = '<div id="screen-detail" class="active"></div>';
    refreshThemeColor();
    const root = getComputedStyle(document.documentElement);
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe("#ffffff");
    expect(root.getPropertyValue("--chrome-bottom").trim()).toBe("#ffffff");
    expect(root.getPropertyValue("--chrome-top").trim()).toBe("#ffffff");
  });

  it("uses the live sky zenith and sunglow on home", () => {
    document.body.innerHTML = '<div id="screen-home" class="active"></div>';
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = {
        getPropertyValue: (name: string) =>
          name === "--sky-zenith" ? "#123456" : name === "--sky-bottom" ? "#654321" : "",
      } as unknown as CSSStyleDeclaration;
      return style;
    });
    refreshThemeColor();
    vi.restoreAllMocks();
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--chrome-top")).toBe("#123456");
    expect(style.getPropertyValue("--chrome-bottom")).toBe("#654321");
  });
});
