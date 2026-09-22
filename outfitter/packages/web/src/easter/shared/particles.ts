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
  /** Rendered size in px for plain dot particles. */
  size: number;
  /** "chunk" = a tumbling debris sprite, "star" = a 3-frame sparkle, omitted = a plain dot (see
   * shared/fx.ts's drawParticles). */
  kind?: "chunk" | "star";
  /** Which debris sprite a chunk uses. */
  variant?: number;
}

/** A burst of explosion debris: every other particle is a tumbling metal chunk sprite (tinted
 * `color` on its lit edge), the rest hot 1-2px sparks, thrown mostly upward so gravity arcs them
 * back down -- reads as wreckage flying apart, not a uniform ring of dots. */
export function spawnExplosionParticles(x: number, y: number, count: number, color: string): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const chunk = i % 2 === 0;
    const speed = chunk ? 30 + Math.random() * 50 : 50 + Math.random() * 70;
    const life = chunk ? 700 + Math.random() * 400 : 300 + Math.random() * 250;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - (chunk ? 45 : 20),
      lifeMs: life,
      maxLifeMs: life,
      color: chunk ? color : i % 3 === 0 ? "#fff6cf" : "#f4cf3c",
      size: 1 + (i % 3 === 1 ? 1 : 0),
      kind: chunk ? "chunk" : undefined,
      variant: i,
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
      lifeMs: 380 + Math.random() * 200,
      maxLifeMs: 580,
      color,
      size: 1,
      // a few proper 4-point twinkles among the plain glints
      kind: i % 3 === 0 ? "star" : undefined,
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
  return { x, y, text, color, lifeMs: 900, maxLifeMs: 900 };
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
