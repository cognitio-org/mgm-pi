// Web voice (#253, epic #256): one mic control, two behaviours (owner decision on #251), shared by
// the button and the keyboard shortcut so they can't drift apart:
// - a quick press (under HOLD_MS) latches: recording carries on until the next press;
// - press and hold talks: recording stops on release.
// Recording starts on the press itself, so the first word of a hold isn't lost while we wait to
// learn which of the two it is. Pure, so every sequence is unit-testable without a DOM.

/** A press shorter than this is a tap (latch); longer is a hold (talk until release). */
export const HOLD_MS = 300;

export type GestureState =
  | { kind: "idle" }
  /** Button or key is down and recording; `since` is when it went down. */
  | { kind: "pressed"; since: number }
  /** A tap latched the mic on; recording until the next press. */
  | { kind: "latched" }
  /** The press that ends a latch is down; its release does nothing. */
  | { kind: "stopping" };

export type GestureEvent = { type: "press"; at: number } | { type: "release"; at: number } | { type: "cancel" };

/** What the recorder should do after an event. */
export type GestureAction = "start" | "stop" | "cancel" | "none";

export const IDLE: GestureState = { kind: "idle" };

export function stepGesture(state: GestureState, event: GestureEvent): { state: GestureState; action: GestureAction } {
  if (event.type === "cancel") {
    return { state: IDLE, action: state.kind === "idle" || state.kind === "stopping" ? "none" : "cancel" };
  }
  switch (state.kind) {
    case "idle":
      return event.type === "press" ? { state: { kind: "pressed", since: event.at }, action: "start" } : { state, action: "none" };
    case "pressed":
      if (event.type === "press") return { state, action: "none" }; // key auto-repeat, or a second pointer
      return event.at - state.since < HOLD_MS ? { state: { kind: "latched" }, action: "none" } : { state: IDLE, action: "stop" };
    case "latched":
      return event.type === "press" ? { state: { kind: "stopping" }, action: "stop" } : { state, action: "none" };
    case "stopping":
      return event.type === "release" ? { state: IDLE, action: "none" } : { state, action: "none" };
  }
}

/** The shortcut: ⌥/Alt+Space. `code`, not `key`: on macOS ⌥+Space produces a non-breaking space
 * as its `key`. */
export function isVoiceShortcut(e: { code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return e.code === "Space" && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

export const VOICE_SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌥Space" : "Alt+Space";

/** Where the transcript goes: after whatever was already typed, separated by one space. */
export function composeDraft(base: string, transcript: string): string {
  const t = transcript.trim();
  if (!t) return base;
  if (!base) return t;
  return /\s$/.test(base) ? base + t : `${base} ${t}`;
}
