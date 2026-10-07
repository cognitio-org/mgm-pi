// @vitest-environment jsdom
// #498: the redesigned floppy page's pieces in jsdom: tool rows that open, folded look-ups, inline
// diffs, the question card's keys, the composer's Break, and the Disk Box sidebar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TranscriptFlow, ThinkingRow } from "../src/components/TranscriptFlow.tsx";
import { ARM_DELAY_MS, UiRequestPanel } from "../src/components/UiRequestPanel.tsx";
import { Composer } from "../src/components/Composer.tsx";
import { DiskBoxSidebar } from "../src/components/DiskBoxSidebar.tsx";
import { buildFlow } from "../src/lib/flow.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import type { EntryView } from "../src/lib/entry-view.ts";
import type { SessionSummary } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, rerender: (next: ReactNode) => act(() => root.render(next)) };
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

const views: EntryView[] = [
  { kind: "user", id: "u1", text: "fix it" },
  { kind: "tool-call", id: "a#0", toolName: "read", toolCallId: "c1", input: { path: "src/a.ts" } },
  { kind: "tool-call", id: "a#1", toolName: "grep", toolCallId: "c2", input: { pattern: "x" } },
  { kind: "tool-result", id: "r1", toolName: "read", toolCallId: "c1", text: "1\n2", isError: false },
  { kind: "tool-result", id: "r2", toolName: "grep", toolCallId: "c2", text: "a:1: x", isError: false },
  { kind: "assistant-text", id: "b#0", text: "Found it." },
  { kind: "tool-call", id: "b#1", toolName: "edit", toolCallId: "c3", input: { path: "src/a.ts", edits: [{ oldText: "old line", newText: "new line" }] } },
  { kind: "tool-result", id: "r3", toolName: "edit", toolCallId: "c3", text: "ok", isError: false },
  { kind: "tool-call", id: "c#0", toolName: "bash", toolCallId: "c4", input: { command: "npm test" } },
  { kind: "tool-result", id: "r4", toolName: "bash", toolCallId: "c4", text: "Tests  2 passed (2)", isError: false },
];

function flow() {
  return buildFlow(groupThinkingBlocks(views), { runSettled: true });
}

describe("TranscriptFlow", () => {
  it("renders the turn as frameless blocks and one-line tool rows", () => {
    const { host } = mount(<TranscriptFlow items={flow()} sessionId="s1" previewAccess={() => "sealed"} />);
    expect(host.querySelector(".flow-user")?.textContent).toContain("fix it");
    expect(host.querySelector(".flow-ai")?.textContent).toContain("Found it.");
    expect(host.querySelector(".flow-lookups .flow-tool-name")?.textContent).toBe("Read 1 file, searched 1 pattern");
    const sums = [...host.querySelectorAll(".flow-tool-sum")].map((s) => s.textContent);
    expect(sums).toEqual(["+1 −1", "✓ 2 passed"]);
    expect(host.querySelector(".flow-tool-sum.is-pass")).not.toBeNull();
    expect(host.querySelectorAll(".flow-diff .flow-dl.is-add")).toHaveLength(1);
    expect(host.querySelectorAll(".flow-diff .flow-dl.is-del")).toHaveLength(1);
    // No old chrome: no per-message frames, no rail.
    expect(host.querySelector(".entry.user, .entry.assistant-text, .rail")).toBeNull();
  });

  it("a row opens to its output, and the folded look-ups open to their own rows", () => {
    const { host } = mount(<TranscriptFlow items={flow()} sessionId="s1" previewAccess={() => "sealed"} />);
    const bash = [...host.querySelectorAll<HTMLButtonElement>(".flow-tool-line")].find((b) => b.textContent?.startsWith("Bash"))!;
    expect(bash.getAttribute("aria-expanded")).toBe("false");
    act(() => bash.click());
    expect(bash.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".flow-tool-out")?.textContent).toBe("Tests  2 passed (2)");
    const folded = host.querySelector<HTMLButtonElement>(".flow-lookups > .flow-tool-line")!;
    act(() => folded.click());
    expect([...host.querySelectorAll(".flow-lookups-list .flow-tool-name")].map((n) => n.textContent)).toEqual(["Read", "Grep"]);
  });

  it("a thought is one line that opens; a live one stays open", () => {
    const { host, rerender } = mount(<ThinkingRow blocks={[{ id: "t", text: "pondering" }]} seconds={4} />);
    const line = host.querySelector<HTMLButtonElement>(".flow-think-line")!;
    expect(line.textContent).toContain("Thought for 4s");
    expect(host.querySelector(".flow-think-body")).toBeNull();
    act(() => line.click());
    expect(host.querySelector(".flow-think-body")?.textContent).toBe("pondering");
    rerender(<ThinkingRow blocks={[{ id: "t", text: "still going" }]} live />);
    expect(host.querySelector(".flow-think-line")?.textContent).toContain("Thinking…");
    expect(host.querySelector(".flow-think-body")?.textContent).toBe("still going");
  });
});

describe("UiRequestPanel keys", () => {
  it("Enter confirms and Esc cancels once the card is armed, but not while typing elsewhere", async () => {
    vi.useFakeTimers();
    const onRespond = vi.fn(async () => {});
    const { host } = mount(
      <>
        <textarea aria-label="draft" />
        <UiRequestPanel request={{ id: "q1", method: "confirm", title: "Allow?", message: "m" }} onRespond={onRespond} />
      </>,
    );
    const press = (key: string, target: EventTarget = document.body) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    press("Enter");
    expect(onRespond).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    press("Enter", host.querySelector("textarea")!);
    expect(onRespond).not.toHaveBeenCalled();
    press("Enter");
    await act(async () => {});
    expect(onRespond).toHaveBeenLastCalledWith("q1", true);
    press("Escape");
    await act(async () => {});
    expect(onRespond).toHaveBeenLastCalledWith("q1", false);
  });
});

describe("Composer while a turn runs", () => {
  it("shows Break instead of Send, and Send again beside it once there's a draft", () => {
    const onBreak = vi.fn();
    const { host } = mount(<Composer sessionId="s1" onSend={async () => {}} busy onBreak={onBreak} />);
    expect(host.querySelector(".send-wrap")).toBeNull();
    const brk = host.querySelector<HTMLButtonElement>(".break-button")!;
    expect(brk.getAttribute("aria-label")).toBe("Break");
    act(() => brk.click());
    expect(onBreak).toHaveBeenCalledTimes(1);
    const ta = host.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "next");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".send-wrap > button")?.textContent).toContain("queued");
    expect(host.querySelector(".break-button")).not.toBeNull();
  });
});

describe("DiskBoxSidebar", () => {
  function summary(id: string, runState: string, name: string): SessionSummary {
    return { id, name, status: "open", runState, guru: "g", repo: "org/repo", branch: "main", cost: 0, updatedAt: new Date().toISOString() };
  }

  it("groups floppies, marks the open one, flags a question and counts the Archive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === "/api/providers") return new Response(JSON.stringify({ providers: [] }), { status: 200 });
        const rows = input.includes("archived=only")
          ? [summary("z", "stopped", "Old")]
          : [summary("a", "running", "Busy"), summary("b", "idle", "Open one"), summary("c", "stopped", "Quiet")];
        return new Response(JSON.stringify(rows), { status: 200 });
      }),
    );
    const { host } = mount(
      <MemoryRouter>
        <DiskBoxSidebar currentId="b" needsYou refreshKey="k" onHide={() => {}} />
      </MemoryRouter>,
    );
    await flush();
    const labels = [...host.querySelectorAll(".disk-box-group-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Running2", "Today1", "Archive1"]);
    const current = host.querySelector(".disk-box-row[aria-current='page']")!;
    expect(current.textContent).toContain("Open one");
    expect(current.textContent).toContain("NEEDS YOU");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search floppies");
  });
});
