// Optional floppy-drive sound for user-initiated waits (send, create, wake/stop/abort, refresh,
// token create). Synthesized with the Web Audio API -- a low detuned motor hum plus irregular
// head-seek clicks, 1541/early-Mac flavoured -- rather than a sampled recording, to avoid
// licensing and bundle weight. Off by default; see SoundToggle.tsx for the header control and
// isSoundEnabled/setSoundEnabled below for the persisted preference.
//
// This module is split into pure, seed-driven scheduling functions (tested in
// test/floppy-sound.test.ts) and a small stateful audio engine that consumes them (not unit
// tested -- there is no meaningful assertion to make on an AudioContext graph; it's exercised
// manually, see docs/reports/design-pass.md).

const STORAGE_KEY = "outfitterSound";
export const DEFAULT_VOLUME = 0.12;

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

/** mulberry32 -- a small, fast, seedable PRNG. Deterministic for a given seed, which is what
 * makes scheduleSeekClicks testable without mocking Math.random. */
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

export interface SeekClickOptions {
  minGapMs?: number;
  maxGapMs?: number;
}

/** Irregular click offsets (ms from playback start) across `durationMs`, standing in for a drive
 * head seeking back and forth while "reading". Same seed -> same schedule. */
export function scheduleSeekClicks(seed: number, durationMs: number, opts: SeekClickOptions = {}): number[] {
  const minGapMs = opts.minGapMs ?? 70;
  const maxGapMs = opts.maxGapMs ?? 220;
  const rng = makeRng(seed);
  const times: number[] = [];
  let t = 0;
  while (t < durationMs) {
    t += minGapMs + rng() * (maxGapMs - minGapMs);
    if (t < durationMs) times.push(Math.round(t));
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

class FloppyEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private hum: OscillatorNode | null = null;
  private vibrato: OscillatorNode | null = null;
  private clickTimers: number[] = [];
  private capTimer: number | null = null;
  private active = false;

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === "undefined") return null;
    try {
      const Ctor: AudioContextCtor | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  start(opts: StartOptions = {}): void {
    if (this.active) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    this.active = true;
    const volume = opts.volume ?? DEFAULT_VOLUME;
    const seed = opts.seed ?? (Date.now() & 0xffffffff);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    master.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.15);
    this.master = master;

    const hum = ctx.createOscillator();
    hum.type = "sawtooth";
    hum.frequency.value = 110;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.5;
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 5.5;
    const vibratoGain = ctx.createGain();
    vibratoGain.gain.value = 4;
    vibrato.connect(vibratoGain);
    vibratoGain.connect(hum.frequency);
    hum.connect(humGain);
    humGain.connect(master);
    hum.start();
    vibrato.start();
    this.hum = hum;
    this.vibrato = vibrato;

    const cap = maxDurationMs();
    for (const t of scheduleSeekClicks(seed, cap)) {
      this.clickTimers.push(window.setTimeout(() => this.click(volume), t));
    }
    this.capTimer = window.setTimeout(() => this.stop(), cap);
  }

  private click(volume: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 180 + Math.random() * 260;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(volume * 1.4, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const id of this.clickTimers) window.clearTimeout(id);
    this.clickTimers = [];
    if (this.capTimer !== null) window.clearTimeout(this.capTimer);
    this.capTimer = null;

    const ctx = this.ctx;
    const fade = spinDownMs() / 1000;
    if (ctx && this.master) {
      const now = ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0, now + fade);
    }
    const stopAt = ctx ? ctx.currentTime + fade + 0.02 : 0;
    try {
      this.hum?.stop(stopAt);
      this.vibrato?.stop(stopAt);
    } catch {
      // already stopped -- ignore
    }
    this.hum = null;
    this.vibrato = null;
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
 * started playing yet. Never throws if Web Audio is unavailable. */
export function playFloppyAfterDelay(opts: StartOptions = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const timer = window.setTimeout(() => {
    try {
      getEngine().start(opts);
    } catch {
      // synthesis failed (unsupported browser, blocked context, ...) -- fail silent
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
