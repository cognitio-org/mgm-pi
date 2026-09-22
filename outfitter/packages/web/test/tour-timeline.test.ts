import { describe, expect, it } from "vitest";
import {
  TOUR_SCENES,
  clampSceneIndex,
  nextSceneIndex,
  previousSceneIndex,
  sceneAtTime,
  sceneStarts,
  timeForSceneStart,
  totalDurationMs,
} from "../src/components/tour/tour-timeline.ts";

describe("tour timeline", () => {
  it("totals roughly 75 seconds", () => {
    const total = totalDurationMs();
    expect(total).toBeGreaterThanOrEqual(70_000);
    expect(total).toBeLessThanOrEqual(80_000);
  });

  it("has at least the required beats (kernal, tapes, floppies, drives, disk box, eject, peripherals)", () => {
    const ids = TOUR_SCENES.map((s) => s.id);
    for (const id of ["kernal", "tapes", "floppies", "drives", "diskbox", "eject", "peripherals"]) {
      expect(ids).toContain(id);
    }
  });

  it("every scene has a non-empty caption and meaning", () => {
    for (const scene of TOUR_SCENES) {
      expect(scene.caption.length).toBeGreaterThan(0);
      expect(scene.meaning.length).toBeGreaterThan(0);
      expect(scene.durationMs).toBeGreaterThan(0);
    }
  });

  it("sceneStarts is monotonically increasing and matches cumulative durations", () => {
    const starts = sceneStarts();
    let acc = 0;
    for (let i = 0; i < TOUR_SCENES.length; i++) {
      expect(starts[i]).toBe(acc);
      acc += TOUR_SCENES[i].durationMs;
    }
  });

  it("sceneAtTime(0) resolves to the first scene at progress 0", () => {
    const at = sceneAtTime(0);
    expect(at.index).toBe(0);
    expect(at.scene.id).toBe(TOUR_SCENES[0].id);
    expect(at.progress).toBe(0);
    expect(at.done).toBe(false);
  });

  it("sceneAtTime clamps negative time to the start", () => {
    const at = sceneAtTime(-500);
    expect(at.index).toBe(0);
    expect(at.elapsedMs).toBe(0);
  });

  it("sceneAtTime resolves mid-scene progress correctly", () => {
    const firstDuration = TOUR_SCENES[0].durationMs;
    const at = sceneAtTime(firstDuration / 2);
    expect(at.index).toBe(0);
    expect(at.progress).toBeCloseTo(0.5, 5);
  });

  it("sceneAtTime moves to the next scene exactly at its boundary", () => {
    const firstDuration = TOUR_SCENES[0].durationMs;
    const at = sceneAtTime(firstDuration);
    expect(at.index).toBe(1);
    expect(at.elapsedMs).toBe(0);
  });

  it("sceneAtTime resolves the last scene at/after the total duration, with done=true", () => {
    const total = totalDurationMs();
    const at = sceneAtTime(total);
    expect(at.index).toBe(TOUR_SCENES.length - 1);
    expect(at.progress).toBe(1);
    expect(at.done).toBe(true);

    const overshoot = sceneAtTime(total + 5000);
    expect(overshoot.index).toBe(TOUR_SCENES.length - 1);
    expect(overshoot.done).toBe(true);
  });

  it("clampSceneIndex keeps an index within [0, length-1]", () => {
    expect(clampSceneIndex(-3)).toBe(0);
    expect(clampSceneIndex(9999)).toBe(TOUR_SCENES.length - 1);
    expect(clampSceneIndex(2)).toBe(2);
  });

  it("nextSceneIndex/previousSceneIndex step and clamp at the ends", () => {
    expect(nextSceneIndex(0)).toBe(1);
    expect(previousSceneIndex(1)).toBe(0);
    expect(previousSceneIndex(0)).toBe(0);
    expect(nextSceneIndex(TOUR_SCENES.length - 1)).toBe(TOUR_SCENES.length - 1);
  });

  it("timeForSceneStart matches sceneStarts for every index", () => {
    const starts = sceneStarts();
    for (let i = 0; i < TOUR_SCENES.length; i++) {
      expect(timeForSceneStart(i)).toBe(starts[i]);
    }
  });

  it("reduced-motion step mode: stepping through every scene index visits each one exactly once", () => {
    let i = 0;
    const visited = [i];
    while (i < TOUR_SCENES.length - 1) {
      i = nextSceneIndex(i);
      visited.push(i);
    }
    expect(visited).toEqual(TOUR_SCENES.map((_, idx) => idx));
  });
});
