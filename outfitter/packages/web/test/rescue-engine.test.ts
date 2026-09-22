import { describe, expect, it } from "vitest";
import {
  attractInput,
  CAPACITY,
  createInitialState,
  createLevelState,
  GROUND_Y,
  LANDING_SAFE_VY,
  nextRandom,
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
    s = { ...s, playerY: GROUND_Y - 16, playerVy: LANDING_SAFE_VY - 5 };
    const livesBefore = s.lives;
    for (let i = 0; i < 10; i++) s = step(s, NO_INPUT, 16);
    expect(s.lives).toBe(livesBefore);
    expect(s.playerY + 16).toBeCloseTo(GROUND_Y, 0);
  });

  it("touching down too fast (above LANDING_SAFE_VY) is a crash: loses a life and respawns home", () => {
    let s = playingState(1);
    s = { ...s, playerY: GROUND_Y - 5, playerVy: LANDING_SAFE_VY + 200, playerX: 900 };
    const livesBefore = s.lives;
    s = step(s, NO_INPUT, 16);
    expect(s.lives).toBe(livesBefore - 1);
    expect(s.events.some((e) => e.type === "crash")).toBe(true);
    expect(s.playerX).toBeCloseTo(s.homeX + 80 - 15, 0);
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
      playerY: GROUND_Y - 16,
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
      playerY: GROUND_Y - 16,
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

describe("Floppy Rescue engine: scoring", () => {
  it("delivering floppies at home awards score per floppy", () => {
    let s = playingState(1);
    s = { ...s, onBoard: 3, playerX: s.homeX + 20, playerY: GROUND_Y - 16, playerVy: 0 };
    const scoreBefore = s.score;
    s = step(s, NO_INPUT, 16);
    expect(s.score).toBe(scoreBefore + 300);
    expect(s.onBoard).toBe(0);
  });

  it("delivering a full load of CAPACITY awards a bonus on top", () => {
    let s = playingState(1);
    s = { ...s, onBoard: CAPACITY, playerX: s.homeX + 20, playerY: GROUND_Y - 16, playerVy: 0 };
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
