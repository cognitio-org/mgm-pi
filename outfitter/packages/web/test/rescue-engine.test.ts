import { describe, expect, it } from "vitest";
import {
  attractInput,
  CAPACITY,
  createInitialState,
  createLevelState,
  FARM_PAD_W,
  GROUND_Y,
  HOME_PAD_W,
  LANDING_SAFE_VY,
  CRASH_VY,
  MAX_FALL_VY,
  HARD_LANDING_FUEL_COST,
  GROUND_EFFECT_H,
  landingBand,
  farmZoneX,
  FARM_ZONE_W,
  nextRandom,
  PLAYER_H,
  PLAYER_W,
  playerTilt,
  step,
  togglePause,
  WORLD_H,
  type GameInput,
} from "../src/easter/rescue/engine.ts";

const NO_INPUT: GameInput = { up: false, down: false, left: false, right: false };

/** Skips the level-intro card so tests can drop straight into simulation. */
function playingState(seed: number, level = 1) {
  let s = createLevelState(seed, level);
  while (s.status === "levelIntro") s = step(s, NO_INPUT, 100);
  return s;
}

describe("Floppy Rescue engine: physics", () => {
  it("createInitialState starts on the home pad, level 1, full fuel, 3 lives", () => {
    const s = createInitialState(1);
    expect(s.status).toBe("levelIntro");
    expect(s.level).toBe(1);
    expect(s.fuel).toBe(100);
    expect(s.lives).toBe(3);
    expect(s.onBoard).toBe(0);
  });

  it("nextRandom is deterministic for a given state and stays in [0, 1)", () => {
    const [a, next] = nextRandom(7);
    const [b] = nextRandom(7);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(next).not.toBe(7);
  });

  it("levelIntro is a countdown-only no-op state: it ignores input and flips to playing", () => {
    let s = createLevelState(1, 1);
    expect(s.status).toBe("levelIntro");
    const before = s.playerX;
    for (let i = 0; i < 100 && s.status === "levelIntro"; i++) s = step(s, { ...NO_INPUT, right: true }, 50);
    expect(s.status).toBe("playing");
    expect(s.playerX).toBe(before); // never moved during the intro
  });

  it("holding up thrusts the player upward against gravity", () => {
    let s = playingState(1);
    const y0 = s.playerY;
    for (let i = 0; i < 60; i++) s = step(s, { ...NO_INPUT, up: true }, 16);
    expect(s.playerY).toBeLessThan(y0);
  });

  it("gravity alone pulls the player down when airborne with no input", () => {
    let s = playingState(1);
    // parked mid-air, well clear of both the ground and the ceiling, with zero velocity
    s = { ...s, playerY: WORLD_H / 2, playerVy: 0 };
    const yAirborne = s.playerY;
    for (let i = 0; i < 20; i++) s = step(s, NO_INPUT, 16);
    expect(s.playerVy).toBeGreaterThan(0); // gravity alone made it start falling
    expect(s.playerY).toBeGreaterThan(yAirborne);
  });

  it("holding right accelerates the player rightward, drag decelerates it once released", () => {
    let s = playingState(1);
    for (let i = 0; i < 30; i++) s = step(s, { ...NO_INPUT, right: true, up: true }, 16);
    const vxThrusting = s.playerVx;
    expect(vxThrusting).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) s = step(s, { ...NO_INPUT, up: true }, 16);
    expect(Math.abs(s.playerVx)).toBeLessThan(vxThrusting);
  });

  it("playerTilt leans toward the direction of horizontal travel and is clamped", () => {
    expect(playerTilt(0)).toBe(0);
    expect(playerTilt(1000)).toBeGreaterThan(0);
    expect(playerTilt(-1000)).toBeLessThan(0);
    expect(Math.abs(playerTilt(1e9))).toBeLessThanOrEqual(Math.abs(playerTilt(230)) + 1e-9);
  });
});

describe("Floppy Rescue engine: landing rules", () => {
  it("touching down gently (below LANDING_SAFE_VY) is a safe landing: no life lost", () => {
    let s = playingState(1);
    // already resting right at the ground, descending well under the safe threshold
    s = { ...s, playerY: GROUND_Y - PLAYER_H, playerVy: LANDING_SAFE_VY - 5 };
    const livesBefore = s.lives;
    for (let i = 0; i < 10; i++) s = step(s, NO_INPUT, 16);
    expect(s.lives).toBe(livesBefore);
    expect(s.playerY + PLAYER_H).toBeCloseTo(GROUND_Y, 0);
  });

  it("touching down between LANDING_SAFE_VY and CRASH_VY is a hard landing: bounce, fuel cost, no life lost", () => {
    let s = playingState(1);
    const vy = (LANDING_SAFE_VY + CRASH_VY) / 2;
    s = { ...s, playerX: 150, playerY: GROUND_Y - PLAYER_H - 0.2, playerVy: vy, fuel: 80 };
    const livesBefore = s.lives;
    s = step(s, { ...NO_INPUT, down: true }, 16);
    const ev = s.events.find((e) => e.type === "hardLanding");
    expect(ev).toBeDefined();
    expect(ev!.speed!).toBeGreaterThan(LANDING_SAFE_VY);
    expect(s.events.some((e) => e.type === "crash")).toBe(false);
    expect(s.lives).toBe(livesBefore);
    expect(s.playerVy).toBeLessThan(0); // bounced
    expect(s.fuel).toBeLessThanOrEqual(80 - HARD_LANDING_FUEL_COST + 0.1);
  });

  it("the bands are safe <= LANDING_SAFE_VY < hard <= CRASH_VY < crash, and a dive can still exceed CRASH_VY", () => {
    expect(landingBand(LANDING_SAFE_VY)).toBe("safe");
    expect(landingBand(LANDING_SAFE_VY + 1)).toBe("hard");
    expect(landingBand(CRASH_VY)).toBe("hard");
    expect(landingBand(CRASH_VY + 1)).toBe("crash");
    expect(LANDING_SAFE_VY).toBeGreaterThanOrEqual(40); // forgiving: ~2x the original 23 px/s
    expect(MAX_FALL_VY).toBeGreaterThan(CRASH_VY);
  });

  it("letting go of every key from high up settles safely thanks to the ground effect", () => {
    let s = playingState(1);
    s = { ...s, playerX: 150, playerY: GROUND_Y - PLAYER_H - 90, playerVy: 0 };
    for (let i = 0; i < 600 && !(s.playerY + PLAYER_H >= GROUND_Y - 0.5 && s.playerVy === 0); i++) {
      s = step(s, NO_INPUT, 1000 / 60);
      expect(s.events.some((e) => e.type === "crash" || e.type === "hardLanding")).toBe(false);
    }
    expect(s.playerY + PLAYER_H).toBeCloseTo(GROUND_Y, 0);
  });

  it("ground effect: within GROUND_EFFECT_H of the ground, descent is slowed (less so while diving)", () => {
    const base = playingState(1);
    const at = (height: number, down: boolean) =>
      step({ ...base, playerX: 150, playerY: GROUND_Y - PLAYER_H - height, playerVy: 40 }, { ...NO_INPUT, down }, 16)
        .playerVy;
    const high = at(GROUND_EFFECT_H + 20, false);
    const low = at(2, false);
    const lowDiving = at(2, true);
    expect(low).toBeLessThan(high - 2);
    expect(lowDiving).toBeGreaterThan(low);
  });

  it("holding down in a long dive is still a crash", () => {
    let s = playingState(1);
    s = { ...s, playerX: 150, playerY: GROUND_Y - PLAYER_H - 70, playerVy: 30 };
    let crashed = false;
    for (let i = 0; i < 300 && !crashed; i++) {
      s = step(s, { ...NO_INPUT, down: true }, 1000 / 60);
      crashed = s.events.some((e) => e.type === "crash");
    }
    expect(crashed).toBe(true);
  });

  it("touching down too fast (above CRASH_VY) is a crash: loses a life and respawns home", () => {
    let s = playingState(1);
    s = { ...s, playerY: GROUND_Y - 5, playerVy: LANDING_SAFE_VY + 200, playerX: 900 };
    const livesBefore = s.lives;
    s = step(s, NO_INPUT, 16);
    expect(s.lives).toBe(livesBefore - 1);
    expect(s.events.some((e) => e.type === "crash")).toBe(true);
    expect(s.playerX).toBeCloseTo(s.homeX + HOME_PAD_W / 2 - PLAYER_W / 2, 0);
  });

  it("running out of lives from a crash ends the game", () => {
    let s = playingState(1);
    s = { ...s, lives: 1, playerY: GROUND_Y - 5, playerVy: LANDING_SAFE_VY + 200 };
    s = step(s, NO_INPUT, 16);
    expect(s.status).toBe("gameover");
    expect(s.lives).toBe(0);
  });
});

describe("Floppy Rescue engine: pickup and capacity", () => {
  it("landing at the farm boards a Floppy every BOARD_INTERVAL_MS while under capacity", () => {
    let s = playingState(2); // seed with floppies present
    s = {
      ...s,
      playerX: s.farmX + 40,
      playerY: GROUND_Y - PLAYER_H,
      playerVy: 0,
      playerVx: 0,
      debrisSpawnCooldownMs: Number.MAX_SAFE_INTEGER, // isolate boarding from the debris hazard
      drone: null,
      fireCells: s.fireCells.map((c) => ({ ...c, intensity: 0 })), // isolate boarding from the fire hazard
    };
    let boards = 0;
    for (let i = 0; i < 400 && boards < CAPACITY; i++) {
      const before = s.onBoard;
      s = step(s, NO_INPUT, 100);
      if (s.onBoard > before) boards++;
    }
    expect(boards).toBeGreaterThan(0);
    expect(s.onBoard).toBeLessThanOrEqual(CAPACITY);
  });

  it("never boards past CAPACITY even with plenty of floppies and time", () => {
    let s = playingState(3, 4); // higher level -> more floppies available
    s = {
      ...s,
      playerX: s.farmX + 40,
      playerY: GROUND_Y - PLAYER_H,
      playerVy: 0,
      playerVx: 0,
      debrisSpawnCooldownMs: Number.MAX_SAFE_INTEGER,
      drone: null,
      fireCells: s.fireCells.map((c) => ({ ...c, intensity: 0 })),
    };
    for (let i = 0; i < 2000; i++) s = step(s, NO_INPUT, 100);
    expect(s.onBoard).toBeLessThanOrEqual(CAPACITY);
  });
});

describe("Floppy Rescue engine: fire spread", () => {
  it("a lit cell's intensity grows over time and eventually ignites a neighbour", () => {
    let s = playingState(5);
    const startCells = s.fireCells.filter((c) => c.intensity > 0).length;
    expect(startCells).toBe(1);
    // fire spreading can burn every floppy, which would resolve/advance the level and hand back a
    // fresh (unlit) fire layout -- clear the floppy pool so this test observes fire in isolation.
    s = { ...s, floppies: [] };
    for (let i = 0; i < 400; i++) s = step(s, NO_INPUT, 50);
    const litCells = s.fireCells.filter((c) => c.intensity > 0).length;
    expect(litCells).toBeGreaterThan(startCells);
  });

  it("a floppy standing in a fully-lit cell is lost", () => {
    let s = playingState(9);
    // force one cell fully lit directly under the first floppy
    const f0 = s.floppies[0]!;
    s = { ...s, fireCells: s.fireCells.map((c) => (f0.x >= c.x && f0.x < c.x + c.w ? { ...c, intensity: 1 } : c)) };
    s = step(s, NO_INPUT, 16);
    expect(s.floppies[0]!.alive).toBe(false);
    expect(s.events.some((e) => e.type === "floppyLost")).toBe(true);
  });
});

describe("Floppy Rescue engine: rescue zone and tutorial", () => {
  it("landing in the marked zone beside the farm boards Floppies like the farm pad does", () => {
    let s = playingState(3);
    const x = farmZoneX(s) + FARM_ZONE_W / 2 - PLAYER_W / 2;
    s = { ...s, playerX: x, playerY: GROUND_Y - PLAYER_H, playerVy: 0, onBoard: 0 };
    for (let i = 0; i < 30; i++) s = step(s, NO_INPUT, 50);
    expect(s.onBoard).toBeGreaterThan(0);
    expect(farmZoneX(s) + FARM_ZONE_W).toBeLessThanOrEqual(s.farmX); // the zone is beside, not in, the fire
  });

  it("during the tutorial the fire doesn't grow or spread and fuel doesn't drain", () => {
    let s = createLevelState(5, 1, undefined, { tutorial: true });
    while (s.status === "levelIntro") s = step(s, NO_INPUT, 100);
    s = { ...s, floppies: [], playerY: 40, fuel: 70 };
    const before = s.fireCells.map((c) => c.intensity);
    for (let i = 0; i < 100; i++) s = step(s, { ...NO_INPUT, up: s.playerY > 40 }, 50);
    expect(s.fireCells.map((c) => c.intensity)).toEqual(before);
    expect(s.fuel).toBeCloseTo(70, 5);
    expect(s.debris.length).toBe(0);
  });
});

describe("Floppy Rescue engine: scoring", () => {
  it("delivering floppies at home awards score per floppy", () => {
    let s = playingState(1);
    s = { ...s, onBoard: 3, playerX: s.homeX + 20, playerY: GROUND_Y - PLAYER_H, playerVy: 0 };
    const scoreBefore = s.score;
    s = step(s, NO_INPUT, 16);
    expect(s.score).toBe(scoreBefore + 300);
    expect(s.onBoard).toBe(0);
  });

  it("delivering a full load of CAPACITY awards a bonus on top", () => {
    let s = playingState(1);
    s = { ...s, onBoard: CAPACITY, playerX: s.homeX + 20, playerY: GROUND_Y - PLAYER_H, playerVy: 0 };
    const scoreBefore = s.score;
    s = step(s, NO_INPUT, 16);
    expect(s.score).toBe(scoreBefore + CAPACITY * 100 + 400);
  });
});

describe("Floppy Rescue engine: level progression", () => {
  it("togglePause flips playing <-> paused", () => {
    let s = playingState(1);
    const paused = togglePause(s);
    expect(paused.status).toBe("paused");
    expect(togglePause(paused).status).toBe("playing");
  });

  it("advances to the next level once every floppy is resolved and nobody is onboard, keeping score/lives", () => {
    let s = playingState(1);
    s = {
      ...s,
      floppies: s.floppies.map((f) => ({ ...f, alive: false })),
      onBoard: 0,
      deliveredThisLevel: 1,
      score: 500,
      lives: 2,
    };
    s = step(s, NO_INPUT, 16);
    expect(s.level).toBe(2);
    expect(s.status).toBe("levelIntro");
    expect(s.score).toBe(500);
    expect(s.lives).toBe(2);
    expect(s.events.some((e) => e.type === "levelComplete")).toBe(true);
  });

  it("level 2+ introduces a patrolling drone that level 1 does not have", () => {
    const s1 = createLevelState(1, 1);
    const s2 = createLevelState(1, 2);
    expect(s1.drone).toBeNull();
    expect(s2.drone).not.toBeNull();
  });

  it("later levels have more floppies to rescue than level 1", () => {
    const s1 = createLevelState(1, 1);
    const s3 = createLevelState(1, 3);
    expect(s3.floppies.length).toBeGreaterThan(s1.floppies.length);
  });
});

describe("Floppy Rescue engine: attract-mode autopilot", () => {
  it("heads toward the farm when empty-handed with floppies still waiting", () => {
    let s = playingState(1);
    s = { ...s, playerX: s.homeX + 40, onBoard: 0 };
    const input = attractInput(s);
    expect(input.right).toBe(true);
    expect(input.left).toBe(false);
  });

  it("heads back toward home once carrying a full load", () => {
    let s = playingState(1);
    s = { ...s, playerX: s.farmX + 40, onBoard: CAPACITY };
    const input = attractInput(s);
    expect(input.left).toBe(true);
    expect(input.right).toBe(false);
  });

  it("is a pure function of state -- same input state, same decision", () => {
    const s = playingState(1);
    expect(attractInput(s)).toEqual(attractInput(s));
  });
});
