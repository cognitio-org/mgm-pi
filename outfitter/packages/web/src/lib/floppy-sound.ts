// Optional floppy-drive sound for user-initiated waits (send, create, wake/stop/abort, refresh,
// token create). Plays real drive recordings -- the same two clips the kernal.one landing page
// uses (public/sounds/, credits in public/sounds/CREDITS.md):
//
//   launch.mp3 (~4.7 s): a head seek (0 - ~2.25 s), then the drive reading (~2.4 - ~4.4 s), then a
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
// and cached; a failed load is retried on a later wait after a backoff. Everything fails silent:
// no Web Audio, a failed fetch or a failed decode just means no sound. Overlapping waits share one
// playback (reference-counted, see FloppyEngine), and the AudioContext is suspended once nothing is
// waiting. The timing and loop-point math is pure and tested in test/floppy-sound.test.ts, as is
// the refcounting against a fake AudioContext; the sound itself is checked by ear.

const STORAGE_KEY = "outfitterSound";
export const DEFAULT_VOLUME = 0.45;

/** Loop section of launch.mp3 (seconds): the drive reading, between the initial seek and the tail.
 *
 * Both points sit in quiet spots so the seam doesn't click, and they are chosen to stay quiet under
 * MP3 encoder delay. The file carries an Info/LAME header (start 0.046 s, 24 kHz mono) whose
 * delay/padding some decoders honour (Chrome, Firefox, ffmpeg: 4.700 s buffer) and some may not
 * (4.752 s buffer, everything ~46-52 ms later), so a point picked on one decode can land on a head
 * click in the other. The old 2.45 / 4.4 did exactly that: fine trimmed, but on a transient
 * (20 ms RMS 0.040 / 0.059, vs ~0.07 overall) untrimmed. Measured by decoding both ways with ffmpeg
 * and taking 20 ms RMS windows in 5 ms steps, the worst case over both decodes and +-10 ms of slop
 * is ~0.006 at 2.32 (the gap after the seek, just before the first read click) and ~0.011 at 4.47
 * (the start of the tail, after the last read click). */
export const LAUNCH_READING_START_S = 2.32;
export const LAUNCH_READING_END_S = 4.47;

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

/** How long to wait before retrying the clip download after `failures` consecutive failed loads:
 * 15 s, doubling per failure, capped at 5 minutes (0 when nothing has failed). */
export function clipRetryDelayMs(failures: number): number {
  if (!(failures > 0)) return 0;
  return Math.min(15_000 * 2 ** (failures - 1), 300_000);
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

/** One playback of the clips: its audio graph, plus the cap timer that ends it. */
interface Playback {
  opts: StartOptions;
  /** Callers past their start delay that joined this playback and haven't settled yet. */
  holders: number;
  master: GainNode | null;
  sources: AudioBufferSourceNode[];
  capTimer: number | null;
}

/** Shared by every caller (withFloppySound waits, the Manual tour). Reference-counted: each caller
 * `open()`s when its wait begins, `hold()`s once its start delay has passed, and `release()`s when
 * it settles. The sound runs while at least one caller holds it and fades only when the last one
 * lets go, so a quick wait settling can't cut off a long one, and a caller that passes its delay
 * while another is already playing just joins that playback. The 20 s cap is per playback: when it
 * hits, everyone holding that playback is done, and only a caller that passes its delay afterwards
 * starts a fresh one (which its own settling then ends). */
class FloppyEngine {
  private ctx: AudioContext | null = null;
  private clips: Promise<Clips | null> | null = null;
  private clipFailures = 0;
  private clipsFailedAt = 0;
  /** Callers between open() and release(), including those still in their silent start delay. */
  private callers = 0;
  private playback: Playback | null = null;
  private suspendTimer: number | null = null;

  /** Creates (or resumes) the shared context. Called synchronously from the user's gesture where
   * possible, so the browser lets it run. */
  private prepare(): AudioContext | null {
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

  /** Fetches and decodes the clips once and caches them. A failure resolves to null (silence) and
   * is not cached for good: the next wait after clipRetryDelayMs() tries again, so a transient
   * network blip doesn't mute the whole session, while waits inside the backoff don't refetch. */
  private loadClips(ctx: AudioContext): Promise<Clips | null> {
    if (this.clips) return this.clips;
    if (this.clipFailures > 0 && Date.now() - this.clipsFailedAt < clipRetryDelayMs(this.clipFailures)) {
      return Promise.resolve(null);
    }
    const attempt = (async (): Promise<Clips | null> => {
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
    this.clips = attempt;
    void attempt.then((clips) => {
      if (clips) {
        this.clipFailures = 0;
        return;
      }
      if (this.clips === attempt) this.clips = null;
      this.clipFailures++;
      this.clipsFailedAt = Date.now();
    });
    return attempt;
  }

  /** A caller's wait began: resume the context and start decoding during the silent delay. */
  open(): void {
    this.callers++;
    this.cancelSuspend();
    const ctx = this.prepare();
    if (ctx) void this.loadClips(ctx);
  }

  /** A caller's start delay passed: join the running playback, or start one. Returns the playback
   * to hand back to release(). */
  hold(opts: StartOptions = {}): Playback | null {
    if (this.playback) {
      this.playback.holders++;
      return this.playback;
    }
    const ctx = this.prepare();
    if (!ctx) return null;
    const pb: Playback = { opts, holders: 1, master: null, sources: [], capTimer: null };
    this.playback = pb;
    void this.loadClips(ctx).then((clips) => {
      if (!clips || this.playback !== pb) return;
      try {
        this.play(ctx, clips, pb);
      } catch {
        // playback failed -- stay silent
      }
    });
    return pb;
  }

  /** A caller's wait settled. `pb` is what its hold() returned (null if it never got past its start
   * delay). A playback that already hit its cap is gone; releasing it changes nothing. */
  release(pb: Playback | null): void {
    this.callers = Math.max(0, this.callers - 1);
    if (pb) {
      pb.holders = Math.max(0, pb.holders - 1);
      if (pb.holders === 0 && this.playback === pb) this.fadeOut();
    }
    if (this.callers === 0) this.scheduleSuspend();
  }

  private play(ctx: AudioContext, clips: Clips, pb: Playback): void {
    const cap = maxDurationMs();
    const volume = pb.opts.volume ?? DEFAULT_VOLUME;
    const seed = pb.opts.seed ?? (Date.now() & 0xffffffff);
    const now = ctx.currentTime;

    // The cap runs from when the sound actually starts (after decoding), once per playback.
    pb.capTimer = window.setTimeout(() => {
      if (this.playback === pb) this.fadeOut();
      if (this.callers === 0) this.scheduleSuspend();
    }, cap);

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(volume, now + 0.03);
    master.connect(ctx.destination);
    pb.master = master;

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
    pb.sources.push(reading);

    if (!loop || !clips.load) return;
    const burstMs = clips.load.duration * 1000;
    for (const offsetMs of scheduleSeekBursts(seed, cap, { burstMs })) {
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
      pb.sources.push(seek);
    }
  }

  /** Ends the current playback with a short spin-down (or drops a playback still decoding). */
  private fadeOut(): void {
    const pb = this.playback;
    if (!pb) return;
    this.playback = null;
    if (pb.capTimer !== null) window.clearTimeout(pb.capTimer);
    pb.capTimer = null;

    const ctx = this.ctx;
    const fade = spinDownMs() / 1000;
    let stopAt = 0;
    if (ctx) {
      const now = ctx.currentTime;
      stopAt = now + fade + 0.02;
      if (pb.master) {
        try {
          pb.master.gain.cancelScheduledValues(now);
          pb.master.gain.setValueAtTime(pb.master.gain.value, now);
          pb.master.gain.linearRampToValueAtTime(0, now + fade);
        } catch {
          // ignore
        }
      }
    }
    for (const src of pb.sources) {
      try {
        src.stop(stopAt);
      } catch {
        // never started or already stopped -- ignore
      }
    }
    pb.sources = [];
  }

  /** Once nothing is waiting and the last spin-down has finished, suspend the context so an idle
   * tab doesn't keep the audio device (and its CPU/battery cost) running. prepare() resumes it. */
  private scheduleSuspend(): void {
    this.cancelSuspend();
    if (!this.ctx) return;
    this.suspendTimer = window.setTimeout(() => {
      this.suspendTimer = null;
      const ctx = this.ctx;
      if (!ctx || this.callers > 0 || this.playback) return;
      try {
        if (ctx.state === "running") void ctx.suspend().catch(() => {});
      } catch {
        // ignore
      }
    }, spinDownMs() + 100);
  }

  private cancelSuspend(): void {
    if (this.suspendTimer !== null) window.clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
  }
}

let sharedEngine: FloppyEngine | null = null;
function getEngine(): FloppyEngine {
  if (!sharedEngine) sharedEngine = new FloppyEngine();
  return sharedEngine;
}

/** Tests only: drop the shared engine (and its context, clip cache and refcounts). */
export function resetFloppyEngineForTests(): void {
  sharedEngine = null;
}

/** Schedules playback to begin after startDelayMs() (so fast actions stay silent) and returns a
 * function that stops it -- call that when the action settles, whether or not it had actually
 * started playing yet; calling it again is a no-op. Overlapping callers share one playback, which
 * keeps going until the last of them stops. Creates/resumes the audio context and starts decoding
 * right away (call it from the user's gesture). Never throws if Web Audio is unavailable. */
export function playFloppyAfterDelay(opts: StartOptions = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const engine = getEngine();
  let held: ReturnType<FloppyEngine["hold"]> = null;
  let done = false;
  try {
    engine.open();
  } catch {
    // ignore
  }
  const timer = window.setTimeout(() => {
    if (done) return;
    try {
      held = engine.hold(opts);
    } catch {
      // unsupported browser, blocked context, ... -- fail silent
    }
  }, startDelayMs());
  return () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    try {
      engine.release(held);
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
