import { describe, expect, it } from "vitest";
import { parseRoute, serializeRoute } from "../../../src/client/lib/route";

describe("route grammar", () => {
  it("parses a complete route", () => {
    expect(parseRoute("?city=tokyo-japan&view=detail&day=2026-11-14&time=16:49&interval=30")).toEqual({
      city: "tokyo-japan",
      view: "detail",
      day: "2026-11-14",
      time: "16:49",
      interval: 30,
    });
  });

  it("treats a day as detail when view is absent", () => {
    expect(parseRoute("?city=paris-france&day=2026-11-14")).toMatchObject({
      view: "detail",
      day: "2026-11-14",
    });
  });

  it("keeps an explicit view", () => {
    expect(parseRoute("?city=paris-france&view=gallery&day=2026-11-14").view).toBe("gallery");
  });

  it("falls back safely for missing and malformed values", () => {
    expect(parseRoute("")).toEqual({ city: null, view: null, day: null, time: null, interval: null });
    expect(parseRoute("?view=nope&day=2026-02-31&time=24:99&interval=abc")).toEqual({
      city: null,
      view: null,
      day: null,
      time: null,
      interval: null,
    });
    expect(parseRoute("?city=Bad%20Slug").city).toBeNull();
    expect(parseRoute("?time=9:05").time).toBeNull();
    expect(parseRoute("?interval=7").interval).toBe(7);
  });

  it("serializes with stable order and round-trips", () => {
    const query = serializeRoute({
      city: "bucharest-romania",
      view: "detail",
      day: "2026-11-14",
      time: "16:49",
      interval: 15,
    });
    expect(query).toBe("/?city=bucharest-romania&view=detail&day=2026-11-14&time=16%3A49&interval=15");
    expect(parseRoute(query.slice(1))).toMatchObject({
      city: "bucharest-romania",
      view: "detail",
      day: "2026-11-14",
      time: "16:49",
      interval: 15,
    });
  });

  it("serializes a bare route as /", () => {
    expect(serializeRoute({ city: null, view: null })).toBe("/");
  });
});
