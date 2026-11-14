import { describe, expect, it } from "vitest";
import { normalizeCitySlug, preferredCitySlug } from "../../../src/client/state";

describe("city preference precedence", () => {
  it("prefers a URL slug over the stored slug", () => {
    expect(preferredCitySlug("?city=tokyo-japan", "paris-france")).toBe("tokyo-japan");
  });

  it("falls back to the stored slug when the URL has none", () => {
    expect(preferredCitySlug("", "paris-france")).toBe("paris-france");
    expect(preferredCitySlug("?view=home", "tokyo-japan")).toBe("tokyo-japan");
  });

  it("ignores malformed stored slugs", () => {
    expect(preferredCitySlug("", "Not a slug!")).toBeNull();
    expect(preferredCitySlug("", "   ")).toBeNull();
    expect(preferredCitySlug("", "../../etc/passwd")).toBeNull();
  });

  it("ignores a malformed URL slug and uses the stored value", () => {
    expect(preferredCitySlug("?city=Bad%20Slug", "paris-france")).toBe("paris-france");
  });

  it("returns null when nothing usable is available", () => {
    expect(preferredCitySlug("", null)).toBeNull();
    expect(normalizeCitySlug("bucharest-romania")).toBe("bucharest-romania");
    expect(normalizeCitySlug("nope nope")).toBeNull();
  });
});
