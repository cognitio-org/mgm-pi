import { describe, expect, it } from "vitest";
import {
  attractInput,
  createInitialState,
  nextRandom,
  PLAYER_MAX_Y,
  PLAYER_MIN_Y,
  step,
  togglePause,
  type GameInput,
} from "../src/easter/dreadnought/engine.ts";

const NO_INPUT: GameInput = { up: false, down: false, firing: false };

describe("Dreadnought Run engine", () => {
  it("createInitialState centers the player and starts with 3 lives, playing", () => {
    const s = createInitialState(1);
    expect(s.status).toBe("playing");
    expect(s.lives).toBe(3);
    expect(s.score).toBe(0);
    expect(s.playerY).toBeGreaterThanOrEqual(PLAYER_MIN_Y);
    expect(s.playerY).toBeLessThanOrEqual(PLAYER_MAX_Y);
  });

  it("nextRandom is deterministic for a given state and stays in [0, 1)", () => {
    const [a, next] = nextRandom(42);
    const [b] = nextRandom(42);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(next).not.toBe(42);
  });

  it("step() is a no-op when not playing", () => {
    const s = { ...createInitialState(1), status: "paused" as const };
    const next = step(s, { ...NO_INPUT, up: true }, 16);
    expect(next).toBe(s);
  });

  it("thrusting up moves the player up over time, clamped to the play field", () => {
    const s0 = createInitialState(1);
    let s = s0;
    for (let i = 0; i < 200; i++) s = step(s, { ...NO_INPUT, up: true }, 16);
    expect(s.playerY).toBeLessThan(s0.playerY);
    expect(s.playerY).toBeGreaterThanOrEqual(PLAYER_MIN_Y);
  });

  it("thrusting down moves the player down, clamped to the play field", () => {
    const s0 = createInitialState(1);
    let s = s0;
    for (let i = 0; i < 400; i++) s = step(s, { ...NO_INPUT, down: true }, 16);
    expect(s.playerY).toBeGreaterThan(s0.playerY);
    expect(s.playerY).toBeLessThanOrEqual(PLAYER_MAX_Y);
  });

  it("scroll speed increases as distance accumulates", () => {
    let s = createInitialState(1);
    const initialSpeed = s.scrollSpeed;
    for (let i = 0; i < 2000; i++) s = step(s, NO_INPUT, 16);
    expect(s.scrollSpeed).toBeGreaterThan(initialSpeed);
  });

  it("firing spawns a bullet and enforces a cooldown", () => {
    let s = createInitialState(1);
    s = step(s, { ...NO_INPUT, firing: true }, 16);
    expect(s.bullets.length).toBe(1);
    const afterCooldownStart = s.bullets.length;
    s = step(s, { ...NO_INPUT, firing: true }, 16); // still within cooldown
    expect(s.bullets.length).toBe(afterCooldownStart); // no second bullet yet
  });

  it("bullets travel to the right and are eventually culled off-screen", () => {
    let s = createInitialState(1);
    s = step(s, { ...NO_INPUT, firing: true }, 16);
    const firstX = s.bullets[0]!.x;
    for (let i = 0; i < 200; i++) s = step(s, NO_INPUT, 16);
    expect(s.bullets.every((b) => b.x > firstX)).toBe(true);
  });

  it("spawns obstacles and/or pickups as the dreadnought scrolls by", () => {
    let s = createInitialState(7);
    let sawObstacle = false;
    for (let i = 0; i < 2000 && !sawObstacle; i++) {
      s = step(s, NO_INPUT, 16);
      if (s.obstacles.length > 0) sawObstacle = true;
    }
    expect(sawObstacle).toBe(true);
  });

  it("colliding with an obstacle costs a life and grants brief invulnerability", () => {
    let s = createInitialState(3);
    // Force a rack directly on top of the player.
    s = {
      ...s,
      obstacles: [{ x: 90, y: s.playerY, w: 26, h: 40, kind: "rack", hp: 1, fireCooldownMs: 0 }],
    };
    const before = s.lives;
    s = step(s, NO_INPUT, 16);
    expect(s.lives).toBe(before - 1);
    expect(s.invulnMs).toBeGreaterThan(0);
    expect(s.lastHit).toBe("rack");
  });

  it("running out of lives ends the game", () => {
    let s = { ...createInitialState(1), lives: 1 };
    s = {
      ...s,
      obstacles: [{ x: 90, y: s.playerY, w: 26, h: 40, kind: "rack", hp: 1, fireCooldownMs: 0 }],
    };
    s = step(s, NO_INPUT, 16);
    expect(s.status).toBe("gameover");
  });

  it("a bullet destroys a turret and awards score", () => {
    let s = createInitialState(1);
    s = {
      ...s,
      bullets: [{ x: 200, y: 100, vx: 620 }],
      obstacles: [{ x: 200, y: 98, w: 20, h: 20, kind: "turret", hp: 1, fireCooldownMs: 9999 }],
    };
    s = step(s, NO_INPUT, 16);
    expect(s.obstacles.length).toBe(0);
    expect(s.score).toBeGreaterThan(0);
  });

  it("collecting a pickup awards score and removes it", () => {
    let s = createInitialState(1);
    s = { ...s, pickups: [{ x: 100, y: s.playerY + 5, taken: false }] };
    s = step(s, NO_INPUT, 16);
    expect(s.pickups.length).toBe(0);
    expect(s.score).toBe(50);
  });

  it("togglePause flips playing <-> paused and ignores gameover", () => {
    const playing = createInitialState(1);
    const paused = togglePause(playing);
    expect(paused.status).toBe("paused");
    expect(togglePause(paused).status).toBe("playing");
    const over = { ...playing, status: "gameover" as const };
    expect(togglePause(over).status).toBe("gameover");
  });

  it("drones only spawn past the unlock distance and sine-sweep vertically", () => {
    let s = createInitialState(11);
    for (let i = 0; i < 1000 && s.distance < 900; i++) s = step(s, NO_INPUT, 16);
    expect(s.obstacles.some((o) => o.kind === "drone")).toBe(false);
    for (let i = 0; i < 20000 && !s.obstacles.some((o) => o.kind === "drone"); i++) s = step(s, NO_INPUT, 16);
    const drone = s.obstacles.find((o) => o.kind === "drone");
    expect(drone).toBeDefined();
    expect(drone?.baseY).toBeGreaterThanOrEqual(PLAYER_MIN_Y);
    const y1 = s.obstacles.find((o) => o.kind === "drone")?.y;
    for (let i = 0; i < 50; i++) s = step(s, NO_INPUT, 16);
    const y2 = s.obstacles.find((o) => o.kind === "drone")?.y;
    expect(y1).not.toBe(y2); // it moved -- sine sweep in effect
  });

  it("a bullet destroying an obstacle emits an obstacleDestroyed event", () => {
    let s = createInitialState(1);
    s = {
      ...s,
      bullets: [{ x: 200, y: 100, vx: 620 }],
      obstacles: [{ x: 200, y: 98, w: 20, h: 20, kind: "turret", hp: 1, fireCooldownMs: 9999 }],
    };
    s = step(s, NO_INPUT, 16);
    expect(s.events.some((e) => e.type === "obstacleDestroyed")).toBe(true);
  });

  it("getting hit emits a playerHit event", () => {
    let s = createInitialState(3);
    s = {
      ...s,
      obstacles: [{ x: 90, y: s.playerY, w: 26, h: 40, kind: "rack", hp: 1, fireCooldownMs: 0 }],
    };
    s = step(s, NO_INPUT, 16);
    expect(s.events.some((e) => e.type === "playerHit")).toBe(true);
  });

  it("attractInput is a pure, deterministic function of elapsed time", () => {
    expect(attractInput(1000)).toEqual(attractInput(1000));
    // over a full cycle it should both thrust up and down at some point
    let sawUp = false;
    let sawDown = false;
    for (let t = 0; t < 5000; t += 50) {
      const input = attractInput(t);
      if (input.up) sawUp = true;
      if (input.down) sawDown = true;
    }
    expect(sawUp).toBe(true);
    expect(sawDown).toBe(true);
  });
});
