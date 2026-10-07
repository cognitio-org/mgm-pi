// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { canBreakTurn, escBreaks } from "../src/lib/break-keys.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function esc(target: EventTarget | null, extra: Partial<{ isComposing: boolean; defaultPrevented: boolean; key: string }> = {}) {
  return escBreaks({ key: "Escape", defaultPrevented: false, target, ...extra });
}

describe("escBreaks", () => {
  it("breaks from the page itself", () => {
    expect(esc(document.body)).toBe(true);
    expect(esc(document.body, { key: "Enter" })).toBe(false);
  });

  it("leaves an Esc that's composing, already taken, or under a menu or dialog", () => {
    expect(esc(document.body, { isComposing: true })).toBe(false);
    expect(esc(document.body, { defaultPrevented: true })).toBe(false);
    document.body.innerHTML = `<div role="menu"></div>`;
    expect(esc(document.body)).toBe(false);
    document.body.innerHTML = `<div aria-modal="true"></div>`;
    expect(esc(document.body)).toBe(false);
  });

  it("the composer breaks only with an empty draft; other fields never do", () => {
    document.body.innerHTML = `<div class="composer"><textarea></textarea></div><input type="search"><select></select><textarea id="other"></textarea>`;
    const draft = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    expect(esc(draft)).toBe(true);
    draft.value = "half a thought";
    expect(esc(draft)).toBe(false);
    expect(esc(document.querySelector("input"))).toBe(false);
    expect(esc(document.querySelector("select"))).toBe(false);
    expect(esc(document.querySelector("#other"))).toBe(false);
  });
});

describe("canBreakTurn", () => {
  const base = { canAbort: true, pendingQuestion: false, runState: "running", phase: "working" };
  it("a working turn, and one that's stuck or quiet, can be broken", () => {
    expect(canBreakTurn(base)).toBe(true);
    expect(canBreakTurn({ ...base, phase: "workTimeout" })).toBe(true);
    expect(canBreakTurn({ ...base, phase: "quiet" })).toBe(true);
    expect(canBreakTurn({ ...base, phase: "none" })).toBe(true);
  });

  it("not an idle run with nothing in flight, a waiting question, or no live run", () => {
    expect(canBreakTurn({ ...base, runState: "idle", phase: "none" })).toBe(false);
    expect(canBreakTurn({ ...base, runState: "idle", phase: "working" })).toBe(true);
    expect(canBreakTurn({ ...base, pendingQuestion: true })).toBe(false);
    expect(canBreakTurn({ ...base, canAbort: false })).toBe(false);
  });
});
