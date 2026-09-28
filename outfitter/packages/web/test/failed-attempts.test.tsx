// @vitest-environment jsdom
// A failed model call pi retries (session 8a83cb6b, 2026-09-28): a local model behind a tunnel
// dropped each reply at about five minutes. pi hid every failed attempt from the model with a
// context_edit and retried; the transcript showed "unrecognized entry: context_edit", an empty tool
// box, and no error at all.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PiEntry } from "../src/api/client.ts";
import { entriesToViews, entryToViews, failedAttemptCopy } from "../src/lib/entry-view.ts";
import { groupBeats, collapseRail, type RailTool } from "../src/lib/beats.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import { EntryItem } from "../src/components/EntryItem.tsx";
import { deriveSessionActivity, notePendingRunState, type PendingSend } from "../src/lib/send-status.ts";

const DROPPED =
  "litellm.APIConnectionError: APIConnectionError: OpenAIException - Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>. SSLError(1, '[SSL] record layer failure (_ssl.c:2718)')";

function failedAttempt(id: string): PiEntry {
  return {
    id,
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me compile everything into a well-structured HTML report." },
        { type: "toolCall", id: `call-${id}`, name: "html_report", arguments: {} },
      ],
      stopReason: "error",
      errorMessage: DROPPED,
    },
  };
}

function hide(id: string, targetId: string): PiEntry {
  return { id, type: "context_edit", targetId, replacement: null };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function show(view: unknown): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<EntryItem view={view as never} />));
  return container;
}

const user: PiEntry = { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "research it" }] } };

describe("failed attempts", () => {
  it("a failed reply keeps its prose, marks its tool call interrupted, and ends with a failed row", () => {
    expect(entryToViews(failedAttempt("a1"))).toEqual([
      { kind: "assistant-text", id: "a1#0", text: "Let me compile everything into a well-structured HTML report." },
      { kind: "tool-call", id: "a1#1", toolName: "html_report", toolCallId: "call-a1", input: {}, interrupted: true },
      { kind: "assistant-failed", id: "a1#failed", stopReason: "error", errorMessage: DROPPED },
    ]);
  });

  it("pi's retry edit folds into the failed row instead of rendering as its own line", () => {
    const views = entriesToViews([user, failedAttempt("a1"), hide("x1", "a1")]);
    expect(views.some((v) => v.kind === "context-edit" || v.kind === "unknown")).toBe(false);
    expect(views.at(-1)).toMatchObject({ kind: "assistant-failed", hidden: true });
  });

  it("any other context edit is a quiet line, not 'unrecognized entry'", () => {
    const views = entriesToViews([user, hide("x1", "u1"), { id: "x2", type: "context_edit", targetId: "u1", replacement: [] }]);
    expect(views.slice(1)).toEqual([
      { kind: "context-edit", id: "x1", targetId: "u1", replaced: false },
      { kind: "context-edit", id: "x2", targetId: "u1", replaced: true },
    ]);
    expect(show(views[1]).textContent).toBe("An earlier message was hidden from the model");
  });

  it("says the connection dropped and that pi is retrying, with the raw error behind a disclosure", () => {
    const [failed] = entriesToViews([failedAttempt("a1"), hide("x1", "a1")]).filter((v) => v.kind === "assistant-failed");
    const el = show(failed);
    expect(el.querySelector(".entry-label")?.textContent).toBe("Attempt failed, retrying");
    expect(el.textContent).toContain("The connection to the model dropped. pi hid this attempt from the model and tried again.");
    expect(el.querySelector("details summary")?.textContent).toBe("Error");
    expect(el.querySelector("details pre")?.textContent).toContain("record layer failure");
  });

  it("copy for an unretried failure, an unknown error, and a stopped reply", () => {
    expect(failedAttemptCopy({ kind: "assistant-failed", id: "f", stopReason: "error", errorMessage: DROPPED })).toEqual({
      headline: "Model call failed",
      note: "The connection to the model dropped.",
    });
    expect(failedAttemptCopy({ kind: "assistant-failed", id: "f", stopReason: "error", errorMessage: "400 bad request" }).note).toBe(
      "The model call failed.",
    );
    expect(failedAttemptCopy({ kind: "assistant-failed", id: "f", stopReason: "aborted", errorMessage: "" }).headline).toBe("Reply stopped");
  });

  it("an interrupted call is not running, not batched away, and says it never ran", () => {
    const entries = [user, failedAttempt("a1"), hide("x1", "a1"), failedAttempt("a2"), hide("x2", "a2")];
    const beats = groupBeats(groupThinkingBlocks(entriesToViews(entries)));
    const tools = beats.flatMap((b) => ("rail" in b ? b.rail : [])).filter((i): i is RailTool => i.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.interrupted && !t.running)).toBe(true);
    expect(collapseRail(tools).every((g) => g.kind === "single")).toBe(true);
    const failedRows = beats.filter((b) => b.kind === "passthrough" && b.view.kind === "assistant-failed");
    expect(failedRows).toHaveLength(2);
  });
});

describe("status line during a retry", () => {
  const p = notePendingRunState(
    { localId: "l", text: "research it", sentAt: 0, acceptedAt: 0, baseline: 0, runStateAtSend: "stopped", sawChange: false, sawRunning: false } satisfies PendingSend,
    "running",
  )!;
  const derive = (entries: PiEntry[]) => deriveSessionActivity({ runState: "running", pending: p, entries, now: 1000, lastProgressAt: 1000 });

  it("a failed attempt pi is retrying is not the reply: still working", () => {
    expect(derive([user, failedAttempt("a1"), hide("x1", "a1")]).phase).toBe("working");
  });

  it("a failure pi does not retry still ends the wait", () => {
    expect(derive([user, failedAttempt("a1")]).phase).toBe("none");
  });
});
