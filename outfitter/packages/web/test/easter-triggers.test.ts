// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createDoubleActivate, createSysCommandMatcher, isTypingTarget } from "../src/easter/triggers.ts";

function typeAll(m: ReturnType<typeof createSysCommandMatcher>, keys: string[]): boolean[] {
  return keys.map((k) => m.feed(k));
}
const chars = (s: string) => s.split("");

describe("SYS 64738 typed command", () => {
  it("fires on Enter after SYS 64738, in any case, spaces optional", () => {
    for (const text of ["SYS 64738", "sys 64738", "SYS64738", "Sys  64738"]) {
      const m = createSysCommandMatcher();
      const out = typeAll(m, [...chars(text), "Enter"]);
      expect(out.at(-1)).toBe(true);
      expect(out.slice(0, -1).every((x) => !x)).toBe(true);
    }
  });

  it("tolerates earlier junk and fixes typos with Backspace", () => {
    const m = createSysCommandMatcher();
    expect(typeAll(m, [...chars("hello SYS 6473"), "9", "Backspace", "8", "Enter"]).at(-1)).toBe(true);
  });

  it("does not fire for other commands, or without Enter, and resets after", () => {
    const m = createSysCommandMatcher();
    expect(typeAll(m, [...chars("SYS 64739"), "Enter"]).at(-1)).toBe(false);
    expect(typeAll(m, chars("SYS 64738")).some(Boolean)).toBe(false);
    expect(m.feed("ArrowUp")).toBe(false); // a non-character key clears the buffer
    expect(m.feed("Enter")).toBe(false);
    expect(typeAll(m, [...chars("SYS 64738"), "Enter", "Enter"])).toEqual([...chars("SYS 64738").map(() => false), true, false]);
  });

  it("Shift doesn't break the sequence", () => {
    const m = createSysCommandMatcher();
    expect(typeAll(m, ["Shift", "S", "Shift", "Y", "S", " ", ...chars("64738"), "Enter"]).at(-1)).toBe(true);
  });
});

describe("isTypingTarget (no triggers from form fields)", () => {
  it("treats inputs, textareas, selects and contenteditable as typing, the page body not", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.appendChild(div);
    expect(isTypingTarget(div)).toBe(true);
    const inner = document.createElement("span");
    div.appendChild(inner);
    expect(isTypingTarget(inner)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("Trash double-activate", () => {
  function setup() {
    vi.useFakeTimers();
    const onSingle = vi.fn();
    const onDouble = vi.fn();
    const d = createDoubleActivate({ windowMs: 320, onSingle, onDouble });
    return { d, onSingle, onDouble };
  }

  it("a single click still does the single action, after the double-click window", () => {
    const { d, onSingle, onDouble } = setup();
    d.activate();
    expect(onSingle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(320);
    expect(onSingle).toHaveBeenCalledTimes(1);
    expect(onDouble).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("two clicks within the window open the games instead, and never the single action", () => {
    const { d, onSingle, onDouble } = setup();
    d.activate();
    vi.advanceTimersByTime(150);
    d.activate();
    vi.advanceTimersByTime(1000);
    expect(onDouble).toHaveBeenCalledTimes(1);
    expect(onSingle).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("two clicks further apart are two single actions", () => {
    const { d, onSingle, onDouble } = setup();
    d.activate();
    vi.advanceTimersByTime(400);
    d.activate();
    vi.advanceTimersByTime(400);
    expect(onSingle).toHaveBeenCalledTimes(2);
    expect(onDouble).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keyboard activation (immediate) runs the single action with no delay", () => {
    const { d, onSingle, onDouble } = setup();
    d.activate(true);
    expect(onSingle).toHaveBeenCalledTimes(1);
    expect(onDouble).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancel() drops a pending single action (e.g. the desk unmounting)", () => {
    const { d, onSingle } = setup();
    d.activate();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(onSingle).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
