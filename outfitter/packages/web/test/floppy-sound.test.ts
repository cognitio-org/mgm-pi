import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_READING_END_S,
  LAUNCH_READING_START_S,
  clipRetryDelayMs,
  isSoundEnabled,
  makeRng,
  maxDurationMs,
  playFloppyAfterDelay,
  readingLoopPoints,
  resetFloppyEngineForTests,
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
  resetFloppyEngineForTests();
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

describe("clipRetryDelayMs", () => {
  it("backs off after failed clip loads, doubling up to a cap", () => {
    expect(clipRetryDelayMs(0)).toBe(0);
    expect(clipRetryDelayMs(1)).toBe(15_000);
    expect(clipRetryDelayMs(2)).toBe(30_000);
    expect(clipRetryDelayMs(3)).toBe(60_000);
    expect(clipRetryDelayMs(20)).toBe(300_000);
  });
});

// --- the shared engine, against a fake Web Audio + fetch -----------------------------------------

interface FakeSource {
  buffer: { duration: number } | null;
  loop: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: () => void;
}

function installFakeAudio(opts: { failFetches?: number } = {}) {
  const sources: FakeSource[] = [];
  const contexts: FakeContext[] = [];
  const gainParam = () => ({
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  class FakeContext {
    state: "running" | "suspended" = "running";
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {
      this.state = "running";
    });
    suspend = vi.fn(async () => {
      this.state = "suspended";
    });
    constructor() {
      contexts.push(this);
    }
    createGain() {
      return { gain: gainParam(), connect() {} };
    }
    createBufferSource(): FakeSource {
      const src: FakeSource = { buffer: null, loop: false, start: vi.fn(), stop: vi.fn(), connect() {} };
      sources.push(src);
      return src;
    }
    decodeAudioData(data: ArrayBuffer) {
      // launch.mp3 is served as 2 bytes, load.mp3 as 1 (see fetch below).
      return Promise.resolve({ duration: data.byteLength === 2 ? 4.7 : 1.32 });
    }
  }
  let failures = opts.failFetches ?? 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (failures > 0) {
      failures--;
      return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(url.includes("launch") ? 2 : 1) };
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("fetch", fetchMock);
  /** Reading loops (one per playback) that haven't been told to stop. */
  const playing = () => sources.filter((s) => s.loop && s.stop.mock.calls.length === 0).length;
  const playbacks = () => sources.filter((s) => s.loop).length;
  return { sources, contexts, fetchMock, playing, playbacks };
}

/** Let the fetch/decode promise chain run. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

describe("shared floppy engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("plays after the start delay and fades when the wait settles", async () => {
    const audio = installFakeAudio();
    const stop = playFloppyAfterDelay();
    await advance(startDelayMs() - 10);
    expect(audio.playing()).toBe(0);
    await advance(20);
    expect(audio.playing()).toBe(1);
    stop();
    expect(audio.playing()).toBe(0);
  });

  it("a short wait B settling doesn't cut off a long wait A, and B joins A's playback", async () => {
    const audio = installFakeAudio();
    const stopA = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    expect(audio.playing()).toBe(1);

    const stopB = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    expect(audio.playbacks()).toBe(1); // B joined; no second playback
    expect(audio.playing()).toBe(1);
    stopB();
    stopB(); // idempotent: mustn't release A's hold too
    expect(audio.playing()).toBe(1);

    await advance(5_000);
    expect(audio.playing()).toBe(1);
    stopA();
    expect(audio.playing()).toBe(0);
    expect(audio.playbacks()).toBe(1);
  });

  it("B stopping before its own start delay leaves A playing", async () => {
    const audio = installFakeAudio();
    const stopA = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    const stopB = playFloppyAfterDelay();
    await advance(100);
    stopB();
    await advance(1_000);
    expect(audio.playing()).toBe(1);
    stopA();
    expect(audio.playing()).toBe(0);
  });

  it("A settling while B is still in its delay: A fades, B starts its own playback later", async () => {
    const audio = installFakeAudio();
    const stopA = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    const stopB = playFloppyAfterDelay();
    await advance(100);
    stopA();
    expect(audio.playing()).toBe(0);
    await advance(startDelayMs());
    expect(audio.playing()).toBe(1);
    expect(audio.playbacks()).toBe(2);
    stopB();
    expect(audio.playing()).toBe(0);
  });

  it("caps each playback at maxDurationMs from when the sound started", async () => {
    const audio = installFakeAudio();
    const stopA = playFloppyAfterDelay();
    await advance(startDelayMs());
    expect(audio.playing()).toBe(1);
    await advance(maxDurationMs() - 50);
    expect(audio.playing()).toBe(1);
    await advance(100);
    expect(audio.playing()).toBe(0);
    // A is still waiting but has had its 20 s. A new wait passing its delay starts a fresh
    // playback with its own cap, and B settling ends it even though A is still pending.
    const stopB = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    expect(audio.playing()).toBe(1);
    expect(audio.playbacks()).toBe(2);
    stopB();
    expect(audio.playing()).toBe(0);
    stopA();
    expect(audio.playbacks()).toBe(2);
  });

  it("suspends the AudioContext after the last spin-down and resumes it for the next wait", async () => {
    const audio = installFakeAudio();
    const stopA = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    const ctx = audio.contexts[0];
    stopA();
    expect(ctx.suspend).not.toHaveBeenCalled(); // still fading
    await advance(spinDownMs() + 200);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("suspended");

    const stopB = playFloppyAfterDelay();
    expect(ctx.resume).toHaveBeenCalled();
    await advance(startDelayMs() + 10);
    expect(audio.playing()).toBe(1);
    expect(audio.contexts).toHaveLength(1);
    stopB();
  });

  it("doesn't suspend while another wait is still pending", async () => {
    const audio = installFakeAudio();
    const stopA = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    const stopB = playFloppyAfterDelay(); // still in its delay when A settles
    stopA();
    stopB();
    const stopC = playFloppyAfterDelay();
    await advance(spinDownMs() + 200);
    expect(audio.contexts[0].suspend).not.toHaveBeenCalled();
    stopC();
    await advance(spinDownMs() + 200);
    expect(audio.contexts[0].suspend).toHaveBeenCalledTimes(1);
  });

  it("retries a failed clip load after a backoff instead of staying silent all session", async () => {
    const audio = installFakeAudio({ failFetches: 1 });
    let stop = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    expect(audio.playing()).toBe(0);
    stop();
    const fetchesAfterFailure = audio.fetchMock.mock.calls.length;

    // Inside the backoff: silent, and no refetch.
    stop = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    expect(audio.playing()).toBe(0);
    expect(audio.fetchMock.mock.calls.length).toBe(fetchesAfterFailure);
    stop();

    await advance(clipRetryDelayMs(1));
    stop = playFloppyAfterDelay();
    await advance(startDelayMs() + 10);
    expect(audio.fetchMock.mock.calls.length).toBeGreaterThan(fetchesAfterFailure);
    expect(audio.playing()).toBe(1);
    stop();
  });
});
