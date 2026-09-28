// #253: the mic's tap-vs-hold state machine, shared by the button and ⌥/Alt+Space.
import { describe, expect, it } from "vitest";
import { composeDraft, HOLD_MS, IDLE, isVoiceShortcut, stepGesture, type GestureEvent, type GestureState } from "../src/lib/voice-gesture.ts";

function run(events: GestureEvent[]): { state: GestureState; actions: string[] } {
  let state: GestureState = IDLE;
  const actions: string[] = [];
  for (const e of events) {
    const r = stepGesture(state, e);
    state = r.state;
    actions.push(r.action);
  }
  return { state, actions };
}

describe("stepGesture", () => {
  it("a hold records from the press and stops on release", () => {
    const r = run([
      { type: "press", at: 0 },
      { type: "release", at: HOLD_MS + 500 },
    ]);
    expect(r.actions).toEqual(["start", "stop"]);
    expect(r.state).toEqual(IDLE);
  });

  it("a tap latches: recording carries on until the next press, whose release does nothing", () => {
    const r = run([
      { type: "press", at: 0 },
      { type: "release", at: 120 },
      { type: "press", at: 5_000 },
      { type: "release", at: 5_900 },
    ]);
    expect(r.actions).toEqual(["start", "none", "stop", "none"]);
    expect(r.state).toEqual(IDLE);
  });

  it("the threshold itself counts as a hold", () => {
    expect(run([{ type: "press", at: 0 }, { type: "release", at: HOLD_MS - 1 }]).state.kind).toBe("latched");
    expect(run([{ type: "press", at: 0 }, { type: "release", at: HOLD_MS }]).actions).toEqual(["start", "stop"]);
  });

  it("ignores key auto-repeat presses while held", () => {
    const r = run([
      { type: "press", at: 0 },
      { type: "press", at: 30 },
      { type: "press", at: 60 },
      { type: "release", at: 1_000 },
    ]);
    expect(r.actions).toEqual(["start", "none", "none", "stop"]);
  });

  it("cancel from any live state cancels; from idle or a stopping press it does nothing", () => {
    expect(run([{ type: "press", at: 0 }, { type: "cancel" }]).actions).toEqual(["start", "cancel"]);
    expect(run([{ type: "press", at: 0 }, { type: "release", at: 10 }, { type: "cancel" }]).actions).toEqual(["start", "none", "cancel"]);
    expect(run([{ type: "cancel" }]).actions).toEqual(["none"]);
    expect(run([{ type: "press", at: 0 }, { type: "release", at: 10 }, { type: "press", at: 99 }, { type: "cancel" }]).actions.at(-1)).toBe("none");
  });

  it("a stray release while idle does nothing", () => {
    expect(run([{ type: "release", at: 5 }])).toEqual({ state: IDLE, actions: ["none"] });
  });
});

describe("isVoiceShortcut", () => {
  const key = (over: Partial<{ code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({
    code: "Space",
    altKey: true,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...over,
  });
  it("is ⌥/Alt+Space and nothing else", () => {
    expect(isVoiceShortcut(key({}))).toBe(true);
    expect(isVoiceShortcut(key({ altKey: false }))).toBe(false);
    expect(isVoiceShortcut(key({ metaKey: true }))).toBe(false);
    expect(isVoiceShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isVoiceShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isVoiceShortcut(key({ code: "KeyV" }))).toBe(false);
  });
});

describe("composeDraft", () => {
  it("appends the transcript after what was typed, with one space", () => {
    expect(composeDraft("", "hello there")).toBe("hello there");
    expect(composeDraft("Fix the", "login bug")).toBe("Fix the login bug");
    expect(composeDraft("Line one\n", "line two")).toBe("Line one\nline two");
    expect(composeDraft("keep", "   ")).toBe("keep");
  });
});
