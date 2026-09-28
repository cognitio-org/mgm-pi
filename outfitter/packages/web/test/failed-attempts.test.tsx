// @vitest-environment jsdom
// A failed model call pi retries (session 8a83cb6b, 2026-09-28): a local model behind a tunnel
// dropped each reply at about five minutes. pi hid every failed attempt from the model with a
// context_edit and retried; the transcript showed "unrecognized entry: context_edit", an empty tool
// box, and no error at all.
import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PiEntry } from "../src/api/client.ts";
import { entriesToViews, entryToViews, failedAttemptCopy, hiddenEntryIds } from "../src/lib/entry-view.ts";
import { groupBeats, collapseRail, type RailTool } from "../src/lib/beats.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import { EntryItem } from "../src/components/EntryItem.tsx";
import { TranscriptRail, beatOpensVsCode } from "../src/components/TranscriptRail.tsx";
import { deriveSessionActivity, isFinalAssistant, notePendingRunState, type PendingSend } from "../src/lib/send-status.ts";

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

function mount(node: React.ReactNode): HTMLElement {
  // TranscriptRail places its card with matchMedia (desktop here); jsdom has none.
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

const reply: PiEntry = { id: "ok", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Here's your report." }] } };

function failedView(entries: PiEntry[], options?: { runSettled?: boolean }) {
  return entriesToViews(entries, options).filter((v) => v.kind === "assistant-failed");
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

  it("pi's pre-built error message (no content) is only the failed row", () => {
    const empty: PiEntry = { id: "a1", type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } };
    expect(entryToViews(empty)).toEqual([{ kind: "assistant-failed", id: "a1#failed", stopReason: "error", errorMessage: "boom" }]);
  });

  it("pi's retry edit folds into the failed row instead of rendering as its own line", () => {
    const views = entriesToViews([user, failedAttempt("a1"), hide("x1", "a1")]);
    expect(views.some((v) => v.kind === "context-edit" || v.kind === "unknown")).toBe(false);
    expect(views.at(-1)).toMatchObject({ kind: "assistant-failed", retry: "retrying" });
  });

  it("the retry state follows what came after: retried, retrying, cancelled, or none", () => {
    const retried = [user, failedAttempt("a1"), hide("x1", "a1"), reply];
    expect(failedView(retried)[0]).toMatchObject({ retry: "retried" });
    expect(failedView(retried, { runSettled: true })[0]).toMatchObject({ retry: "retried" });
    const waiting = [user, failedAttempt("a1"), hide("x1", "a1")];
    expect(failedView(waiting)[0]).toMatchObject({ retry: "retrying" });
    // Stop during pi's backoff: the edit is written, the retry never happens.
    expect(failedView(waiting, { runSettled: true })[0]).toMatchObject({ retry: "cancelled" });
    expect(failedView([user, failedAttempt("a1"), reply])[0]!.retry).toBeUndefined();
  });

  it("builds fresh views: the same entries give the same answer twice", () => {
    const entries = [user, failedAttempt("a1"), hide("x1", "a1")];
    expect(entriesToViews(entries)).toEqual(entriesToViews(entries));
    expect(entryToViews(entries[1]!).at(-1)).not.toHaveProperty("retry");
  });

  it("other context edits are one quiet line per run, not 'unrecognized entry'", () => {
    const edits = [hide("x1", "u1"), hide("x2", "t1"), { id: "x3", type: "context_edit", targetId: "u1", replacement: [] }];
    const views = entriesToViews([user, ...edits]);
    expect(views.slice(1)).toEqual([
      { kind: "context-edit", id: "x1", count: 2, replaced: false },
      { kind: "context-edit", id: "x3", count: 1, replaced: true },
    ]);
    expect(show(views[1]).textContent).toBe("2 earlier messages were hidden from the model");
    act(() => root?.unmount());
    container?.remove();
    expect(show(views[2]).textContent).toBe("An earlier message was replaced in the model's context");
  });

  it("renders the connection drop and the retry, with the raw error behind a disclosure", () => {
    const el = show(failedView([user, failedAttempt("a1"), hide("x1", "a1")])[0]);
    expect(el.querySelector(".entry-label")?.textContent).toBe("Attempt failed, retrying");
    expect(el.textContent).toContain("The connection to the model dropped. pi hid this attempt from the model and is trying again.");
    expect(el.querySelector("details summary")?.textContent).toBe("Error");
    expect(el.querySelector("details pre")?.textContent).toContain("record layer failure");
    expect(el.querySelector("[role]")).toBeNull();
  });

  it("renders a failure pi does not retry as 'Model call failed'", () => {
    const el = show(failedView([user, failedAttempt("a1")])[0]);
    expect(el.querySelector(".entry-label")?.textContent).toBe("Model call failed");
    expect(el.textContent).toContain("The connection to the model dropped.");
  });

  it("copy for each state, an unknown error, and a stopped reply", () => {
    const base = { kind: "assistant-failed" as const, id: "f", stopReason: "error" as const, errorMessage: DROPPED };
    expect(failedAttemptCopy({ ...base, retry: "retried" }).headline).toBe("Attempt failed, retried");
    expect(failedAttemptCopy({ ...base, retry: "cancelled" })).toEqual({
      headline: "Attempt failed",
      note: "The connection to the model dropped. pi hid this attempt from the model, but the retry was stopped.",
    });
    expect(failedAttemptCopy({ ...base, errorMessage: "400 bad request" }).note).toBe("The model call failed.");
    expect(failedAttemptCopy({ ...base, errorMessage: "terminated" }).note).toBe("The connection to the model dropped.");
    expect(failedAttemptCopy({ ...base, errorMessage: "generation terminated by content filter" }).note).toBe("The model call failed.");
    expect(failedAttemptCopy({ ...base, stopReason: "aborted", errorMessage: "" }).headline).toBe("Reply stopped");
  });

  it("an aborted reply's calls are interrupted too, and it is never 'retrying'", () => {
    const aborted: PiEntry = {
      id: "a1",
      type: "message",
      message: { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] },
    };
    const views = entriesToViews([user, aborted]);
    expect(views[1]).toMatchObject({ kind: "tool-call", interrupted: true });
    expect(failedAttemptCopy(views[2] as never).headline).toBe("Reply stopped");
  });

  it("an interrupted call is not running, not batched, not paired with a later result, and says it never ran", () => {
    const entries = [user, failedAttempt("a1"), hide("x1", "a1"), failedAttempt("a2"), hide("x2", "a2")];
    const late: PiEntry = { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "call-a1", toolName: "html_report", content: "late", isError: false } };
    const beats = groupBeats(groupThinkingBlocks(entriesToViews([...entries, late])));
    const tools = beats.flatMap((b) => ("rail" in b ? b.rail : [])).filter((i): i is RailTool => i.kind === "tool");
    const interrupted = tools.filter((t) => t.interrupted);
    expect(interrupted).toHaveLength(2);
    expect(interrupted.every((t) => !t.running && t.output === undefined)).toBe(true);
    expect(collapseRail(interrupted).every((g) => g.kind === "single")).toBe(true);
    expect(beats.filter((b) => b.kind === "passthrough" && b.view.kind === "assistant-failed")).toHaveLength(2);

    const el = mount(<TranscriptRail items={interrupted.slice(0, 1)} />);
    const glyph = el.querySelector(".rail-glyph")!;
    expect(glyph.getAttribute("aria-label")).toBe("Show tool html_report, interrupted");
    expect(glyph.classList.contains("is-error")).toBe(true);
    act(() => (glyph as HTMLButtonElement).click());
    expect(el.querySelector(".rail-card")?.classList.contains("is-error")).toBe(true);
    expect(el.querySelector(".rail-card-body")?.textContent).toContain("the reply was cut off, so this call never ran");
  });

  it("an interrupted vscode call opens no VS Code chip", () => {
    const tool = (interrupted: boolean): RailTool => ({ kind: "tool", id: "t", toolName: "vscode", toolCallId: "c", isError: false, running: false, ...(interrupted ? { interrupted } : {}) });
    expect(beatOpensVsCode({ kind: "tools-only", rail: [tool(true)] })).toBe(false);
    expect(beatOpensVsCode({ kind: "tools-only", rail: [tool(false)] })).toBe(true);
  });
});

describe("status line during a retry", () => {
  const p = notePendingRunState(
    { localId: "l", text: "research it", sentAt: 0, acceptedAt: 0, baseline: 0, runStateAtSend: "stopped", sawChange: false, sawRunning: false } satisfies PendingSend,
    "running",
  )!;
  const derive = (entries: PiEntry[], runState = "running") => deriveSessionActivity({ runState, pending: p, entries, now: 1000, lastProgressAt: 1000 });

  it("a failed attempt pi is retrying is not the reply: still working", () => {
    expect(derive([user, failedAttempt("a1"), hide("x1", "a1")]).phase).toBe("working");
  });

  it("a failed message whose edit hasn't arrived yet isn't the reply while the run is running", () => {
    expect(derive([user, failedAttempt("a1")]).phase).toBe("working");
  });

  it("a failure pi does not retry ends the wait once the run settles", () => {
    expect(derive([user, failedAttempt("a1")], "idle").phase).toBe("none");
    expect(isFinalAssistant(failedAttempt("a1"), { runState: "failed" })).toBe(true);
  });

  it("an edit that replaces a reply (rather than hiding it) leaves it final", () => {
    const edited = { id: "x1", type: "context_edit", targetId: "ok", replacement: [{ type: "text", text: "short" }] };
    expect(isFinalAssistant(reply, { hidden: hiddenEntryIds([reply, edited]) })).toBe(true);
    expect(isFinalAssistant(reply, { hidden: hiddenEntryIds([reply, hide("x2", "ok")]) })).toBe(false);
  });
});
