import { describe, it, expect } from "vitest";
import { mergeEntries, nextStatusDetail } from "../src/hooks/useSessionStream.ts";
import type { PiEntry } from "../src/api/client.ts";

function entry(id: string): PiEntry {
  return { id, type: "message" };
}

describe("mergeEntries (code review N1)", () => {
  it("keeps the initial fetch's order when nothing arrived over SSE first", () => {
    const initial = [entry("a"), entry("b")];
    expect(mergeEntries([], initial)).toEqual(initial);
  });

  it("does not drop an entry that arrived over SSE before the initial fetch resolved", () => {
    // "c" streamed in over SSE while the initial GET /entries request was still in flight, so it
    // isn't part of `initial` yet -- the old code's setEntries(initial) would have clobbered it.
    const streamedFirst = [entry("c")];
    const initial = [entry("a"), entry("b")];
    expect(mergeEntries(streamedFirst, initial)).toEqual([entry("a"), entry("b"), entry("c")]);
  });

  it("dedupes an entry present in both the SSE stream and the initial fetch, keeping initial's copy", () => {
    const streamedFirst = [entry("a"), entry("c")];
    const initial = [entry("a"), entry("b")];
    expect(mergeEntries(streamedFirst, initial)).toEqual([entry("a"), entry("b"), entry("c")]);
  });

  it("returns the initial list unchanged when current is empty", () => {
    const initial = [entry("a")];
    expect(mergeEntries([], initial)).toEqual(initial);
  });
});

// A statusDetail belongs to one run (api sse.ts). The browser can't just take the field at face
// value: agentd's ordinary state-only status frames carry no `detail` and must not wipe the note,
// but a *new* run has no note of its own -- so the api sends an explicit null for that, and a dead
// run's "no GitHub token" alert no longer stays pinned over its successor.
describe("nextStatusDetail", () => {
  it("keeps the current note when the status event carried no detail at all", () => {
    expect(nextStatusDetail("pi rejected prompt: model not found", undefined)).toBe("pi rejected prompt: model not found");
  });
  it("clears it on an explicit null (the api saw a different run)", () => {
    expect(nextStatusDetail("no GitHub token is stored for this session.", null)).toBeUndefined();
  });
  it("replaces it with a new note", () => {
    expect(nextStatusDetail("old", "new")).toBe("new");
  });
  it("is a no-op on an empty state", () => {
    expect(nextStatusDetail(undefined, undefined)).toBeUndefined();
  });
});
