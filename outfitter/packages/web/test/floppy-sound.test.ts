import { describe, expect, it } from "vitest";
import { makeRng, maxDurationMs, scheduleSeekClicks, spinDownMs, startDelayMs } from "../src/lib/floppy-sound.ts";

describe("floppy-sound scheduling", () => {
  it("startDelayMs keeps fast actions silent but isn't excessive", () => {
    const d = startDelayMs();
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(1000);
  });

  it("maxDurationMs caps a single playback at roughly 20s", () => {
    expect(maxDurationMs()).toBe(20_000);
  });

  it("spinDownMs is a short, non-zero fade", () => {
    const s = spinDownMs();
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1000);
  });

  it("makeRng is deterministic for a given seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("makeRng produces values in [0, 1)", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 50; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("scheduleSeekClicks is deterministic for a given seed", () => {
    const a = scheduleSeekClicks(1, 5000);
    const b = scheduleSeekClicks(1, 5000);
    expect(a).toEqual(b);
  });

  it("scheduleSeekClicks produces different schedules for different seeds", () => {
    const a = scheduleSeekClicks(1, 5000);
    const b = scheduleSeekClicks(2, 5000);
    expect(a).not.toEqual(b);
  });

  it("scheduleSeekClicks stays within [0, durationMs) and is strictly increasing", () => {
    const times = scheduleSeekClicks(3, 4000);
    expect(times.length).toBeGreaterThan(0);
    for (let i = 0; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(0);
      expect(times[i]).toBeLessThan(4000);
      if (i > 0) expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it("scheduleSeekClicks respects custom min/max gap bounds", () => {
    const times = scheduleSeekClicks(9, 3000, { minGapMs: 500, maxGapMs: 600 });
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      expect(gap).toBeGreaterThanOrEqual(490); // allow rounding
      expect(gap).toBeLessThanOrEqual(610);
    }
  });

  it("scheduleSeekClicks returns [] when durationMs is 0", () => {
    expect(scheduleSeekClicks(1, 0)).toEqual([]);
  });
});
