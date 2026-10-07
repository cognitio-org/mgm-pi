import { describe, it, expect } from "vitest";
import {
  effectiveLastPush,
  livenessTimes,
  mergeEntries,
  nextLastPush,
  nextLiveThought,
  nextPendingOnStatus,
  nextPendingUiRequest,
  nextStatusDetail,
} from "../src/hooks/useSessionStream.ts";
import type { PiEntry } from "../src/api/client.ts";

describe("nextLastPush (#501)", () => {
  const head = "a".repeat(40);
  it("takes the head and the push time from a checkpoint event", () => {
    expect(
      nextLastPush(undefined, {
        t: "checkpoint",
        branch: "outfitter/s1",
        head,
        pushed: true,
        landedAt: "2026-10-07T10:05:00Z",
        pushedAt: "2026-10-07T10:00:00Z",
      }),
    ).toEqual({ sha: head, branch: "outfitter/s1", at: "2026-10-07T10:00:00Z", pushed: true });
  });

  it("never uses landedAt as the push time, and keeps the last push for an event with no head", () => {
    const current = nextLastPush(undefined, { head, landedAt: "2026-10-07T10:05:00Z", pushed: false });
    expect(current).toEqual({ sha: head, pushed: false });
    expect(nextLastPush(current, { t: "checkpoint", landed: false })).toBe(current);
    expect(nextLastPush(undefined, { t: "checkpoint" })).toBeUndefined();
  });
});

describe("effectiveLastPush (#501)", () => {
  const seeded = { sha: "a".repeat(40), at: "2026-10-07T10:00:00Z", pushed: true };
  const streamed = { sha: "b".repeat(40), at: "2026-10-07T10:05:00Z", pushed: true };
  it("uses the detail's lastPush until an event arrives, then the event", () => {
    expect(effectiveLastPush(undefined, seeded)).toBe(seeded);
    expect(effectiveLastPush(undefined, null)).toBeUndefined();
    expect(effectiveLastPush(streamed, seeded)).toBe(streamed);
    expect(effectiveLastPush(streamed, undefined)).toBe(streamed);
  });
  it("lets a strictly newer detail win over a stale event", () => {
    const newer = { sha: "c".repeat(40), at: "2026-10-07T10:09:00Z", pushed: true };
    expect(effectiveLastPush(streamed, newer)).toBe(newer);
    expect(effectiveLastPush({ sha: "d".repeat(40), pushed: false }, seeded)).toBe(seeded);
    expect(effectiveLastPush(streamed, { ...seeded, at: streamed.at })).toBe(streamed);
  });
});

describe("livenessTimes (#182)", () => {
  it("turns the api's ages into times on this browser's clock", () => {
    expect(livenessTimes({ seenAgoMs: 5_000, activityAgoMs: 180_000 }, 1_000_000)).toEqual({
      agentSeenAt: 995_000,
      piActiveAt: 820_000,
    });
  });

  it("leaves an age the api didn't send undefined", () => {
    expect(livenessTimes({ seenAgoMs: 0 }, 10)).toEqual({ agentSeenAt: 10, piActiveAt: undefined });
    expect(livenessTimes({}, 10)).toEqual({ agentSeenAt: undefined, piActiveAt: undefined });
  });
});

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

// The session lamp stays blue ("Waiting for you") while pendingUiRequest is set. The direct SSE
// path used to store every extension_ui_request that had an id, including display-only methods,
// and nothing cleared it when the question was answered or the run stopped.
const question = { type: "extension_ui_request", id: "q1", method: "confirm", title: "Ship it?" };

describe("nextPendingUiRequest", () => {
  it("keeps a dialog the run is blocked on", () => {
    expect(nextPendingUiRequest(null, question)).toEqual(question);
    for (const method of ["select", "confirm", "input", "editor"]) {
      expect(nextPendingUiRequest(null, { type: "extension_ui_request", id: "q", method })).toMatchObject({ method });
    }
  });

  it("does not stick a notify or setStatus, and leaves a real question in place", () => {
    expect(nextPendingUiRequest(null, { type: "extension_ui_request", id: "n1", method: "notify", message: "saved" })).toBeNull();
    expect(nextPendingUiRequest(null, { type: "extension_ui_request", id: "s1", method: "setStatus", text: "working" })).toBeNull();
    expect(nextPendingUiRequest(question, { type: "extension_ui_request", id: "n1", method: "notify" })).toEqual(question);
    expect(nextPendingUiRequest(question, { type: "extension_ui_request", id: "s1", method: "setStatus" })).toEqual(question);
  });

  it("clears on no id, or on the poller's cleared frame", () => {
    expect(nextPendingUiRequest(question, { type: "extension_ui_request", method: "confirm" })).toBeNull();
    expect(nextPendingUiRequest(question, { type: "extension_ui_request", cleared: true })).toBeNull();
    expect(nextPendingUiRequest(question, { type: "extension_ui_request", id: "q1", method: "confirm", cleared: true })).toBeNull();
  });

  it("ignores events that are not a ui request", () => {
    expect(nextPendingUiRequest(question, { type: "message_update" })).toEqual(question);
  });
});

describe("nextPendingOnStatus", () => {
  it("clears when the run is stopped or failed", () => {
    expect(nextPendingOnStatus(question, "stopped")).toBeNull();
    expect(nextPendingOnStatus(question, "failed")).toBeNull();
  });

  it("leaves the question while the run is still going", () => {
    expect(nextPendingOnStatus(question, "running")).toBe(question);
    expect(nextPendingOnStatus(question, "idle")).toBe(question);
    expect(nextPendingOnStatus(question, "stopping")).toBe(question);
    expect(nextPendingOnStatus(question, undefined)).toBe(question);
  });
});

describe("nextLiveThought (#285)", () => {
  function assistant(thinking: string | null): PiEntry {
    const content = thinking === null ? [{ type: "text", text: "done" }] : [{ type: "thinking", thinking }];
    return { id: "a", type: "message", message: { role: "assistant", content } };
  }

  it("keeps a thought that is not in the transcript yet", () => {
    expect(nextLiveThought("planning", [])).toBe("planning");
    expect(nextLiveThought("", [])).toBe("");
    expect(nextLiveThought(null, [])).toBeNull();
  });

  it("drops a snapshot that the latest assistant message already stored", () => {
    expect(nextLiveThought("planning", [assistant("planning")])).toBeNull();
    expect(nextLiveThought("still going", [assistant("planning")])).toBe("still going");
    expect(nextLiveThought("planning", [assistant(null)])).toBe("planning");
  });
});
