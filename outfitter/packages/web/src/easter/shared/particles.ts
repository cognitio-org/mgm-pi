// Tiny particle + screen-shake + floating-text system shared by both games' renderers.
// Deliberately kept out of the pure engines (engine.ts in each game folder): all of this is a
// rendering flourish, not game logic, and giving it its own tiny mutable-array update loop keeps
// the tested engines free of anything non-deterministic-looking. `prefers-reduced-motion` calmer
// mode is handled by the caller: pass a smaller `count`/shorter life and skip spawnShake entirely.

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifeMs: number;
  maxLifeMs: number;
  color: string;
  /** Rendered size in px (a few varied sizes reads as "debris chunks" rather than uniform dust). */
  size: number;
}

/** A burst of explosion debris: falls under gravity, varied size/speed so it reads as chunks
 * tumbling outward rather than a uniform ring of dots. */
export function spawnExplosionParticles(x: number, y: number, count: number, color: string): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const speed = 40 + Math.random() * 120;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      lifeMs: 260 + Math.random() * 220,
      maxLifeMs: 480,
      color,
      size: 2 + Math.round(Math.random() * 2),
    });
  }
  return particles;
}

/** A small, bright, upward-biased burst for a pickup/board/score event -- no gravity pull (or very
 * little), short life, reads as a sparkle rather than debris. */
export function spawnSparkle(x: number, y: number, count: number, color: string): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.4; // mostly upward, some spread
    const speed = 20 + Math.random() * 40;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      lifeMs: 220 + Math.random() * 160,
      maxLifeMs: 380,
      color,
      size: 1 + Math.round(Math.random()),
    });
  }
  return particles;
}

/** Advances particles by dtMs and drops dead ones. Mutates nothing -- returns a new array, same
 * spirit as the pure engines even though this one lives outside them. `gravity` (px/s^2, default
 * 220) lets callers opt debris-style particles into falling and sparkles/smoke into floating (pass
 * a small or negative value). */
export function stepParticles(particles: Particle[], dtMs: number, gravity = 220): Particle[] {
  const dt = dtMs / 1000;
  const next: Particle[] = [];
  for (const p of particles) {
    const lifeMs = p.lifeMs - dtMs;
    if (lifeMs <= 0) continue;
    next.push({ ...p, x: p.x + p.vx * dt, y: p.y + p.vy * dt, vy: p.vy + gravity * dt, lifeMs });
  }
  return next;
}

export interface ShakeState {
  remainingMs: number;
  magnitude: number;
}

export function triggerShake(magnitude: number): ShakeState {
  return { remainingMs: 220, magnitude };
}

export function stepShake(shake: ShakeState | null, dtMs: number): ShakeState | null {
  if (!shake) return null;
  const remainingMs = shake.remainingMs - dtMs;
  if (remainingMs <= 0) return null;
  return { ...shake, remainingMs };
}

/** Deterministic-enough shake offset for a given elapsed time -- not seeded/tested (purely a
 * cosmetic wobble), but pure so callers can compute it without extra state. */
export function shakeOffset(shake: ShakeState | null): [number, number] {
  if (!shake) return [0, 0];
  const decay = shake.remainingMs / 220;
  const amt = shake.magnitude * decay;
  return [(Math.random() * 2 - 1) * amt, (Math.random() * 2 - 1) * amt];
}

// --- floating score-pop text ("+100"), and a short "hit flash" timer ------------------------------

export interface TextPopup {
  x: number;
  y: number;
  text: string;
  color: string;
  lifeMs: number;
  maxLifeMs: number;
}

export function spawnTextPopup(x: number, y: number, text: string, color = "#f4cf3c"): TextPopup {
  return { x, y, text, color, lifeMs: 700, maxLifeMs: 700 };
}

export function stepTextPopups(popups: TextPopup[], dtMs: number): TextPopup[] {
  const dt = dtMs / 1000;
  const next: TextPopup[] = [];
  for (const p of popups) {
    const lifeMs = p.lifeMs - dtMs;
    if (lifeMs <= 0) continue;
    next.push({ ...p, y: p.y - 16 * dt, lifeMs });
  }
  return next;
}

/** A brief full-canvas damage flash: draw a translucent overlay while remainingMs > 0, fading out
 * linearly. Reduced-motion callers should skip triggering it (or use a much shorter duration). */
export interface FlashState {
  remainingMs: number;
  maxMs: number;
  color: string;
}

export function triggerFlash(color = "#ff8a8a", durationMs = 140): FlashState {
  return { remainingMs: durationMs, maxMs: durationMs, color };
}

export function stepFlash(flash: FlashState | null, dtMs: number): FlashState | null {
  if (!flash) return null;
  const remainingMs = flash.remainingMs - dtMs;
  if (remainingMs <= 0) return null;
  return { ...flash, remainingMs };
}
