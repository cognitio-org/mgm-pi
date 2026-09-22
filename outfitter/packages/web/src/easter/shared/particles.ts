// Tiny explosion-particle + screen-shake system shared by both games' renderers. Deliberately kept
// out of the pure engines (engine.ts in each game folder): particles are a rendering flourish, not
// game logic, and giving them their own tiny mutable-array update loop keeps the tested engines
// free of anything non-deterministic-looking. `prefers-reduced-motion` calmer mode is handled by
// the caller: pass a smaller `count` and skip spawnShake entirely.

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifeMs: number;
  maxLifeMs: number;
  color: string;
}

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
    });
  }
  return particles;
}

/** Advances particles by dtMs and drops dead ones. Mutates nothing -- returns a new array, same
 * spirit as the pure engines even though this one lives outside them. */
export function stepParticles(particles: Particle[], dtMs: number): Particle[] {
  const dt = dtMs / 1000;
  const next: Particle[] = [];
  for (const p of particles) {
    const lifeMs = p.lifeMs - dtMs;
    if (lifeMs <= 0) continue;
    next.push({ ...p, x: p.x + p.vx * dt, y: p.y + p.vy * dt, vy: p.vy + 220 * dt, lifeMs });
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
