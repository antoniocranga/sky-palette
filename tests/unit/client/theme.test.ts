import { describe, expect, it } from "vitest";
import { scrimTint } from "../../../src/client/lib/theme";

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
    expect(scrimTint("#FFF", 0.72)).toBe("#070910");
  });
});
