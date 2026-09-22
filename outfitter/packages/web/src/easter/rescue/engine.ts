// Pure game-logic engine for "Floppy Rescue" -- the main easter-egg game, inspired by (not a copy
// of) Choplifter: fly a pixel helicopter from the Disk Box (home base, left) out over a scrolling
// landscape to a burning server farm (right), land next to it, let little Floppy characters board
// (capacity 8), then fly them home to unload for score. No canvas/DOM code lives here so it can be
// unit tested deterministically (see test/rescue-engine.test.ts); FloppyRescue.tsx drives this
// with a fixed-timestep loop and does all drawing.
//
// Everything here is a pure function of (state, input, dtMs) plus an explicit rng counter baked
// into the state -- same seed + same input sequence always produces the same run.

export const WORLD_W = 800;
export const WORLD_H = 440;
export const GROUND_Y = WORLD_H - 60;
export const PLAYER_W = 30;
export const PLAYER_H = 16;
export const CAPACITY = 8;

// --- flight-feel tuning constants -------------------------------------------------------------
// Hand-tuned for "thrust, gravity, momentum, gentle-landing-required" per the brief. Numbers are
// px/s or px/s^2 in world units (WORLD_H = 440px tall). Documented in docs/reports/games.md.
const GRAVITY = 260; // px/s^2, constant downward pull
const THRUST_ACCEL = 560; // px/s^2 from holding "up" -- comfortably beats gravity so climbing feels responsive
const DOWN_ACCEL = 160; // px/s^2 extra from holding "down", gravity does most of the descent work
const H_ACCEL = 420; // px/s^2 lateral thrust
const H_DRAG = 2.4; // 1/s exponential damping on vx when no lateral input (keeps it from feeling icy)
const V_DRAG = 0.5; // 1/s mild damping on vy so hovering settles instead of oscillating forever
const MAX_VX = 230; // px/s
const MAX_VY = 230; // px/s
export const LANDING_SAFE_VY = 78; // px/s -- touch down slower than this or it's a crash
const TILT_MAX = 0.5; // radians, cosmetic lean toward direction of travel

const FUEL_MAX = 100;
const FUEL_DRAIN_PER_SEC = 3.0; // while airborne
const FUEL_REFILL_PER_SEC = 34; // while landed on the home pad

const BOARD_INTERVAL_MS = 420; // one Floppy boards this often while landed at the farm with room
const SCORE_PER_FLOPPY = 100;
const FULL_LOAD_BONUS = 400; // delivering all CAPACITY at once

const FIRE_CELL_COUNT = 6;
const FIRE_GROW_PER_SEC = 0.16; // how fast a burning cell's intensity climbs to 1 (fully lit)
const FIRE_IGNITE_THRESHOLD = 0.55; // a burning neighbour above this can ignite the next cell
const FIRE_SPREAD_STARTER = 0.05; // intensity a freshly-ignited neighbour starts at

const LEVEL_INTRO_MS = 2200;
const HOME_PAD_W = 160;
const FARM_PAD_W = 220;

export type GameStatus = "playing" | "paused" | "gameover" | "levelIntro";

export interface GameInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface Debris {
  x: number;
  y: number;
  vy: number;
}

export interface DroneBullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Drone {
  x: number;
  y: number;
  dir: 1 | -1;
  patrolMinX: number;
  patrolMaxX: number;
  fireCooldownMs: number;
}

export interface FireCell {
  x: number;
  w: number;
  intensity: number; // 0 (unlit) .. 1 (fully burning)
}

export interface Floppy {
  x: number;
  y: number;
  alive: boolean;
  boarded: boolean;
}

export interface GameState {
  status: GameStatus;
  t: number;
  rngState: number;
  level: number;
  levelIntroMsLeft: number;
  levelText: string;

  levelW: number;
  homeX: number; // left edge of the home pad
  farmX: number; // left edge of the farm pad

  playerX: number;
  playerY: number;
  playerVx: number;
  playerVy: number;
  cameraX: number;

  fuel: number;
  lives: number;
  score: number;
  onBoard: number;
  deliveredThisLevel: number;

  floppies: Floppy[];
  fireCells: FireCell[];
  debris: Debris[];
  drone: Drone | null;
  droneBullets: DroneBullet[];

  invulnMs: number;
  lastEventMs: number;
  boardCooldownMs: number;
  debrisSpawnCooldownMs: number;
  events: GameEvent[];
}

export interface GameEvent {
  type: "boarded" | "delivered" | "crash" | "floppyLost" | "levelComplete";
  count?: number;
}

/** mulberry32 -- same construction as src/lib/floppy-sound.ts's makeRng, reimplemented as a pure
 * (state -> [value, nextState]) step so it can live inside GameState without a closure. */
export function nextRandom(rngState: number): [number, number] {
  let a = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, a];
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

function levelWidth(level: number): number {
  return 1800 + (level - 1) * 260;
}

function floppyCountForLevel(level: number): number {
  return Math.min(6 + (level - 1) * 2, CAPACITY * 2);
}

function levelText(level: number): string {
  if (level === 1) return `LEVEL 1: RESCUE THE FLOPPIES`;
  if (level === 2) return `LEVEL 2: THE SERVER FARM IS SPREADING`;
  if (level === 3) return `LEVEL 3: GLITCH DRONE INBOUND`;
  return `LEVEL ${level}: HOLD THE LINE`;
}

function makeFireCells(rngState: number, farmX: number): [FireCell[], number] {
  let rs = rngState;
  const cellW = FARM_PAD_W / FIRE_CELL_COUNT;
  const cells: FireCell[] = [];
  for (let i = 0; i < FIRE_CELL_COUNT; i++) {
    cells.push({ x: farmX + i * cellW, w: cellW, intensity: 0 });
  }
  const [r, next] = nextRandom(rs);
  rs = next;
  const startIdx = Math.floor(r * FIRE_CELL_COUNT);
  cells[startIdx]!.intensity = 0.35;
  return [cells, rs];
}

function makeFloppies(rngState: number, count: number, farmX: number): [Floppy[], number] {
  let rs = rngState;
  const floppies: Floppy[] = [];
  for (let i = 0; i < count; i++) {
    const [r, next] = nextRandom(rs);
    rs = next;
    floppies.push({ x: farmX + 20 + (i % 4) * 40 + r * 10, y: GROUND_Y - 10, alive: true, boarded: false });
  }
  return [floppies, rs];
}

/** Builds the initial state for a level, preserving score/lives/onBoard/fuel from the run so far
 * (pass `carryOver` when advancing past level 1; omitted for a brand-new game). */
export function createLevelState(
  seed: number,
  level: number,
  carryOver?: { score: number; lives: number; fuel: number; onBoard: number },
): GameState {
  const levelW = levelWidth(level);
  const homeX = 60;
  const farmX = levelW - FARM_PAD_W - 60;
  let rs = seed >>> 0;
  const [fireCells, rs2] = makeFireCells(rs, farmX);
  rs = rs2;
  const [floppies, rs3] = makeFloppies(rs, floppyCountForLevel(level), farmX);
  rs = rs3;

  const drone: Drone | null =
    level >= 2
      ? {
          x: farmX - 120,
          y: GROUND_Y - 180,
          dir: 1,
          patrolMinX: farmX - 260,
          patrolMaxX: farmX + FARM_PAD_W + 40,
          fireCooldownMs: 1500,
        }
      : null;

  return {
    status: "levelIntro",
    t: 0,
    rngState: rs,
    level,
    levelIntroMsLeft: LEVEL_INTRO_MS,
    levelText: levelText(level),
    levelW,
    homeX,
    farmX,
    playerX: homeX + HOME_PAD_W / 2 - PLAYER_W / 2,
    playerY: GROUND_Y - PLAYER_H,
    playerVx: 0,
    playerVy: 0,
    cameraX: 0,
    fuel: carryOver?.fuel ?? FUEL_MAX,
    lives: carryOver?.lives ?? 3,
    score: carryOver?.score ?? 0,
    onBoard: carryOver?.onBoard ?? 0,
    deliveredThisLevel: 0,
    floppies,
    fireCells,
    debris: [],
    drone,
    droneBullets: [],
    invulnMs: 0,
    lastEventMs: 0,
    boardCooldownMs: 0,
    debrisSpawnCooldownMs: 2200,
    events: [],
  };
}

export function createInitialState(seed: number): GameState {
  return createLevelState(seed, 1);
}

function isOverPad(x: number, w: number, padX: number, padW: number): boolean {
  return x + w > padX && x < padX + padW;
}

function isLanded(playerY: number, vy: number): boolean {
  return playerY + PLAYER_H >= GROUND_Y - 1 && Math.abs(vy) < 4;
}

export function togglePause(state: GameState): GameState {
  if (state.status === "playing") return { ...state, status: "paused" };
  if (state.status === "paused") return { ...state, status: "playing" };
  return state;
}

/** Advances one physics step. A no-op (returns the same reference) when paused/gameover. During
 * "levelIntro" only the intro countdown ticks (no simulation, no input) until it flips to
 * "playing" on its own. */
export function step(state: GameState, input: GameInput, dtMs: number): GameState {
  if (state.status === "gameover" || state.status === "paused") return state;

  if (state.status === "levelIntro") {
    const left = state.levelIntroMsLeft - dtMs;
    if (left <= 0) return { ...state, status: "playing", levelIntroMsLeft: 0, t: state.t + dtMs };
    return { ...state, levelIntroMsLeft: left, t: state.t + dtMs };
  }

  const dt = Math.min(dtMs, 50) / 1000;
  const t = state.t + dtMs;
  const events: GameEvent[] = [];

  let rngState = state.rngState;
  const rand = (): number => {
    const [v, next] = nextRandom(rngState);
    rngState = next;
    return v;
  };

  const landedNow = isLanded(state.playerY, state.playerVy);
  const overHome = isOverPad(state.playerX, PLAYER_W, state.homeX, HOME_PAD_W);
  const overFarm = isOverPad(state.playerX, PLAYER_W, state.farmX, FARM_PAD_W);
  const hasFuel = state.fuel > 0;

  // --- player physics: thrust, gravity, momentum, lateral drag ---
  let vx = state.playerVx;
  let vy = state.playerVy;
  if (hasFuel && input.left && !input.right) vx -= H_ACCEL * dt;
  else if (hasFuel && input.right && !input.left) vx += H_ACCEL * dt;
  else vx *= Math.max(0, 1 - H_DRAG * dt);
  vx = clamp(vx, -MAX_VX, MAX_VX);

  vy += GRAVITY * dt;
  if (hasFuel && input.up) vy -= THRUST_ACCEL * dt;
  if (hasFuel && input.down) vy += DOWN_ACCEL * dt;
  vy *= Math.max(0, 1 - V_DRAG * dt);
  vy = clamp(vy, -MAX_VY, MAX_VY);

  let playerX = clamp(state.playerX + vx * dt, 0, state.levelW - PLAYER_W);
  if (playerX === 0 || playerX === state.levelW - PLAYER_W) vx = 0;
  let playerY = state.playerY + vy * dt;
  const willTouchGround = playerY + PLAYER_H >= GROUND_Y;
  if (willTouchGround) {
    if (vy > LANDING_SAFE_VY) {
      // crash landing: lose a life, respawn on the home pad
      const lives = state.lives - 1;
      events.push({ type: "crash" });
      if (lives <= 0) {
        return {
          ...state,
          status: "gameover",
          t,
          rngState,
          lives: 0,
          events,
        };
      }
      return {
        ...state,
        t,
        rngState,
        lives,
        playerX: state.homeX + HOME_PAD_W / 2 - PLAYER_W / 2,
        playerY: GROUND_Y - PLAYER_H,
        playerVx: 0,
        playerVy: 0,
        invulnMs: 1500,
        events,
      };
    }
    playerY = GROUND_Y - PLAYER_H;
    vy = 0;
  }
  if (playerY <= 0) vy = Math.max(0, vy); // ceiling: stop upward velocity so gravity can resume immediately
  playerY = clamp(playerY, 0, GROUND_Y - PLAYER_H);

  // --- camera: follows the player, clamped to level bounds ---
  const targetCamera = clamp(playerX + PLAYER_W / 2 - WORLD_W / 2, 0, Math.max(0, state.levelW - WORLD_W));
  const cameraX = state.cameraX + (targetCamera - state.cameraX) * Math.min(1, dt * 4);

  // --- fuel ---
  const landedAtHome = isLanded(playerY, vy) && overHome;
  let fuel = state.fuel;
  if (landedAtHome) fuel = clamp(fuel + FUEL_REFILL_PER_SEC * dt, 0, FUEL_MAX);
  else fuel = clamp(fuel - FUEL_DRAIN_PER_SEC * dt, 0, FUEL_MAX);

  // --- fire spread ---
  const fireCells = state.fireCells.map((c) => ({ ...c }));
  for (let i = 0; i < fireCells.length; i++) {
    const cell = fireCells[i]!;
    if (cell.intensity <= 0) continue;
    cell.intensity = Math.min(1, cell.intensity + FIRE_GROW_PER_SEC * dt);
    if (cell.intensity >= FIRE_IGNITE_THRESHOLD) {
      const left = fireCells[i - 1];
      const right = fireCells[i + 1];
      if (left && left.intensity <= 0) left.intensity = FIRE_SPREAD_STARTER;
      if (right && right.intensity <= 0) right.intensity = FIRE_SPREAD_STARTER;
    }
  }

  // --- floppies: fire kills the unboarded/unlucky ones standing in a fully-lit cell ---
  const floppies = state.floppies.map((f) => {
    if (!f.alive || f.boarded) return f;
    const burningHere = fireCells.some((c) => c.intensity >= 1 && f.x >= c.x && f.x < c.x + c.w);
    if (burningHere) {
      events.push({ type: "floppyLost" });
      return { ...f, alive: false };
    }
    return f;
  });

  // --- boarding (landed at farm, capacity available, floppies waiting) ---
  let onBoard = state.onBoard;
  let boardCooldownMs = Math.max(0, state.boardCooldownMs - dtMs);
  const landedAtFarm = isLanded(playerY, vy) && overFarm;
  let boarded = 0;
  if (landedAtFarm && onBoard < CAPACITY && boardCooldownMs === 0) {
    const idx = floppies.findIndex((f) => f.alive && !f.boarded);
    if (idx >= 0) {
      floppies[idx] = { ...floppies[idx]!, boarded: true };
      onBoard += 1;
      boardCooldownMs = BOARD_INTERVAL_MS;
      boarded += 1;
    }
  }
  if (boarded > 0) events.push({ type: "boarded", count: boarded });

  // --- delivery (landed at home with a load) ---
  let score = state.score;
  let deliveredThisLevel = state.deliveredThisLevel;
  if (landedAtHome && onBoard > 0) {
    const delivered = onBoard;
    score += delivered * SCORE_PER_FLOPPY + (delivered === CAPACITY ? FULL_LOAD_BONUS : 0);
    deliveredThisLevel += delivered;
    events.push({ type: "delivered", count: delivered });
    onBoard = 0;
  }

  // --- debris hazard ---
  let debrisSpawnCooldownMs = state.debrisSpawnCooldownMs - dtMs;
  const debris = state.debris
    .map((d) => ({ ...d, y: d.y + d.vy * dt }))
    .filter((d) => d.y < GROUND_Y + 40);
  if (debrisSpawnCooldownMs <= 0) {
    const spawnX = state.farmX - 140 + rand() * (FARM_PAD_W + 280);
    debris.push({ x: clamp(spawnX, 0, state.levelW), y: -10, vy: 110 + state.level * 12 });
    debrisSpawnCooldownMs = Math.max(700, 2400 - state.level * 180);
  }

  // --- drone patrol + fire ---
  let drone = state.drone;
  const droneBullets = state.droneBullets
    .map((b) => ({ ...b, x: b.x + b.vx * dt, y: b.y + b.vy * dt }))
    .filter((b) => b.y < GROUND_Y + 40 && b.y > -40);
  if (drone) {
    let dx = drone.x + drone.dir * 90 * dt;
    let dir = drone.dir;
    if (dx >= drone.patrolMaxX) {
      dx = drone.patrolMaxX;
      dir = -1;
    } else if (dx <= drone.patrolMinX) {
      dx = drone.patrolMinX;
      dir = 1;
    }
    let fireCooldownMs = drone.fireCooldownMs - dtMs;
    if (fireCooldownMs <= 0) {
      const dxToPlayer = playerX - dx;
      const dyToPlayer = playerY - drone.y;
      const dist = Math.max(1, Math.hypot(dxToPlayer, dyToPlayer));
      const speed = 200;
      droneBullets.push({ x: dx, y: drone.y, vx: (dxToPlayer / dist) * speed, vy: (dyToPlayer / dist) * speed });
      fireCooldownMs = Math.max(900, 1900 - state.level * 100);
    }
    drone = { ...drone, x: dx, dir, fireCooldownMs };
  }

  // --- hazard collisions vs player ---
  let lives = state.lives;
  let invulnMs = Math.max(0, state.invulnMs - dtMs);
  let crashed = false;
  if (invulnMs === 0) {
    const hitDebris = debris.some((d) => rectsOverlap(playerX, playerY, PLAYER_W, PLAYER_H, d.x - 5, d.y - 5, 10, 10));
    const hitFire = fireCells.some(
      (c) => c.intensity >= 1 && playerY + PLAYER_H >= GROUND_Y - 8 && playerX + PLAYER_W > c.x && playerX < c.x + c.w,
    );
    const hitBulletIdx = droneBullets.findIndex((b) => rectsOverlap(playerX, playerY, PLAYER_W, PLAYER_H, b.x - 4, b.y - 4, 8, 8));
    if (hitDebris || hitFire || hitBulletIdx >= 0) {
      crashed = true;
      lives -= 1;
      invulnMs = 1500;
      events.push({ type: "crash" });
      if (hitBulletIdx >= 0) droneBullets.splice(hitBulletIdx, 1);
    }
  }

  if (crashed && lives <= 0) {
    return { ...state, status: "gameover", t, rngState, lives: 0, events };
  }

  const respawnX = crashed ? state.homeX + HOME_PAD_W / 2 - PLAYER_W / 2 : playerX;
  const respawnY = crashed ? GROUND_Y - PLAYER_H : playerY;
  const finalVx = crashed ? 0 : vx;
  const finalVy = crashed ? 0 : vy;

  // --- level complete: every floppy is resolved (boarded at some point, or lost to fire) and the
  // player isn't currently carrying anyone (onBoard tracks the live "currently carrying" count;
  // a floppy's own `boarded` flag just means "already picked up," so it stays true forever and
  // can't be used on its own to detect "still needs delivering"). ---
  const allResolved = floppies.length > 0 && floppies.every((f) => !f.alive || f.boarded) && onBoard === 0;
  if (allResolved) {
    events.push({ type: "levelComplete" });
    const next = createLevelState(rngState, state.level + 1, { score, lives, fuel, onBoard: 0 });
    return { ...next, events: [...events, ...next.events] };
  }

  return {
    status: "playing",
    t,
    rngState,
    level: state.level,
    levelIntroMsLeft: 0,
    levelText: state.levelText,
    levelW: state.levelW,
    homeX: state.homeX,
    farmX: state.farmX,
    playerX: respawnX,
    playerY: respawnY,
    playerVx: finalVx,
    playerVy: finalVy,
    cameraX,
    fuel,
    lives,
    score,
    onBoard,
    deliveredThisLevel,
    floppies,
    fireCells,
    debris,
    drone,
    droneBullets,
    invulnMs,
    lastEventMs: events.length > 0 ? t : state.lastEventMs,
    boardCooldownMs,
    debrisSpawnCooldownMs,
    events,
  };
}

/** Cosmetic tilt angle (radians) for rendering, derived purely from horizontal velocity. */
export function playerTilt(vx: number): number {
  return clamp(vx / MAX_VX, -1, 1) * TILT_MAX;
}

/** Deterministic "bot" input for the title-screen attract-mode demo: shuttle between the home pad
 * and the farm pad, cruising at altitude in transit and easing down to land at each end. Pure
 * function of the current state (no RNG, no closures) so it's simple to reason about and cheap to
 * unit test; it isn't meant to play optimally, just to look alive behind the title card. */
export function attractInput(state: GameState): GameInput {
  const stillToRescue = state.floppies.some((f) => f.alive && !f.boarded);
  const wantsFarm = state.onBoard < CAPACITY && stillToRescue;
  const targetX = wantsFarm ? state.farmX + FARM_PAD_W / 2 - PLAYER_W / 2 : state.homeX + HOME_PAD_W / 2 - PLAYER_W / 2;
  const dx = targetX - state.playerX;
  const closeX = Math.abs(dx) < 40;
  const left = dx < -8;
  const right = dx > 8;
  const groundClearance = GROUND_Y - PLAYER_H - state.playerY;
  let up = false;
  let down = false;
  if (!closeX) {
    up = state.playerY > WORLD_H * 0.35; // cruise at altitude while travelling
  } else if (groundClearance > 30) {
    down = state.playerVy < LANDING_SAFE_VY * 0.6; // ease down without overshooting the safe speed
  } else if (groundClearance < 4) {
    up = state.playerVy > 20; // cushion the touchdown
  }
  return { up, down, left, right };
}

export { HOME_PAD_W, FARM_PAD_W };
