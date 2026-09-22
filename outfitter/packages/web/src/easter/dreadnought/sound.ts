// Tiny Web Audio blips for the easter egg -- laser, explosion, pickup, hit, game-over. Same
// approach as src/lib/floppy-sound.ts (synthesized square/noise, no audio files) and gated by the
// same persisted app-wide sound preference (isSoundEnabled), so the game never makes noise unless
// the user has turned the header's floppy-sound toggle on. One AudioContext, created lazily and
// reused; every call is wrapped so a browser without Web Audio (or a suspended/blocked context)
// fails silently instead of throwing.

import { isSoundEnabled } from "../../lib/floppy-sound.ts";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function beep(freq: number, durationMs: number, type: OscillatorType, gainValue: number): void {
  if (!isSoundEnabled()) return;
  try {
    const audio = getCtx();
    if (!audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audio.currentTime);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(gainValue, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + durationMs / 1000 + 0.02);
  } catch {
    // best-effort only
  }
}

export function playLaser(): void {
  beep(880, 90, "square", 0.05);
}

export function playExplosion(): void {
  if (!isSoundEnabled()) return;
  try {
    const audio = getCtx();
    if (!audio) return;
    const bufferSize = audio.sampleRate * 0.2;
    const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const noise = audio.createBufferSource();
    noise.buffer = buffer;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.12, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.2);
    noise.connect(gain);
    gain.connect(audio.destination);
    noise.start();
  } catch {
    // best-effort only
  }
}

export function playPickup(): void {
  beep(1320, 120, "square", 0.05);
}

export function playHit(): void {
  beep(160, 200, "sawtooth", 0.06);
}

export function playGameOver(): void {
  beep(220, 500, "triangle", 0.06);
}
