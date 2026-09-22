// Web Audio synthesis for Floppy Rescue -- rotor chop (loops while the blades are turning),
// pickup/board chirp, gentle-landing thud, crash, and game-over, all gated by the app-wide sound
// preference (isSoundEnabled) exactly like src/lib/floppy-sound.ts and dreadnought/sound.ts. No
// audio files; one shared AudioContext, created lazily and reused; every call is wrapped so a
// browser without Web Audio (or a blocked/suspended context) fails silently.

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

export function playBoard(): void {
  beep(980, 70, "square", 0.045);
}

export function playDeliver(): void {
  beep(1200, 140, "square", 0.05);
}

export function playFullLoadBonus(): void {
  beep(1600, 220, "triangle", 0.06);
}

export function playThud(): void {
  beep(90, 90, "sine", 0.05);
}

export function playCrash(): void {
  if (!isSoundEnabled()) return;
  try {
    const audio = getCtx();
    if (!audio) return;
    const bufferSize = audio.sampleRate * 0.25;
    const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const noise = audio.createBufferSource();
    noise.buffer = buffer;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.14, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    noise.connect(gain);
    gain.connect(audio.destination);
    noise.start();
  } catch {
    // best-effort only
  }
}

export function playGameOver(): void {
  beep(200, 550, "triangle", 0.06);
}

export function playFloppyLost(): void {
  beep(140, 160, "sawtooth", 0.045);
}

// --- rotor loop: a low chop that runs continuously while the game is "playing" (on or off ground
// doesn't matter -- the blades never stop), gated the same way as everything else here. ---
let rotorOsc: OscillatorNode | null = null;
let rotorGain: GainNode | null = null;
let rotorLfo: OscillatorNode | null = null;
let rotorActive = false;

export function startRotor(): void {
  if (rotorActive || !isSoundEnabled()) return;
  try {
    const audio = getCtx();
    if (!audio) return;
    rotorActive = true;
    const osc = audio.createOscillator();
    osc.type = "square";
    osc.frequency.value = 55;
    const gain = audio.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.035, audio.currentTime + 0.15);
    const lfo = audio.createOscillator();
    lfo.frequency.value = 9; // chop rate
    const lfoGain = audio.createGain();
    lfoGain.gain.value = 10;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    lfo.start();
    rotorOsc = osc;
    rotorGain = gain;
    rotorLfo = lfo;
  } catch {
    rotorActive = false;
  }
}

export function stopRotor(): void {
  if (!rotorActive) return;
  rotorActive = false;
  try {
    const audio = ctx;
    if (audio && rotorGain) {
      const now = audio.currentTime;
      rotorGain.gain.cancelScheduledValues(now);
      rotorGain.gain.setValueAtTime(rotorGain.gain.value, now);
      rotorGain.gain.linearRampToValueAtTime(0, now + 0.15);
      rotorOsc?.stop(now + 0.2);
      rotorLfo?.stop(now + 0.2);
    }
  } catch {
    // ignore
  }
  rotorOsc = null;
  rotorGain = null;
  rotorLfo = null;
}
