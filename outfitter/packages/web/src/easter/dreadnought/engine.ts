// Pure game-logic engine for the "Dreadnought Run" easter egg -- a horizontal scrolling shooter
// inspired by (not a copy of) Uridium: a small ship skims over a giant data-center "dreadnought",
// dodging server racks, shooting turrets and drones, and grabbing stray Floppies for score. No
// canvas/DOM code lives here so it can be unit tested deterministically (see
// test/dreadnought-engine.test.ts); DreadnoughtRun.tsx drives this with a fixed-timestep loop and
// does all drawing (pixel-art sprites, parallax hull layers, particles, screen shake).
//
// Everything here is a pure function of (state, input, dtMs) plus an explicit rng counter baked
// into the state -- same seed + same input sequence always produces the same run.

// Low-res "C64-style" logical canvas, rendered by DreadnoughtRun.tsx at an integer CSS scale with
// `image-rendering: pixelated`, so the ship/turrets/racks read as chunky, legible pixel art filling
// the frame instead of tiny specks lost in a big empty canvas. Sprite pixel sizes below (PLAYER_W/H,
// obstacle w/h) are kept close to their original absolute sizes -- shrinking the world instead of
// the sprites is what makes them read as proportionally larger on screen. WORLD_W/H were shrunk a
// second time (from an original 320x176 pass, itself already a shrink from 800x440) after a design
// review found the ship still small at a normal laptop window; every px/s and px/s^2 constant below
// is rescaled by the same 0.75 ratio (240/320) so flight feel is unchanged.
export const WORLD_W = 240;
export const WORLD_H = 132;
export const PLAYER_X = 27;
export const PLAYER_W = 26;
export const PLAYER_H = 14;
export const PLAYER_MIN_Y = 8;
export const PLAYER_MAX_Y = WORLD_H - 8 - PLAYER_H;

const PLAYER_ACCEL = 270; // px/s^2
const PLAYER_MAX_VY = 78; // px/s
const PLAYER_DRAG = 6; // 1/s, exponential damping when no thrust input
const BASE_SCROLL_SPEED = 51; // px/s
const MAX_SCROLL_SPEED = 126;
const SCROLL_SPEED_PER_DISTANCE = 0.02; // px/s gained per world-px travelled (dimensionless ratio, unaffected by the rescale)
const BULLET_SPEED = 186;
const ENEMY_BULLET_SPEED = 78;
const SHOOT_COOLDOWN_MS = 180;
const TURRET_FIRE_COOLDOWN_MS = 1400;
const DRONE_FIRE_COOLDOWN_MS = 1000;
const DRONE_AMPLITUDE = 18; // px, vertical sine sweep
const DRONE_ANGULAR_FREQ = 0.0022; // rad/ms
const INVULN_MS = 1200;
const START_LIVES = 3;
// Distance travelled before drones start appearing -- keeps the first stretch of a run to just
// racks + turrets so the third obstacle type reads as an escalation, not noise from second one.
const DRONE_UNLOCK_DISTANCE = 270;

export type Kind = "rack" | "turret" | "drone";

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
  /** Drones only: sine-wave motion phase parameters, baked in at spawn so movement is a pure
   * function of elapsed time (no per-frame RNG needed). */
  baseY?: number;
  phase?: number;
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

/** Emitted this step for the renderer to spawn a one-off visual (explosion particles, screen
 * shake) -- not carried forward in state, since it's consumed immediately by the caller. */
export interface GameEvent {
  type: "obstacleDestroyed" | "playerHit" | "pickupCollected";
  x: number;
  y: number;
  /** Score awarded by this event, for a renderer-drawn "+N" pop. Omitted for playerHit. */
  score?: number;
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
  lastHit: Kind | "enemyBullet" | null;
  events: GameEvent[];
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
    nextSpawnAtDistance: 78,
    invulnMs: 0,
    lastHit: null,
    events: [],
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
  const t = state.t + dtMs;
  const events: GameEvent[] = [];

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

  // --- obstacles: scroll left, drones sine-sweep, turrets/drones fire ---
  const obstacles: Obstacle[] = [];
  for (const o of state.obstacles) {
    const nx = o.x - scrollSpeed * dt;
    if (nx + o.w < -40) continue; // scrolled off, drop it
    let ny = o.y;
    if (o.kind === "drone" && o.baseY !== undefined && o.phase !== undefined) {
      ny = clamp(o.baseY + Math.sin(t * DRONE_ANGULAR_FREQ + o.phase) * DRONE_AMPLITUDE, PLAYER_MIN_Y, PLAYER_MAX_Y);
    }
    let fireCooldownMs = o.fireCooldownMs;
    if ((o.kind === "turret" || o.kind === "drone") && o.hp > 0) {
      fireCooldownMs -= dtMs;
      if (fireCooldownMs <= 0 && nx < WORLD_W) {
        enemyBullets.push({ x: nx, y: ny + o.h / 2, vx: -ENEMY_BULLET_SPEED });
        fireCooldownMs = o.kind === "drone" ? DRONE_FIRE_COOLDOWN_MS : TURRET_FIRE_COOLDOWN_MS;
      }
    }
    obstacles.push({ ...o, x: nx, y: ny, fireCooldownMs });
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
    const droneUnlocked = distance >= DRONE_UNLOCK_DISTANCE;
    if (roll < 0.5) {
      const h = 18 + Math.floor(rand() * 3) * 14;
      obstacles.push({
        x: WORLD_W + 10,
        y: PLAYER_MIN_Y + rand() * (WORLD_H - PLAYER_MIN_Y * 2 - h),
        w: 24,
        h,
        kind: "rack",
        hp: 1,
        fireCooldownMs: 0,
      });
    } else if (!droneUnlocked || roll < 0.8) {
      obstacles.push({
        x: WORLD_W + 10,
        y: PLAYER_MIN_Y + rand() * (WORLD_H - PLAYER_MIN_Y * 2 - 18),
        w: 18,
        h: 18,
        kind: "turret",
        hp: 2,
        fireCooldownMs: 400 + rand() * 800,
      });
    } else {
      const baseY = PLAYER_MIN_Y + rand() * (WORLD_H - PLAYER_MIN_Y * 2 - 16);
      obstacles.push({
        x: WORLD_W + 10,
        y: baseY,
        w: 16,
        h: 16,
        kind: "drone",
        hp: 1,
        fireCooldownMs: 300 + rand() * 500,
        baseY,
        phase: rand() * Math.PI * 2,
      });
    }
    if (rand() < 0.4) {
      pickups.push({ x: WORLD_W + 18 + rand() * 12, y: PLAYER_MIN_Y + rand() * (WORLD_H - PLAYER_MIN_Y * 2), taken: false });
    }
    nextSpawnAtDistance = distance + 39 + rand() * 27;
  }

  // --- collisions: player bullets vs obstacles ---
  let score = state.score;
  const survivingObstacles: Obstacle[] = [];
  for (const o of obstacles) {
    let hp = o.hp;
    let hitBulletIdx = -1;
    if (o.kind !== "rack" && hp > 0) {
      hitBulletIdx = bullets.findIndex((b) => rectsOverlap(b.x - 3, b.y - 3, 6, 6, o.x, o.y, o.w, o.h));
    }
    if (hitBulletIdx >= 0) {
      bullets.splice(hitBulletIdx, 1);
      hp -= 1;
      if (hp <= 0) {
        const gained = o.kind === "drone" ? 200 : 150;
        score += gained;
        events.push({ type: "obstacleDestroyed", x: o.x, y: o.y, score: gained });
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
      events.push({ type: "playerHit", x: px, y: playerY });
      if (hitBulletIdx >= 0) enemyBullets.splice(hitBulletIdx, 1);
    }
  }

  // --- collisions: player vs pickups ---
  const remainingPickups: Pickup[] = [];
  for (const p of pickups) {
    if (rectsOverlap(PLAYER_X, playerY, PLAYER_W, PLAYER_H, p.x - 6, p.y - 6, 12, 12)) {
      score += 50;
      events.push({ type: "pickupCollected", x: p.x, y: p.y, score: 50 });
      continue;
    }
    remainingPickups.push(p);
  }

  const status: GameStatus = lives <= 0 ? "gameover" : "playing";

  return {
    status,
    t,
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
    events,
  };
}

export function togglePause(state: GameState): GameState {
  if (state.status === "playing") return { ...state, status: "paused" };
  if (state.status === "paused") return { ...state, status: "playing" };
  return state;
}

/** Deterministic "bot" input for the title-screen attract-mode demo: a slow figure-eight-ish
 * weave with occasional firing, driven purely by elapsed time so the same seed always produces the
 * same demo run (no engine coupling needed beyond the timestamp already in GameState.t). Pure and
 * unit-testable on its own (see test/dreadnought-engine.test.ts). */
export function attractInput(t: number): GameInput {
  const wave = Math.sin(t * 0.0013);
  return {
    up: wave > 0.25,
    down: wave < -0.25,
    firing: Math.sin(t * 0.006) > 0.2,
  };
}

// High-score persistence now lives in ../shared/highscore.ts (one per-game localStorage key, read
// by the menu too) -- DreadnoughtRun.tsx imports readHighScore/writeHighScoreIfBetter from there.
