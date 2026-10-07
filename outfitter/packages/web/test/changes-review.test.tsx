// @vitest-environment jsdom
// #502 review: writes that outlive a floppy switch, one write at a time, fresh reads only on a real
// push, notes kept until sent, capped, a note form that follows its line, and modal focus.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { LastPush } from "../src/api/client.ts";
import { ChangesFullView, ChangesPane, FileDiff } from "../src/components/ChangesPane.tsx";
import { CreatePrDialog } from "../src/components/CreatePrDialog.tsx";
import { MAX_NOTES, noteRefusal, useDiffNotes } from "../src/hooks/useDiffNotes.ts";
import { useSessionGit, type SessionGit } from "../src/hooks/useSessionGit.ts";
import type { DiffNote } from "../src/lib/git-view.ts";
import { changes, pr, status } from "./fixtures/git.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  sessionStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
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
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

type Handler = (url: string) => unknown;
function stub(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const handler = routes[`${method} ${url.split("?")[0]}`];
      const body = handler ? await handler(url) : {};
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

function Probe(props: { id: string; send: (t: string) => Promise<boolean>; onGit: (g: SessionGit) => void; lastPush?: LastPush | null }) {
  const git = useSessionGit({ sessionId: props.id, repo: "o/r", lastPush: props.lastPush ?? null, runState: "idle", send: props.send });
  props.onGit(git);
  return null;
}

const failing = pr({
  number: 9,
  checkSummary: { passed: 0, failed: 1, pending: 0, total: 1, state: "fail" },
  checks: [{ id: "77", name: "ci", kind: "check-run", status: "completed", conclusion: "failure", state: "fail", startedAt: null, completedAt: null, detailsUrl: null, hasLog: true }],
});

describe("writes and a floppy switch", () => {
  it("Fix CI started on one floppy never sends to the next", async () => {
    let releaseLog: (() => void) | null = null;
    stub({
      "GET /api/sessions/a/github-status": () => status({ pr: failing }),
      "GET /api/sessions/b/github-status": () => status(),
      "GET /api/sessions/a/changes": () => changes(),
      "GET /api/sessions/b/changes": () => changes(),
      "GET /api/sessions/a/checks/77/log": () =>
        new Promise((resolve) => {
          releaseLog = () => resolve({ id: "77", name: "ci", conclusion: "failure", detailsUrl: null, log: "boom", truncated: false });
        }),
    });
    const sendA = vi.fn(async () => true);
    const sendB = vi.fn(async () => true);
    let git: SessionGit | null = null;
    const view = mount(<Probe id="a" send={sendA} onGit={(g) => (git = g)} />);
    await flush();
    let done: Promise<void> | null = null;
    act(() => {
      done = git!.fixCi();
    });
    await flush();
    expect(git!.busy).toBe("fix-ci");
    view.rerender(<Probe id="b" send={sendB} onGit={(g) => (git = g)} />);
    await flush();
    // The switch frees the slot for the new floppy.
    expect(git!.busy).toBeNull();
    await act(async () => {
      releaseLog!();
      await done;
    });
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
  });

  it("one write at a time: a second click doesn't start a second, and doesn't clear the first", async () => {
    let releaseSync: (() => void) | null = null;
    const calls = stub({
      "GET /api/sessions/a/github-status": () => status({ pr: failing }),
      "GET /api/sessions/a/changes": () => changes(),
      "POST /api/sessions/a/sync": () =>
        new Promise((resolve) => {
          releaseSync = () => resolve({ status: "up-to-date", via: null, base: "main", branchMoved: false });
        }),
    });
    const send = vi.fn(async () => true);
    let git: SessionGit | null = null;
    mount(<Probe id="a" send={send} onGit={(g) => (git = g)} />);
    await flush();
    let first: Promise<void> | null = null;
    act(() => {
      first = git!.sync();
      void git!.sync();
    });
    await act(async () => git!.fixCi());
    expect(calls.filter((c) => c.startsWith("POST /api/sessions/a/sync"))).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(git!.busy).toBe("sync");
    await act(async () => {
      releaseSync!();
      await first;
    });
    await flush();
    expect(git!.busy).toBeNull();
  });
});

describe("fresh reads", () => {
  it("only a new push on the same floppy asks for fresh status", async () => {
    const calls = stub({ "GET /api/sessions/a/github-status": () => status(), "GET /api/sessions/b/github-status": () => status() });
    const send = vi.fn(async () => true);
    const view = mount(<Probe id="a" send={send} onGit={() => {}} lastPush={{ sha: "111", pushed: true }} />);
    await flush();
    view.rerender(<Probe id="b" send={send} onGit={() => {}} lastPush={{ sha: "222", pushed: true }} />);
    await flush();
    expect(calls.some((c) => c.includes("fresh=1"))).toBe(false);
    view.rerender(<Probe id="b" send={send} onGit={() => {}} lastPush={{ sha: "333", pushed: true }} />);
    await flush();
    expect(calls).toContain("GET /api/sessions/b/github-status?fresh=1");
  });
});

describe("diff notes", () => {
  const note = (i: number): DiffNote => ({ path: "a.ts", line: i, side: "new", text: `note ${i}` });

  it("are capped by count and by size", () => {
    expect(noteRefusal([], note(1))).toBeNull();
    expect(noteRefusal(Array.from({ length: MAX_NOTES }, (_, i) => note(i)), note(99))).toMatch(/50 notes/);
    expect(noteRefusal([], { ...note(1), text: "x".repeat(25_000) })).toMatch(/too long/);
  });

  it("stay when the send fails, with a message", async () => {
    sessionStorage.setItem("outfitterDiffNotes:s1", JSON.stringify([note(2)]));
    const git = {
      status: status(),
      changes: changes(),
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
      resolveConflict: async () => {},
    } satisfies SessionGit;
    function Pane() {
      const notes = useDiffNotes("s1");
      return <ChangesPane git={git} notes={notes} lastPush={null} onCreatePr={() => {}} onSendNotes={async () => false} />;
    }
    const { host } = mount(<Pane />);
    const sendBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Send to agent")!;
    await act(async () => sendBtn.click());
    await flush();
    expect(host.querySelector(".git-notes-bar")?.textContent).toContain("1 note on the diff");
    expect(host.querySelector(".git-notes-error")?.textContent).toMatch(/kept/);
  });

  it("an open note form closes when a refresh takes its line away", () => {
    function Diff({ patch }: { patch: string }) {
      const notes = useDiffNotes("s1");
      return <FileDiff file={{ path: "a.ts", status: "M", additions: 1, deletions: 0, patch }} notes={notes} />;
    }
    const view = mount(<Diff patch={"@@ -1,1 +1,2 @@\n a\n+b"} />);
    act(() => view.host.querySelector<HTMLButtonElement>("button.diff-row.is-add")!.click());
    expect(view.host.querySelector(".diff-note-form")).not.toBeNull();
    // Same line, refreshed patch: the form stays on it.
    view.rerender(<Diff patch={"@@ -1,1 +1,2 @@\n a\n+b"} />);
    expect(view.host.querySelector(".diff-note-form")).not.toBeNull();
    view.rerender(<Diff patch={"@@ -1,1 +1,1 @@\n-a\n+z"} />);
    expect(view.host.querySelector(".diff-note-form")).toBeNull();
  });
});

describe("modal focus", () => {
  it("Create PR traps Tab, Esc closes it, and focus returns to the opener", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = mount(<CreatePrDialog defaultTitle="t" repo="o/r" branch="b" base="main" onSubmit={async () => ({ ok: true })} onClose={onClose} />);
    const dialog = view.host.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const focusables = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea")];
    focusables.at(-1)!.focus();
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(focusables[0]);
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalled();
    cleanup?.();
    cleanup = null;
    expect(document.activeElement).toBe(opener);
  });

  it("the phone's Changes view takes focus and gives it back", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = mount(
      <ChangesFullView title="Floppy" onClose={onClose}>
        <button>inside</button>
      </ChangesFullView>,
    );
    expect(view.host.querySelector("[role='dialog']")!.contains(document.activeElement)).toBe(true);
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalled();
    cleanup?.();
    cleanup = null;
    expect(document.activeElement).toBe(opener);
  });
});
