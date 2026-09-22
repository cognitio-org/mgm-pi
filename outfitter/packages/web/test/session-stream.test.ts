import { describe, it, expect } from "vitest";
import { mergeEntries } from "../src/hooks/useSessionStream.ts";
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
