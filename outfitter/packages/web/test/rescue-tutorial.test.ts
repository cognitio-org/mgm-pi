import { describe, expect, it } from "vitest";
import {
  CAPACITY,
  createInitialState,
  farmZoneX,
  FARM_ZONE_W,
  GROUND_Y,
  PLAYER_H,
  PLAYER_W,
  step,
  type GameInput,
  type GameState,
} from "../src/easter/rescue/engine.ts";
import { nextTutorialStep, tutorialPrompt, TUTORIAL_FINISH_MS } from "../src/easter/rescue/tutorial.ts";

const NO_INPUT: GameInput = { up: false, down: false, left: false, right: false };

function tutorialGame(): GameState {
  let s = createInitialState(7, { tutorial: true });
  while (s.status === "levelIntro") s = step(s, NO_INPUT, 100);
  return s;
}

describe("Floppy Rescue tutorial", () => {
  it("walks lift -> fly -> land -> board -> home -> finish -> done on the player's actions", () => {
    let s = tutorialGame();
    let t = nextTutorialStep("lift", s, []);
    expect(t).toBe("lift");

    s = { ...s, playerY: GROUND_Y - PLAYER_H - 30 };
    t = nextTutorialStep(t, s, []);
    expect(t).toBe("fly");

    s = { ...s, playerX: farmZoneX(s) - 10 };
    t = nextTutorialStep(t, s, []);
    expect(t).toBe("land");

    // land in the zone and let the engine board a few
    s = { ...s, playerX: farmZoneX(s) + FARM_ZONE_W / 2 - PLAYER_W / 2, playerY: GROUND_Y - PLAYER_H, playerVy: 0 };
    for (let i = 0; i < 12; i++) {
      s = step(s, NO_INPUT, 100);
      t = nextTutorialStep(t, s, s.events);
    }
    expect(["board", "home"]).toContain(t);

    // everyone aboard (level 1 has fewer than CAPACITY Floppies)
    for (let i = 0; i < 40 && t === "board"; i++) {
      s = step(s, NO_INPUT, 100);
      t = nextTutorialStep(t, s, s.events);
    }
    expect(t).toBe("home");
    expect(s.onBoard).toBeGreaterThan(0);
    expect(s.onBoard).toBeLessThanOrEqual(CAPACITY);

    // land at home
    s = { ...s, playerX: s.homeX + 10, playerY: GROUND_Y - PLAYER_H, playerVy: 0 };
    s = step(s, NO_INPUT, 16);
    t = nextTutorialStep(t, s, s.events);
    expect(t).toBe("finish");
    expect(nextTutorialStep(t, s, [], TUTORIAL_FINISH_MS - 1)).toBe("finish");
    expect(nextTutorialStep(t, s, [], TUTORIAL_FINISH_MS)).toBe("done");
  });

  it("skips ahead when the player does things before being asked", () => {
    let s = tutorialGame();
    s = { ...s, playerX: farmZoneX(s) + 5, playerY: GROUND_Y - PLAYER_H - 30, onBoard: 0 };
    expect(nextTutorialStep("lift", s, [])).toBe("land");
  });

  it("uses touch wording on touch devices", () => {
    expect(tutorialPrompt("lift", false)).toContain("↑");
    expect(tutorialPrompt("lift", true)).toContain("LIFT");
    expect(tutorialPrompt("fly", true)).toContain("stick");
    expect(tutorialPrompt("done", false)).toBeNull();
  });
});
