import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_READING_END_S,
  LAUNCH_READING_START_S,
  isSoundEnabled,
  makeRng,
  maxDurationMs,
  playFloppyAfterDelay,
  readingLoopPoints,
  scheduleSeekBursts,
  setSoundEnabled,
  spinDownMs,
  startDelayMs,
  withFloppySound,
} from "../src/lib/floppy-sound.ts";

// Node's own global `localStorage` shadows jsdom's under vitest (see client.test.ts), so stub a
// minimal in-memory Storage.
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("floppy-sound timing", () => {
  it("startDelayMs keeps fast actions silent but isn't excessive", () => {
    const d = startDelayMs();
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(1000);
  });

  it("maxDurationMs caps a single playback at 20s", () => {
    expect(maxDurationMs()).toBe(20_000);
  });

  it("spinDownMs is a short, non-zero fade", () => {
    const s = spinDownMs();
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1000);
  });
});

describe("floppy-sound preference", () => {
  it("is off by default", () => {
    expect(isSoundEnabled()).toBe(false);
  });

  it("round-trips through localStorage", () => {
    setSoundEnabled(true);
    expect(localStorage.getItem("outfitterSound")).toBe("on");
    expect(isSoundEnabled()).toBe(true);
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
  });

  it("treats a storage failure as off", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => setSoundEnabled(true)).not.toThrow();
    expect(isSoundEnabled()).toBe(false);
  });
});

describe("withFloppySound", () => {
  it("returns the same promise untouched when sound is off", () => {
    const p = Promise.resolve(1);
    expect(withFloppySound(p)).toBe(p);
  });

  it("passes values and rejections through when on, even without Web Audio (jsdom)", async () => {
    setSoundEnabled(true);
    await expect(withFloppySound(Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(withFloppySound(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("the stop function from playFloppyAfterDelay is safe before and after the delay", () => {
    vi.useFakeTimers();
    const stopEarly = playFloppyAfterDelay();
    expect(() => stopEarly()).not.toThrow();
    const stopLate = playFloppyAfterDelay();
    vi.advanceTimersByTime(startDelayMs() + 10);
    expect(() => stopLate()).not.toThrow();
    expect(() => stopLate()).not.toThrow();
  });
});

describe("readingLoopPoints", () => {
  it("loops the reading section of launch.mp3, after the initial seek", () => {
    expect(readingLoopPoints(4.75)).toEqual({ loopStart: LAUNCH_READING_START_S, loopEnd: LAUNCH_READING_END_S });
    expect(LAUNCH_READING_START_S).toBeGreaterThan(2.3);
    expect(LAUNCH_READING_END_S - LAUNCH_READING_START_S).toBeGreaterThan(1.5);
  });

  it("clamps the loop end to a buffer the decoder trimmed", () => {
    expect(readingLoopPoints(4.2)).toEqual({ loopStart: LAUNCH_READING_START_S, loopEnd: 4.2 });
  });

  it("returns null (play once) when the buffer can't hold a usable loop", () => {
    expect(readingLoopPoints(2.6)).toBeNull();
    expect(readingLoopPoints(0)).toBeNull();
    expect(readingLoopPoints(Number.NaN)).toBeNull();
  });
});

describe("scheduleSeekBursts", () => {
  it("makeRng is deterministic and in [0, 1)", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic for a seed and varies across seeds", () => {
    expect(scheduleSeekBursts(1, 20_000)).toEqual(scheduleSeekBursts(1, 20_000));
    expect(scheduleSeekBursts(1, 20_000)).not.toEqual(scheduleSeekBursts(2, 20_000));
  });

  it("leaves the first pass of launch.mp3 alone and every burst finishes before the cap", () => {
    for (let seed = 0; seed < 25; seed++) {
      const times = scheduleSeekBursts(seed, maxDurationMs(), { burstMs: 1350 });
      expect(times.length).toBeGreaterThan(0);
      expect(times[0]).toBeGreaterThanOrEqual(LAUNCH_READING_END_S * 1000);
      for (const t of times) expect(t + 1350).toBeLessThanOrEqual(maxDurationMs());
    }
  });

  it("keeps bursts apart by at least burst length + minimum gap", () => {
    const times = scheduleSeekBursts(9, 60_000, { burstMs: 1000, minGapMs: 2000, maxGapMs: 3000 });
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      expect(gap).toBeGreaterThanOrEqual(2999);
      expect(gap).toBeLessThanOrEqual(4001);
    }
  });

  it("schedules nothing for a wait too short to reach the loop", () => {
    expect(scheduleSeekBursts(1, 5000)).toEqual([]);
    expect(scheduleSeekBursts(1, 0)).toEqual([]);
  });
});
