// @vitest-environment jsdom
// #502: the Changes tab in jsdom: a click on a diff line takes a note, the notes go to the agent in
// one message, and the header chips route to their actions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChangesPane } from "../src/components/ChangesPane.tsx";
import { GitChips, type GitChipAction } from "../src/components/GitChips.tsx";
import { useDiffNotes } from "../src/hooks/useDiffNotes.ts";
import type { SessionGit } from "../src/hooks/useSessionGit.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  sessionStorage.clear();
});

function render(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  act(() => (el as HTMLElement).click());
}

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

function fakeGit(overrides: Partial<SessionGit> = {}): SessionGit {
  return {
    status: null,
    changes: {
      source: "github",
      base: "main",
      branch: "claude/x",
      ahead: 1,
      behind: 0,
      truncated: false,
      files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n-old\n+new\n same" }],
    },
    changesError: null,
    refresh: () => {},
    busy: null,
    notice: null,
    clearNotice: () => {},
    syncConflict: false,
    mergedPr: null,
    logs: {},
    loadLog: () => {},
    createPr: async () => ({ ok: true }),
    merge: async () => {},
    sync: async () => {},
    rerun: async () => {},
    fixCi: async () => {},
    resolveConflict: () => {},
    ...overrides,
  };
}

function Pane({ git, onSendNotes }: { git: SessionGit; onSendNotes: (text: string) => void }) {
  const notes = useDiffNotes("s1");
  return <ChangesPane git={git} notes={notes} lastPush={null} onCreatePr={() => {}} onSendNotes={onSendNotes} />;
}

describe("ChangesPane", () => {
  it("takes a note on a diff line and sends every note in one message", () => {
    const onSendNotes = vi.fn();
    const host = render(<Pane git={fakeGit()} onSendNotes={onSendNotes} />);

    click(host.querySelector(".git-file-row"));
    const added = [...host.querySelectorAll<HTMLButtonElement>("button.diff-row")].find((b) => b.classList.contains("is-add"));
    click(added);
    type(host.querySelector<HTMLTextAreaElement>(".diff-note-form textarea")!, "Name it better");
    click(button(host, "Add note"));

    expect(host.querySelector(".diff-note")?.textContent).toContain("Name it better");
    expect(host.querySelector(".git-notes-bar")?.textContent).toContain("1 note on the diff");

    click(button(host, "Send to agent"));
    expect(onSendNotes).toHaveBeenCalledWith("Notes on the diff:\n- src/a.ts:1: Name it better");
    expect(host.querySelector(".git-notes-bar")).toBeNull();
  });

  it("offers Sync when the branch is behind, and Resolve when it conflicts", () => {
    const sync = vi.fn(async () => {});
    const behind = fakeGit({ sync });
    behind.changes = { ...behind.changes!, behind: 2 };
    const host = render(<Pane git={behind} onSendNotes={() => {}} />);
    click(button(host, "Sync with main"));
    expect(sync).toHaveBeenCalled();
    cleanup?.();

    const resolveConflict = vi.fn();
    const conflicted = render(<Pane git={fakeGit({ syncConflict: true, resolveConflict })} onSendNotes={() => {}} />);
    expect(conflicted.textContent).toContain("Merge conflict with main");
    click(button(conflicted, "Resolve with agent"));
    expect(resolveConflict).toHaveBeenCalled();
  });
});

describe("GitChips", () => {
  it("routes Create PR to its dialog and the rest to the Changes tab", () => {
    const actions: GitChipAction[] = [];
    const host = render(<GitChips git={fakeGit()} onAction={(a) => actions.push(a)} />);
    click(host.querySelector("[aria-label='Create a pull request']"));
    click(host.querySelector(".git-chip"));
    expect(actions).toEqual(["create-pr", "changes"]);
  });
});
