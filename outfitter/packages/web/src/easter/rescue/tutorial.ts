// First-game tutorial for Floppy Rescue: a short chain of prompts that advance on what the player
// actually does (lift off -> fly to the farm -> land in the zone -> wait for boarding -> fly home and
// land -> go). Pure: nextTutorialStep() is a function of the current step, the game state and this
// step's events, so it's unit tested without a DOM (test/rescue-tutorial.test.ts). The engine's own
// `tutorial` flag freezes the fire and fuel while it runs; completion is remembered in localStorage.

import { CAPACITY, farmZoneX, GROUND_Y, PLAYER_H, PLAYER_W, type GameEvent, type GameState } from "./engine.ts";

export type TutorialStep = "lift" | "fly" | "land" | "board" | "home" | "finish" | "done";

/** How long the last prompt stays up after the first delivery. */
export const TUTORIAL_FINISH_MS = 4500;

const PROMPTS: Record<Exclude<TutorialStep, "done">, { keys: string; touch: string }> = {
  lift: { keys: "Hold ↑ to lift off", touch: "Hold LIFT to lift off" },
  fly: { keys: "Fly → to the burning farm", touch: "Drag the stick → to the burning farm" },
  land: {
    keys: "Ease off ↑ and land gently in the green zone",
    touch: "Let go of LIFT and land gently in the green zone",
  },
  board: { keys: "Wait while Floppies climb aboard", touch: "Wait while Floppies climb aboard" },
  home: {
    keys: "Fly ← home and land on the pad to unload",
    touch: "Drag the stick ← home and land on the pad to unload",
  },
  finish: { keys: "Rescue them all before the fire spreads!", touch: "Rescue them all before the fire spreads!" },
};

export function tutorialPrompt(step: TutorialStep, touch: boolean): string | null {
  if (step === "done") return null;
  const p = PROMPTS[step];
  return touch ? p.touch : p.keys;
}

/** 1-based position for a "2/6" counter. */
export function tutorialIndex(step: TutorialStep): number {
  return ["lift", "fly", "land", "board", "home", "finish"].indexOf(step) + 1;
}

function airborne(s: GameState): boolean {
  return s.playerY + PLAYER_H < GROUND_Y - 6;
}

/** Advances as far as the state allows in one call (so doing things out of order -- e.g. landing
 * at the farm without the "fly" prompt ever registering -- still lands on the right prompt).
 * `finishMs` is how long "finish" has been showing. */
export function nextTutorialStep(step: TutorialStep, s: GameState, events: GameEvent[], finishMs = 0): TutorialStep {
  let cur = step;
  for (let guard = 0; guard < 8; guard++) {
    const next = advanceOnce(cur, s, events, finishMs);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

function advanceOnce(step: TutorialStep, s: GameState, events: GameEvent[], finishMs: number): TutorialStep {
  const delivered = events.some((e) => e.type === "delivered" || e.type === "levelComplete");
  const waiting = s.floppies.some((f) => f.alive && !f.boarded);
  switch (step) {
    case "lift":
      return airborne(s) ? "fly" : "lift";
    case "fly":
      return s.playerX + PLAYER_W / 2 > farmZoneX(s) - 50 ? "land" : "fly";
    case "land":
      return s.onBoard > 0 || events.some((e) => e.type === "boarded") ? "board" : "land";
    case "board":
      if (s.onBoard >= CAPACITY || !waiting || (s.onBoard > 0 && airborne(s))) return "home";
      return "board";
    case "home":
      return delivered ? "finish" : "home";
    case "finish":
      return finishMs >= TUTORIAL_FINISH_MS ? "done" : "finish";
    default:
      return "done";
  }
}

const STORAGE_KEY = "outfitterRescueTutorialDone";

export function tutorialSeen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTutorialSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // storage unavailable (private mode, blocked) -- the tutorial will just offer itself again
  }
}
