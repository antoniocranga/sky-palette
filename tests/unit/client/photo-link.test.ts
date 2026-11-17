import { describe, expect, it } from "vitest";
import {
  normalizeHandle,
  parsePhotoDeepLink,
  photoTagUrl,
} from "../../../src/client/lib/photo-link";

describe("photo deep links", () => {
  it("normalises a handle without the @", () => {
    expect(normalizeHandle("@Sky-Bucharest-48B")).toBe("sky-bucharest-48b");
    expect(normalizeHandle("sky-bucharest-48b")).toBe("sky-bucharest-48b");
    expect(normalizeHandle("  sky-bucharest-48b  ")).toBe("sky-bucharest-48b");
  });

  it("rejects empty or malformed handles", () => {
    expect(normalizeHandle(null)).toBeNull();
    expect(normalizeHandle("")).toBeNull();
    expect(normalizeHandle("@")).toBeNull();
    expect(normalizeHandle("@@")).toBeNull();
    expect(normalizeHandle("sky bucharest")).toBeNull();
    expect(normalizeHandle("../etc/passwd")).toBeNull();
    expect(normalizeHandle("a".repeat(65))).toBeNull();
  });

  it("reads the handle link and the legacy id link", () => {
    expect(parsePhotoDeepLink("?tag=sky-bucharest-48b")).toEqual({
      handle: "sky-bucharest-48b",
      id: null,
    });
    expect(parsePhotoDeepLink("?photo=4c1f0b1e-0000-4000-8000-000000000000")).toEqual({
      handle: null,
      id: "4c1f0b1e-0000-4000-8000-000000000000",
    });
    expect(parsePhotoDeepLink("?tag=%40sky-bucharest-48b&photo=photo-1")).toEqual({
      handle: "sky-bucharest-48b",
      id: "photo-1",
    });
  });

  it("ignores malformed or missing params", () => {
    expect(parsePhotoDeepLink("")).toEqual({ handle: null, id: null });
    expect(parsePhotoDeepLink("?tag=%20&photo=%3Cscript%3E")).toEqual({ handle: null, id: null });
  });

  it("builds a handle link with no @ and no stray slash", () => {
    expect(photoTagUrl("https://skypalette.app", "@sky-bucharest-48b")).toBe(
      "https://skypalette.app/?tag=sky-bucharest-48b",
    );
    expect(photoTagUrl("https://skypalette.app/", "sky-bucharest-48b")).toBe(
      "https://skypalette.app/?tag=sky-bucharest-48b",
    );
  });
});
