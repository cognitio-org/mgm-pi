// Pure game-logic engine for the "Dreadnought Run" easter egg -- a horizontal scrolling shooter
// inspired by (not a copy of) Uridium: a small ship skims over a giant data-center "dreadnought",
// dodging server racks, shooting turrets, and grabbing stray Floppies for score. No canvas/DOM
// code lives here so it can be unit tested deterministically (see test/easter-engine.test.ts);
// EasterEgg.tsx drives this with a requestAnimationFrame loop and does all drawing.
//
// Everything here is a pure function of (state, input, dtMs) plus an explicit rng counter baked
// into the state -- same seed + same input sequence always produces the same run.

export const WORLD_W = 800;
export const WORLD_H = 440;
export const PLAYER_X = 90;
export const PLAYER_W = 26;
export const PLAYER_H = 14;
export const PLAYER_MIN_Y = 24;
export const PLAYER_MAX_Y = WORLD_H - 24 - PLAYER_H;

const PLAYER_ACCEL = 900; // px/s^2
const PLAYER_MAX_VY = 260; // px/s
const PLAYER_DRAG = 6; // 1/s, exponential damping when no thrust input
const BASE_SCROLL_SPEED = 170; // px/s
const MAX_SCROLL_SPEED = 420;
const SCROLL_SPEED_PER_DISTANCE = 0.02; // px/s gained per world-px travelled
const BULLET_SPEED = 620;
const ENEMY_BULLET_SPEED = 260;
const SHOOT_COOLDOWN_MS = 180;
const TURRET_FIRE_COOLDOWN_MS = 1400;
const INVULN_MS = 1200;
const START_LIVES = 3;

export type Kind = "rack" | "turret";

export interface Bullet {
  x: number;
  y: number;
  vx: number;
}

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: Kind;
  hp: number;
  fireCooldownMs: number;
}

export interface Pickup {
  x: number;
  y: number;
  taken: boolean;
}

export type GameStatus = "playing" | "paused" | "gameover";

export interface GameInput {
  up: boolean;
  down: boolean;
  firing: boolean;
}

export interface GameState {
  status: GameStatus;
  t: number;
  rngState: number;
  playerY: number;
  playerVy: number;
  scrollSpeed: number;
  distance: number;
  score: number;
  lives: number;
  bullets: Bullet[];
  enemyBullets: Bullet[];
  obstacles: Obstacle[];
  pickups: Pickup[];
  shootCooldownMs: number;
  nextSpawnAtDistance: number;
  invulnMs: number;
  lastHit: "rack" | "turret" | "enemyBullet" | null;
}

/** mulberry32, same construction as src/lib/floppy-sound.ts's makeRng -- small, fast, seedable,
 * and deterministic, but reimplemented here as a pure (state -> [value, nextState]) step so it
 * can live inside GameState without a closure, keeping the whole engine pure. */
export function nextRandom(rngState: number): [number, number] {
  let a = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, a];
}

export function createInitialState(seed: number): GameState {
  return {
    status: "playing",
    t: 0,
    rngState: seed >>> 0,
    playerY: WORLD_H / 2 - PLAYER_H / 2,
    playerVy: 0,
    scrollSpeed: BASE_SCROLL_SPEED,
    distance: 0,
    score: 0,
    lives: START_LIVES,
    bullets: [],
    enemyBullets: [],
    obstacles: [],
    pickups: [],
    shootCooldownMs: 0,
    nextSpawnAtDistance: 260,
    invulnMs: 0,
    lastHit: null,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function rectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** Advances one physics step. A no-op (returns the same reference) when not "playing", so callers
 * can always call step() unconditionally without special-casing pause/gameover. */
export function step(state: GameState, input: GameInput, dtMs: number): GameState {
  if (state.status !== "playing") return state;
  const dt = Math.min(dtMs, 50) / 1000; // clamp huge deltas (tab switch, devtools pause)

  let rngState = state.rngState;
  const rand = (): number => {
    const [v, next] = nextRandom(rngState);
    rngState = next;
    return v;
  };

  // --- player ---
  let vy = state.playerVy;
  if (input.up && !input.down) vy -= PLAYER_ACCEL * dt;
  else if (input.down && !input.up) vy += PLAYER_ACCEL * dt;
  else vy *= Math.max(0, 1 - PLAYER_DRAG * dt);
  vy = clamp(vy, -PLAYER_MAX_VY, PLAYER_MAX_VY);
  let playerY = clamp(state.playerY + vy * dt, PLAYER_MIN_Y, PLAYER_MAX_Y);
  if (playerY === PLAYER_MIN_Y || playerY === PLAYER_MAX_Y) vy = 0;

  // --- world scroll / difficulty ---
  const distance = state.distance + state.scrollSpeed * dt;
  const scrollSpeed = clamp(BASE_SCROLL_SPEED + distance * SCROLL_SPEED_PER_DISTANCE, BASE_SCROLL_SPEED, MAX_SCROLL_SPEED);

  // --- shooting ---
  let shootCooldownMs = Math.max(0, state.shootCooldownMs - dtMs);
  const bullets = state.bullets
    .map((b) => ({ ...b, x: b.x + b.vx * dt }))
    .filter((b) => b.x < WORLD_W + 20 && b.x > -20);
  if (input.firing && shootCooldownMs === 0) {
    bullets.push({ x: PLAYER_X + PLAYER_W, y: playerY + PLAYER_H / 2 - 2, vx: BULLET_SPEED });
    shootCooldownMs = SHOOT_COOLDOWN_MS;
  }

  // --- enemy bullets ---
  const enemyBullets = state.enemyBullets
    .map((b) => ({ ...b, x: b.x + b.vx * dt }))
    .filter((b) => b.x > -20 && b.x < WORLD_W + 20);

  // --- obstacles: scroll left, turrets fire ---
  const obstacles: Obstacle[] = [];
  for (const o of state.obstacles) {
    const nx = o.x - scrollSpeed * dt;
    if (nx + o.w < -40) continue; // scrolled off, drop it
    let fireCooldownMs = o.fireCooldownMs;
    if (o.kind === "turret" && o.hp > 0) {
      fireCooldownMs -= dtMs;
      if (fireCooldownMs <= 0 && nx < WORLD_W) {
        enemyBullets.push({ x: nx, y: o.y + o.h / 2, vx: -ENEMY_BULLET_SPEED });
        fireCooldownMs = TURRET_FIRE_COOLDOWN_MS;
      }
    }
    obstacles.push({ ...o, x: nx, fireCooldownMs });
  }

  // --- pickups: scroll left ---
  const pickups: Pickup[] = [];
  for (const p of state.pickups) {
    const nx = p.x - scrollSpeed * dt;
    if (nx < -40 || p.taken) continue;
    pickups.push({ ...p, x: nx });
  }

  // --- spawn new content as the dreadnought scrolls by ---
  let nextSpawnAtDistance = state.nextSpawnAtDistance;
  if (distance >= nextSpawnAtDistance) {
    const roll = rand();
    if (roll < 0.55) {
      const h = 40 + Math.floor(rand() * 3) * 30;
      obstacles.push({
        x: WORLD_W + 20,
        y: PLAYER_MIN_Y + rand() * (WORLD_H - PLAYER_MIN_Y * 2 - h),
        w: 26,
        h,
        kind: "rack",
        hp: 1,
        fireCooldownMs: 0,
      });
    } else {
      obstacles.push({
        x: WORLD_W + 20,
        y: PLAYER_MIN_Y + rand() * (WORLD_H - PLAYER_MIN_Y * 2 - 20),
        w: 20,
        h: 20,
        kind: "turret",
        hp: 2,
        fireCooldownMs: 400 + rand() * 800,
      });
    }
    if (rand() < 0.4) {
      pickups.push({ x: WORLD_W + 60 + rand() * 40, y: PLAYER_MIN_Y + rand() * (WORLD_H - PLAYER_MIN_Y * 2), taken: false });
    }
    nextSpawnAtDistance = distance + 130 + rand() * 90;
  }

  // --- collisions: player bullets vs obstacles ---
  let score = state.score;
  const survivingObstacles: Obstacle[] = [];
  for (const o of obstacles) {
    let hp = o.hp;
    let hitBulletIdx = -1;
    if (o.kind === "turret" && hp > 0) {
      hitBulletIdx = bullets.findIndex((b) => rectsOverlap(b.x - 3, b.y - 3, 6, 6, o.x, o.y, o.w, o.h));
    }
    if (hitBulletIdx >= 0) {
      bullets.splice(hitBulletIdx, 1);
      hp -= 1;
      if (hp <= 0) {
        score += 150;
        continue; // destroyed, drop it
      }
    }
    survivingObstacles.push({ ...o, hp });
  }

  // --- collisions: player vs obstacles / enemy bullets ---
  let lives = state.lives;
  let invulnMs = Math.max(0, state.invulnMs - dtMs);
  let lastHit = state.lastHit;
  if (invulnMs === 0) {
    const px = PLAYER_X;
    const hitObstacle = survivingObstacles.find((o) => rectsOverlap(px, playerY, PLAYER_W, PLAYER_H, o.x, o.y, o.w, o.h));
    const hitBulletIdx = enemyBullets.findIndex((b) => rectsOverlap(b.x - 3, b.y - 3, 6, 6, px, playerY, PLAYER_W, PLAYER_H));
    if (hitObstacle || hitBulletIdx >= 0) {
      lives -= 1;
      invulnMs = INVULN_MS;
      lastHit = hitObstacle ? hitObstacle.kind : "enemyBullet";
      if (hitBulletIdx >= 0) enemyBullets.splice(hitBulletIdx, 1);
    }
  }

  // --- collisions: player vs pickups ---
  const remainingPickups: Pickup[] = [];
  for (const p of pickups) {
    if (rectsOverlap(PLAYER_X, playerY, PLAYER_W, PLAYER_H, p.x - 6, p.y - 6, 12, 12)) {
      score += 50;
      continue;
    }
    remainingPickups.push(p);
  }

  const status: GameStatus = lives <= 0 ? "gameover" : "playing";

  return {
    status,
    t: state.t + dtMs,
    rngState,
    playerY,
    playerVy: vy,
    scrollSpeed,
    distance,
    score,
    lives,
    bullets,
    enemyBullets,
    obstacles: survivingObstacles,
    pickups: remainingPickups,
    shootCooldownMs,
    nextSpawnAtDistance,
    invulnMs,
    lastHit,
  };
}

export function togglePause(state: GameState): GameState {
  if (state.status === "playing") return { ...state, status: "paused" };
  if (state.status === "paused") return { ...state, status: "playing" };
  return state;
}

const HIGH_SCORE_KEY = "outfitterEasterHighScore";

export function readHighScore(): number {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeHighScoreIfBetter(score: number): number {
  const current = readHighScore();
  if (score <= current) return current;
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(Math.floor(score)));
  } catch {
    // best-effort only, matches floppy-sound.ts / ThemeToggle.tsx convention
  }
  return score;
}
