import { describe, expect, it } from "vitest";
import {
  DEFAULT_GALLERY_SORT_OPTION,
  GALLERY_SORT_OPTIONS,
  gallerySortOption,
} from "../../../src/client/lib/gallery-sort";

describe("community sort options", () => {
  it("lists the four choices in menu order", () => {
    expect(GALLERY_SORT_OPTIONS.map((option) => option.label)).toEqual([
      "Newest uploads",
      "Oldest uploads",
      "Newest captures",
      "Oldest captures",
    ]);
    expect(GALLERY_SORT_OPTIONS.map((option) => `${option.sort}:${option.order}`)).toEqual([
      "upload:desc",
      "upload:asc",
      "captured:desc",
      "captured:asc",
    ]);
  });

  it("defaults to newest uploads", () => {
    expect(DEFAULT_GALLERY_SORT_OPTION).toMatchObject({ sort: "upload", order: "desc" });
    expect(gallerySortOption(undefined)).toBe(DEFAULT_GALLERY_SORT_OPTION);
    expect(gallerySortOption("nope")).toBe(DEFAULT_GALLERY_SORT_OPTION);
  });

  it("resolves a known id", () => {
    expect(gallerySortOption("captured-asc")).toMatchObject({
      label: "Oldest captures",
      sort: "captured",
      order: "asc",
    });
  });
});
