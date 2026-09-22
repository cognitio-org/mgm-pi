// Optional floppy-drive sound for user-initiated waits (send, create, wake/stop/abort, refresh,
// token create). Plays real drive recordings -- the same two clips the kernal.one landing page
// uses (public/sounds/, credits in public/sounds/CREDITS.md):
//
//   launch.mp3 (~4.7 s): a head seek (0 - ~2.4 s), then the drive reading (~2.45 - ~4.4 s), then a
//              short tail.
//   load.mp3   (~1.35 s): a pair of head seeks.
//
// A wait plays launch.mp3 from the start (seek, then reading). If the wait outlasts it, the reading
// section loops seamlessly (AudioBufferSourceNode loopStart/loopEnd), and every few seconds a
// load.mp3 seek burst is laid over it with the reading ducked underneath, so a long wait sounds
// like a drive stepping between tracks rather than one two-second loop. Off by default; see
// SoundToggle.tsx for the header control and isSoundEnabled/setSoundEnabled below.
//
// The clips are fetched and decoded lazily on the first wait that plays sound (never at page load)
// and cached. Everything fails silent: no Web Audio, a failed fetch or a failed decode just means
// no sound. The timing and loop-point math is pure and tested in test/floppy-sound.test.ts; the
// audio graph itself is exercised by ear.

const STORAGE_KEY = "outfitterSound";
export const DEFAULT_VOLUME = 0.45;

/** Where the reading portion of launch.mp3 starts and ends (seconds): after the initial seek, and
 * before the tail fades out. Found from the clip's RMS envelope. */
export const LAUNCH_READING_START_S = 2.45;
export const LAUNCH_READING_END_S = 4.4;

/** Level the reading loop drops to while a seek burst plays over it. */
export const DUCK_LEVEL = 0.3;

/** How long a wait must run before the sound starts, so instant responses stay silent. */
export function startDelayMs(): number {
  return 300;
}

/** Hard cap on any single playback, regardless of how long the underlying action takes. */
export function maxDurationMs(): number {
  return 20_000;
}

/** Fade-out length when a wait finishes (or hits the cap). */
export function spinDownMs(): number {
  return 250;
}

export interface LoopPoints {
  loopStart: number;
  loopEnd: number;
}

/** Loop points (seconds) over the reading section of launch.mp3, clamped to the decoded buffer's
 * actual duration (decoders may trim or pad a few ms). Null when the buffer is too short to hold a
 * usable loop, in which case the clip just plays once. */
export function readingLoopPoints(
  bufferDuration: number,
  start = LAUNCH_READING_START_S,
  end = LAUNCH_READING_END_S,
): LoopPoints | null {
  if (!(bufferDuration > 0)) return null;
  const loopEnd = Math.min(end, bufferDuration);
  const loopStart = Math.max(0, Math.min(start, loopEnd));
  if (loopEnd - loopStart < 0.5) return null;
  return { loopStart, loopEnd };
}

/** mulberry32 -- a small, fast, seedable PRNG, so scheduleSeekBursts is testable. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeekBurstOptions {
  /** No burst before this offset (ms from playback start): let launch.mp3's own seek and first
   * pass of reading play untouched. */
  firstAfterMs?: number;
  minGapMs?: number;
  maxGapMs?: number;
  /** Length of one burst (load.mp3); a burst that wouldn't finish before `untilMs` is dropped. */
  burstMs?: number;
}

/** Offsets (ms from playback start) at which to lay a load.mp3 seek burst over the reading loop,
 * up to `untilMs`. Irregular gaps, measured from the end of the previous burst. Same seed -> same
 * schedule. */
export function scheduleSeekBursts(seed: number, untilMs: number, opts: SeekBurstOptions = {}): number[] {
  const firstAfterMs = opts.firstAfterMs ?? LAUNCH_READING_END_S * 1000;
  const minGapMs = opts.minGapMs ?? 2500;
  const maxGapMs = opts.maxGapMs ?? 6000;
  const burstMs = opts.burstMs ?? 1350;
  const rng = makeRng(seed);
  const times: number[] = [];
  let t = firstAfterMs + rng() * (maxGapMs - minGapMs);
  while (t + burstMs <= untilMs) {
    times.push(Math.round(t));
    t += burstMs + minGapMs + rng() * (maxGapMs - minGapMs);
  }
  return times;
}

export function isSoundEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // best-effort only
  }
}

interface StartOptions {
  volume?: number;
  seed?: number;
}

type AudioContextCtor = typeof AudioContext;

interface Clips {
  launch: AudioBuffer;
  load: AudioBuffer | null;
}

function clipUrl(name: string): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}sounds/${name}.mp3`;
}

async function decodeClip(ctx: AudioContext, name: string): Promise<AudioBuffer> {
  const res = await fetch(clipUrl(name));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const data = await res.arrayBuffer();
  // Promise form of decodeAudioData, with the callback form as a fallback for old Safari.
  return await new Promise<AudioBuffer>((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
    if (p && typeof p.then === "function") p.then(resolve, reject);
  });
}

class FloppyEngine {
  private ctx: AudioContext | null = null;
  private clips: Promise<Clips | null> | null = null;
  private master: GainNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private capTimer: number | null = null;
  /** Bumped by every start/stop, so a start still waiting on decoding can tell it's stale. */
  private generation = 0;
  private active = false;

  /** Creates (or resumes) the shared context. Called synchronously from the user's gesture where
   * possible, so the browser lets it run. */
  prepare(): AudioContext | null {
    if (!this.ctx) {
      if (typeof window === "undefined") return null;
      try {
        const Ctor: AudioContextCtor | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
        if (!Ctor) return null;
        this.ctx = new Ctor();
      } catch {
        this.ctx = null;
        return null;
      }
    }
    try {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    } catch {
      // ignore
    }
    return this.ctx;
  }

  /** Fetches and decodes the clips once; a failure is cached as null (silence), not retried. */
  private loadClips(ctx: AudioContext): Promise<Clips | null> {
    if (!this.clips) {
      this.clips = (async () => {
        try {
          const [launch, load] = await Promise.all([
            decodeClip(ctx, "launch"),
            decodeClip(ctx, "load").catch(() => null),
          ]);
          return { launch, load };
        } catch {
          return null;
        }
      })();
    }
    return this.clips;
  }

  /** Kick off decoding without playing (e.g. at the start of a wait, during the silent delay). */
  warm(): void {
    const ctx = this.prepare();
    if (ctx) void this.loadClips(ctx);
  }

  start(opts: StartOptions = {}): void {
    if (this.active) return;
    const ctx = this.prepare();
    if (!ctx) return;
    this.active = true;
    const gen = ++this.generation;
    const startedAt = Date.now();
    const cap = maxDurationMs();
    this.capTimer = window.setTimeout(() => this.stop(), cap);
    void this.loadClips(ctx).then((clips) => {
      if (!clips || !this.active || gen !== this.generation) return;
      try {
        this.play(ctx, clips, opts, Math.max(0, cap - (Date.now() - startedAt)));
      } catch {
        // playback failed -- stay silent
      }
    });
  }

  private play(ctx: AudioContext, clips: Clips, opts: StartOptions, remainingMs: number): void {
    if (remainingMs <= 0) return;
    const volume = opts.volume ?? DEFAULT_VOLUME;
    const seed = opts.seed ?? (Date.now() & 0xffffffff);
    const now = ctx.currentTime;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(volume, now + 0.03);
    master.connect(ctx.destination);
    this.master = master;

    const readingGain = ctx.createGain();
    readingGain.gain.setValueAtTime(1, now);
    readingGain.connect(master);

    const reading = ctx.createBufferSource();
    reading.buffer = clips.launch;
    const loop = readingLoopPoints(clips.launch.duration);
    if (loop) {
      reading.loop = true;
      reading.loopStart = loop.loopStart;
      reading.loopEnd = loop.loopEnd;
    }
    reading.connect(readingGain);
    reading.start(now);
    this.sources.push(reading);

    if (!loop || !clips.load) return;
    const burstMs = clips.load.duration * 1000;
    for (const offsetMs of scheduleSeekBursts(seed, remainingMs, { burstMs })) {
      const at = now + offsetMs / 1000;
      const end = at + clips.load.duration;
      readingGain.gain.setValueAtTime(1, at);
      readingGain.gain.linearRampToValueAtTime(DUCK_LEVEL, at + 0.05);
      readingGain.gain.setValueAtTime(DUCK_LEVEL, end - 0.05);
      readingGain.gain.linearRampToValueAtTime(1, end);
      const seek = ctx.createBufferSource();
      seek.buffer = clips.load;
      seek.connect(master);
      seek.start(at);
      this.sources.push(seek);
    }
  }

  stop(): void {
    this.generation++;
    if (!this.active) return;
    this.active = false;
    if (this.capTimer !== null) window.clearTimeout(this.capTimer);
    this.capTimer = null;

    const ctx = this.ctx;
    const fade = spinDownMs() / 1000;
    let stopAt = 0;
    if (ctx) {
      const now = ctx.currentTime;
      stopAt = now + fade + 0.02;
      if (this.master) {
        try {
          this.master.gain.cancelScheduledValues(now);
          this.master.gain.setValueAtTime(this.master.gain.value, now);
          this.master.gain.linearRampToValueAtTime(0, now + fade);
        } catch {
          // ignore
        }
      }
    }
    for (const src of this.sources) {
      try {
        src.stop(stopAt);
      } catch {
        // never started or already stopped -- ignore
      }
    }
    this.sources = [];
    this.master = null;
  }
}

let sharedEngine: FloppyEngine | null = null;
function getEngine(): FloppyEngine {
  if (!sharedEngine) sharedEngine = new FloppyEngine();
  return sharedEngine;
}

/** Schedules playback to begin after startDelayMs() (so fast actions stay silent) and returns a
 * function that stops it -- call that when the action settles, whether or not it had actually
 * started playing yet. Creates/resumes the audio context and starts decoding right away (call it
 * from the user's gesture). Never throws if Web Audio is unavailable. */
export function playFloppyAfterDelay(opts: StartOptions = {}): () => void {
  if (typeof window === "undefined") return () => {};
  try {
    getEngine().warm();
  } catch {
    // ignore
  }
  const timer = window.setTimeout(() => {
    try {
      getEngine().start(opts);
    } catch {
      // unsupported browser, blocked context, ... -- fail silent
    }
  }, startDelayMs());
  return () => {
    window.clearTimeout(timer);
    try {
      getEngine().stop();
    } catch {
      // ignore
    }
  };
}

/** Wraps a user-initiated request: plays the floppy sound (if enabled) for as long as the promise
 * is pending, starting only after startDelayMs() and stopping (with a short spin-down) once it
 * settles. A no-op passthrough when sound is off or Web Audio is unavailable. Only call this for
 * waits the user just started by clicking/submitting something -- never for background polling or
 * SSE updates, so playback always follows a user gesture. */
export function withFloppySound<T>(promise: Promise<T>): Promise<T> {
  if (!isSoundEnabled()) return promise;
  const stop = playFloppyAfterDelay();
  return promise.finally(stop);
}
