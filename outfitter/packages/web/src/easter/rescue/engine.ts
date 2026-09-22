// Pure game-logic engine for "Floppy Rescue" -- the main easter-egg game, inspired by (not a copy
// of) Choplifter: fly a pixel helicopter from the Disk Box (home base, left) out over a scrolling
// landscape to a burning server farm (right), land next to it, let little Floppy characters board
// (capacity 8), then fly them home to unload for score. No canvas/DOM code lives here so it can be
// unit tested deterministically (see test/rescue-engine.test.ts); FloppyRescue.tsx drives this
// with a fixed-timestep loop and does all drawing.
//
// Everything here is a pure function of (state, input, dtMs) plus an explicit rng counter baked
// into the state -- same seed + same input sequence always produces the same run.
//
// World resolution: a low-res "C64-style" logical canvas, rendered by FloppyRescue.tsx at an
// integer CSS scale with `image-rendering: pixelated` so it reads as chunky pixel art blown up to
// fill the frame. WORLD_W/H were shrunk a second time (from an original 320x176 pass) after a
// design review found the helicopter and Floppies still small at a normal laptop window --
// 240x176 -> 240x132 puts the (unchanged, still-26px) helicopter at roughly 8/9ths of the display
// width it was before per screen pixel, without changing sprite art. Every px/s and px/s^2 physics
// constant below was rescaled by the same 0.75 ratio the world shrank by (240/320), so flight
// *feel* (time to climb, to cross the level, to land) is unchanged -- only pixel-size constants
// (PLAYER_W/H, sprite dimensions) were deliberately left alone, since making sprites relatively
// bigger without shrinking them is the whole point. Time/score/percentage-based constants (fuel
// rates, cooldowns, fire intensity, points) needed no change at all.

export const WORLD_W = 240;
export const WORLD_H = 132;
export const GROUND_Y = 112;
export const PLAYER_W = 26;
export const PLAYER_H = 14;
export const CAPACITY = 8;

// --- flight-feel tuning constants -------------------------------------------------------------
// Hand-tuned for "thrust, gravity, momentum, gentle-landing-required" per the brief. Documented in
// docs/reports/games.md.
const GRAVITY = 71; // px/s^2, constant downward pull
const THRUST_ACCEL = 158; // px/s^2 from holding "up" -- comfortably beats gravity so climbing feels responsive
const DOWN_ACCEL = 45; // px/s^2 extra from holding "down", gravity does most of the descent work
const H_ACCEL = 113; // px/s^2 lateral thrust
const H_DRAG = 2.4; // 1/s exponential damping on vx when no lateral input (keeps it from feeling icy)
const V_DRAG = 0.5; // 1/s mild damping on vy so hovering settles instead of oscillating forever
const MAX_VX = 68; // px/s
const MAX_VY = 68; // px/s
export const LANDING_SAFE_VY = 23; // px/s -- touch down slower than this or it's a crash
const TILT_MAX = 0.5; // radians, cosmetic lean toward direction of travel
const CAMERA_LEAD = 18; // px, how far ahead of the player the camera looks in its direction of travel
// While the player is still within this many px of the home pad's right edge, the camera stays
// pinned at 0 instead of leading/following -- keeps the Disk Box and its sign fully in frame at the
// start (and whenever the player is still basically parked at home) instead of drifting the sign
// off the left edge the moment thrust ramps up.
const HOME_CAMERA_LOCK_PAD = 30;

const FUEL_MAX = 100;
const FUEL_DRAIN_PER_SEC = 3.0; // while airborne
const FUEL_REFILL_PER_SEC = 34; // while landed on the home pad

const BOARD_INTERVAL_MS = 380; // one Floppy boards this often while landed at the farm with room
const SCORE_PER_FLOPPY = 100;
const FULL_LOAD_BONUS = 400; // delivering all CAPACITY at once

const FIRE_CELL_COUNT = 6;
const FIRE_GROW_PER_SEC = 0.16; // how fast a burning cell's intensity climbs to 1 (fully lit)
const FIRE_IGNITE_THRESHOLD = 0.55; // a burning neighbour above this can ignite the next cell
const FIRE_SPREAD_STARTER = 0.05; // intensity a freshly-ignited neighbour starts at

const LEVEL_INTRO_MS = 2200;
const HOME_PAD_W = 48;
const FARM_PAD_W = 63;

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
  x?: number;
  y?: number;
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

// Level 1 is deliberately short -- besides being an easier first level, it's what lets the
// attract-mode demo (a real autopiloted playthrough, see attractInput below) complete a full
// takeoff -> farm -> board -> home -> unload loop in well under the ~20s a title screen gets
// watched for, instead of the trip alone eating the whole demo window.
function levelWidth(level: number): number {
  return 360 + (level - 1) * 105;
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
    floppies.push({ x: farmX + 5 + (i % 4) * 12 + r * 3, y: GROUND_Y - 7, alive: true, boarded: false });
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
  const homeX = 15;
  const farmX = levelW - FARM_PAD_W - 15;
  let rs = seed >>> 0;
  const [fireCells, rs2] = makeFireCells(rs, farmX);
  rs = rs2;
  const [floppies, rs3] = makeFloppies(rs, floppyCountForLevel(level), farmX);
  rs = rs3;

  const drone: Drone | null =
    level >= 2
      ? {
          x: farmX - 34,
          y: GROUND_Y - 48,
          dir: 1,
          patrolMinX: farmX - 71,
          patrolMaxX: farmX + FARM_PAD_W + 11,
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
    // events are per-step: don't carry the previous level's final events (levelComplete, the last
    // floppyLost/delivered) through every frame of the intro card, or the renderer replays them
    const left = state.levelIntroMsLeft - dtMs;
    if (left <= 0) return { ...state, status: "playing", levelIntroMsLeft: 0, t: state.t + dtMs, events: [] };
    return { ...state, levelIntroMsLeft: left, t: state.t + dtMs, events: [] };
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
      events.push({ type: "crash", x: playerX, y: GROUND_Y - PLAYER_H });
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
        // cut straight back home (a new life), rather than easing the camera across the level
        // while the chopper already sits on the home pad with the Disk Box half off-screen
        cameraX: 0,
        invulnMs: 1500,
        events,
      };
    }
    playerY = GROUND_Y - PLAYER_H;
    vy = 0;
  }
  if (playerY <= 0) vy = Math.max(0, vy); // ceiling: stop upward velocity so gravity can resume immediately
  playerY = clamp(playerY, 0, GROUND_Y - PLAYER_H);

  // --- camera: pinned at 0 while the player is still near the home pad (keeps the Disk Box and its
  // sign fully in frame at the start), otherwise follows the player with a lead in its direction of
  // travel, clamped to level bounds ---
  const nearHome = playerX < state.homeX + HOME_PAD_W + HOME_CAMERA_LOCK_PAD;
  const lead = clamp(vx / MAX_VX, -1, 1) * CAMERA_LEAD;
  const maxCamera = Math.max(0, state.levelW - WORLD_W);
  const targetCamera = nearHome ? 0 : clamp(playerX + PLAYER_W / 2 - WORLD_W / 2 + lead, 0, maxCamera);
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
      events.push({ type: "floppyLost", x: f.x, y: f.y });
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
  if (boarded > 0) events.push({ type: "boarded", count: boarded, x: playerX, y: playerY });

  // --- delivery (landed at home with a load) ---
  let score = state.score;
  let deliveredThisLevel = state.deliveredThisLevel;
  if (landedAtHome && onBoard > 0) {
    const delivered = onBoard;
    score += delivered * SCORE_PER_FLOPPY + (delivered === CAPACITY ? FULL_LOAD_BONUS : 0);
    deliveredThisLevel += delivered;
    events.push({ type: "delivered", count: delivered, x: playerX, y: playerY });
    onBoard = 0;
  }

  // --- debris hazard ---
  let debrisSpawnCooldownMs = state.debrisSpawnCooldownMs - dtMs;
  const debris = state.debris.map((d) => ({ ...d, y: d.y + d.vy * dt })).filter((d) => d.y < GROUND_Y + 15);
  if (debrisSpawnCooldownMs <= 0) {
    const spawnX = state.farmX - 38 + rand() * (FARM_PAD_W + 75);
    debris.push({ x: clamp(spawnX, 0, state.levelW), y: -5, vy: 32 + state.level * 4 });
    debrisSpawnCooldownMs = Math.max(700, 2400 - state.level * 180);
  }

  // --- drone patrol + fire ---
  let drone = state.drone;
  const droneBullets = state.droneBullets
    .map((b) => ({ ...b, x: b.x + b.vx * dt, y: b.y + b.vy * dt }))
    .filter((b) => b.y < GROUND_Y + 15 && b.y > -15);
  if (drone) {
    let dx = drone.x + drone.dir * 27 * dt;
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
      const speed = 56;
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
    const hitDebris = debris.some((d) => rectsOverlap(playerX, playerY, PLAYER_W, PLAYER_H, d.x - 3, d.y - 3, 6, 6));
    const hitFire = fireCells.some(
      (c) => c.intensity >= 1 && playerY + PLAYER_H >= GROUND_Y - 6 && playerX + PLAYER_W > c.x && playerX < c.x + c.w,
    );
    const hitBulletIdx = droneBullets.findIndex((b) => rectsOverlap(playerX, playerY, PLAYER_W, PLAYER_H, b.x - 3, b.y - 3, 6, 6));
    if (hitDebris || hitFire || hitBulletIdx >= 0) {
      crashed = true;
      lives -= 1;
      invulnMs = 1500;
      events.push({ type: "crash", x: playerX, y: playerY });
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
    cameraX: crashed ? 0 : cameraX,
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
 * and the farm pad, cruising at altitude in transit and easing down to land at each end, thrusting
 * hard enough to complete a full takeoff -> farm -> board -> home -> unload loop in well under 20s
 * on level 1 (see levelWidth's comment). Pure function of the current state (no RNG, no closures)
 * so it's simple to reason about and cheap to unit test; it isn't meant to play optimally, just to
 * look alive and legible behind the title card. */
export function attractInput(state: GameState): GameInput {
  const stillToRescue = state.floppies.some((f) => f.alive && !f.boarded);
  // Land on the coolest stretch of the farm pad (nearest spot whose cells aren't close to fully
  // lit), not blindly dead-centre -- otherwise the demo mostly shows the chopper crashing into the
  // fire. No safe spot left: take whoever is aboard home.
  const spot = safeFarmSpot(state);
  const wantsFarm = state.onBoard < CAPACITY && stillToRescue && spot !== null;
  const targetX = wantsFarm && spot !== null ? spot : state.homeX + HOME_PAD_W / 2 - PLAYER_W / 2;
  const dx = targetX - state.playerX;
  const closeX = Math.abs(dx) < (wantsFarm ? 8 : 18);
  let left = dx < -5;
  let right = dx > 5;
  // sidestep a piece of falling debris that's about to reach us
  const cx = state.playerX + PLAYER_W / 2;
  // (look further ahead the faster we're flying toward it -- momentum carries us a long way)
  const threat = state.debris.find((d) => {
    const ahead = (d.x - cx) * Math.sign(state.playerVx || 1) > 0 ? Math.abs(state.playerVx) * 0.6 : 0;
    return (
      d.y < state.playerY + PLAYER_H + 4 &&
      Math.abs(d.x - cx) < 20 + ahead &&
      (state.playerY - d.y) / Math.max(1, d.vy) < 1.2
    );
  });
  if (threat) {
    right = threat.x < cx;
    left = !right;
  }
  const groundClearance = GROUND_Y - PLAYER_H - state.playerY;
  const cruiseY = GROUND_Y - PLAYER_H - 44; // low enough to get down to the farm before the fire spreads
  let up = false;
  let down = false;
  if (!closeX) {
    up = state.playerY > cruiseY;
    down = state.playerY < cruiseY - 8 && state.playerVy < 10;
  } else if (groundClearance > 18) {
    down = state.playerVy < LANDING_SAFE_VY * 0.85; // brisk descent, still under the safe speed
  } else {
    up = state.playerVy > 14; // cushion the touchdown
  }
  return { up, down, left, right };
}

/** Hottest fire cell under a chopper parked at x. */
function padHeat(state: GameState, x: number): number {
  let heat = 0;
  for (const c of state.fireCells) if (x + PLAYER_W > c.x && x < c.x + c.w) heat = Math.max(heat, c.intensity);
  return heat;
}

/** Nearest landing x on the farm pad whose cells are still below 0.8 intensity, or null. */
function safeFarmSpot(state: GameState): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (let x = state.farmX; x <= state.farmX + FARM_PAD_W - PLAYER_W; x += 3) {
    if (padHeat(state, x) >= 0.8) continue;
    const d = Math.abs(x - state.playerX);
    if (d < bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

export { HOME_PAD_W, FARM_PAD_W };
