import { describe, expect, it } from "vitest";
import {
  clampWithResistance,
  dragVelocity,
  hourForIndex,
  indexForHour,
  momentumStep,
  rubberBand,
  snapIndex,
  springBackFrame,
  springBackTarget,
} from "../../../src/client/lib/tape";

describe("tape maths", () => {
  it("adds resistance beyond both ends", () => {
    expect(rubberBand(100, 0, 100)).toBe(100);
    expect(rubberBand(120, 0, 100)).toBeCloseTo(105.6);
    expect(rubberBand(-20, 0, 100)).toBeCloseTo(-5.6);
  });

  it("snaps and clamps to quarter-hour steps", () => {
    expect(snapIndex(0, 14, 96)).toBe(0);
    expect(snapIndex(7, 14, 96)).toBe(1);
    expect(snapIndex(20, 14, 96)).toBe(1);
    expect(snapIndex(9999, 14, 96)).toBe(96);
  });

  it("converts hours to indices and back", () => {
    expect(indexForHour(16.85)).toBe(67);
    expect(hourForIndex(67)).toBe(16.75);
    expect(indexForHour(-3)).toBe(0);
    expect(indexForHour(30)).toBe(96);
  });

  it("decays velocity and settles on a step", () => {
    let state = { position: 100, velocity: 2 };
    let frames = 0;
    let target: number | null = null;
    while (frames < 600) {
      const next = momentumStep(state, 14, 0, 1344);
      state = { position: next.position, velocity: next.velocity };
      frames += 1;
      if (next.target !== null) {
        target = next.target;
        break;
      }
    }
    expect(target).not.toBeNull();
    expect(target! % 14).toBe(0);
    expect(frames).toBeLessThan(600);
  });

  it("bounces back from an overscroll", () => {
    const next = momentumStep({ position: 1400, velocity: 0 }, 14, 0, 1344);
    expect(next.position).toBeLessThan(1400);
    expect(next.position).toBeGreaterThan(1344);
  });

  it("computes drag velocity from pointer deltas", () => {
    expect(dragVelocity(0, 16, 16)).toBeLessThan(0);
    expect(dragVelocity(0, -16, 16)).toBeGreaterThan(0);
    expect(dragVelocity(0, 10_000, 16)).toBe(-34);
  });

  it("eases harder the further a drag passes the bound", () => {
    const near = clampWithResistance(120, 0, 100) - 100;
    const far = clampWithResistance(400, 0, 100) - 100;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(20 * 0.35 + 0.01);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThan(300 * 0.3);
    expect(clampWithResistance(-120, 0, 100)).toBeLessThan(0);
  });

  it("targets the nearest boundary on release", () => {
    expect(springBackTarget(140, 0, 100, 12)).toEqual({ boundary: 100, velocity: 12 });
    expect(springBackTarget(-40, 0, 100, -12)).toEqual({ boundary: 0, velocity: -12 });
    expect(springBackTarget(50, 0, 100, 3)).toEqual({ boundary: 50, velocity: 3 });
  });

  it("springs back with one small rebound and no residual offset", () => {
    let state = { position: 180, velocity: 900 };
    let minPosition = Number.POSITIVE_INFINITY;
    for (let frame = 0; frame < 30; frame += 1) {
      state = springBackFrame(state, 100, 1 / 60);
      minPosition = Math.min(minPosition, state.position);
    }
    expect(Math.abs(state.position - 100)).toBeLessThan(2);
    expect(minPosition).toBeLessThan(100);
    expect(100 - minPosition).toBeLessThan(12);
    expect(Math.abs(state.velocity)).toBeLessThan(900);
  });
});
