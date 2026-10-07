// @vitest-environment jsdom
// #498: the redesigned floppy page's pieces in jsdom: tool rows that open, folded look-ups, inline
// diffs, the question card's keys, the composer's Break, and the Disk Box sidebar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TranscriptFlow, ThinkingRow, sameToolRow } from "../src/components/TranscriptFlow.tsx";
import { SessionSheet } from "../src/components/SessionSheet.tsx";
import { PopMenu } from "../src/components/PopMenu.tsx";
import { SessionMenu } from "../src/components/SessionMenu.tsx";
import { loadPaneOpen, savePaneOpen } from "../src/lib/session-prefs.ts";
import type { ChromeCompanion } from "../src/hooks/useChromeCompanion.ts";
import type { FlowTool } from "../src/lib/flow.ts";
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
  const press = (key: string, target: EventTarget) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });

  it("takes focus when it arms; then Enter confirms and Esc cancels", async () => {
    vi.useFakeTimers();
    const onRespond = vi.fn(async () => {});
    const { host } = mount(<UiRequestPanel request={{ id: "q1", method: "confirm", title: "Allow?", message: "m" }} onRespond={onRespond} />);
    const card = host.querySelector<HTMLElement>(".ui-request")!;
    press("Enter", card);
    expect(onRespond).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    expect(document.activeElement).toBe(card);
    press("Enter", card);
    await act(async () => {});
    expect(onRespond).toHaveBeenLastCalledWith("q1", true);
    press("Escape", card);
    await act(async () => {});
    expect(onRespond).toHaveBeenLastCalledWith("q1", false);
  });

  it("keys outside the card never answer, and a draft in progress keeps its focus", () => {
    vi.useFakeTimers();
    const onRespond = vi.fn(async () => {});
    const { host } = mount(
      <>
        <textarea aria-label="draft" defaultValue="half a sentence" />
        <UiRequestPanel request={{ id: "q1", method: "confirm", title: "Allow?", message: "m" }} onRespond={onRespond} />
      </>,
    );
    const draft = host.querySelector("textarea")!;
    draft.focus();
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    expect(document.activeElement).toBe(draft);
    press("Enter", draft);
    press("Enter", document.body);
    press("Escape", document.body);
    expect(onRespond).not.toHaveBeenCalled();
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
        <DiskBoxSidebar currentId="b" needsYou refreshKey="k" archiveKey="a" onHide={() => {}} />
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

describe("ToolRow memo", () => {
  it("a rebuilt item with the same fields and arguments doesn't re-render the row", () => {
    const input = { command: "npm test" };
    const a: FlowTool = { kind: "tool", id: "t", toolName: "bash", toolCallId: "c", input, output: "x", isError: false, running: false };
    expect(sameToolRow({ tool: a }, { tool: { ...a } })).toBe(true);
    expect(sameToolRow({ tool: a }, { tool: { ...a, output: "y" } })).toBe(false);
    expect(sameToolRow({ tool: a }, { tool: { ...a, input: { command: "npm test" } } })).toBe(false);
    expect(sameToolRow({ tool: a, vscodeLive: true }, { tool: a, vscodeLive: false })).toBe(false);
  });
});

describe("Details pane preference", () => {
  it("is unset until toggled, then remembered either way", () => {
    localStorage.clear();
    expect(loadPaneOpen()).toBeNull();
    savePaneOpen(false);
    expect(loadPaneOpen()).toBe(false);
    savePaneOpen(true);
    expect(loadPaneOpen()).toBe(true);
  });
});

describe("SessionSheet", () => {
  function sheet(onClose = vi.fn()) {
    const back = document.createElement("button");
    document.body.appendChild(back);
    const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
    ref.current = back;
    const view = mount(
      <SessionSheet
        onClose={onClose}
        returnFocus={ref}
        menu={
          <>
            <button role="menuitem">One</button>
            <button role="menuitem">Two</button>
          </>
        }
      >
        <button>Last</button>
      </SessionSheet>,
    );
    return { ...view, back, onClose };
  }
  const key = (k: string, shiftKey = false) =>
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
    });

  it("focuses its first action, walks the menu with arrows, and keeps Tab inside", () => {
    const { host } = sheet();
    const items = [...host.querySelectorAll("button")];
    expect(document.activeElement).toBe(items[0]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    items[2]!.focus();
    key("Tab");
    expect(document.activeElement).toBe(items[0]);
    key("Tab", true);
    expect(document.activeElement).toBe(items[2]);
  });

  it("Esc closes it and focus goes back to the ⋯ button; an Esc for a dialog opened from it is left alone", () => {
    const { onClose, back } = sheet();
    const other = document.createElement("div");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);
    key("Escape");
    expect(onClose).not.toHaveBeenCalled();
    other.remove();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup?.();
    cleanup = null;
    expect(document.activeElement).toBe(back);
    back.remove();
  });
});

describe("PopMenu", () => {
  function open() {
    const view = mount(
      <>
        <input aria-label="elsewhere" />
        <PopMenu label="More" icon="⋯">
          {() => <button role="menuitem">Item</button>}
        </PopMenu>
      </>,
    );
    act(() => view.host.querySelector<HTMLButtonElement>("button[aria-label='More']")!.click());
    expect(view.host.querySelector("[role='menu']")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Item");
    return view.host;
  }

  it("Tab closes it", () => {
    const host = open();
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(host.querySelector("[role='menu']")).toBeNull();
  });

  it("focus moving elsewhere closes it, and then its keys are no longer handled", () => {
    const host = open();
    const elsewhere = host.querySelector("input")!;
    act(() => elsewhere.focus());
    expect(host.querySelector("[role='menu']")).toBeNull();
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    act(() => {
      elsewhere.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("SessionMenu", () => {
  const chrome: ChromeCompanion = { ready: true, split: true, note: null, place: () => {}, splitWith: vi.fn() };
  function menu(canStart: boolean) {
    const onStart = vi.fn();
    const view = mount(
      <SessionMenu
        close={() => {}}
        sessionId="me"
        floppyTitle="Me"
        onEject={() => {}}
        chrome={chrome}
        splitTargets={Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, name: `Floppy ${i}` })).concat({ id: "me", name: "Me" })}
        onSwitchModel={() => {}}
        canSwitchModel
        onStop={() => {}}
        canStop={false}
        onStart={onStart}
        canStart={canStart}
        canManage
        archived={false}
        shelving={false}
        onArchive={() => {}}
        onRestore={() => {}}
        onFormat={() => {}}
        onCopyGuruId={() => {}}
      />,
    );
    return { ...view, onStart };
  }

  it("offers Start Drive when the floppy can wake, and every other floppy to split with", () => {
    const { host, onStart } = menu(true);
    const start = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((b) => b.textContent?.includes("Start Drive"))!;
    act(() => start.click());
    expect(onStart).toHaveBeenCalled();
    expect(host.querySelectorAll(".menu-scroll [role='menuitem']")).toHaveLength(9);
  });

  it("no Start Drive while one is going", () => {
    const { host } = menu(false);
    expect(host.textContent).not.toContain("Start Drive");
  });
});
