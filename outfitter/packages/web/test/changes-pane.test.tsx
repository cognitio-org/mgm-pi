// @vitest-environment jsdom
// #502: the git chips, the Changes tab, diff notes, Create PR, and the actions behind them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChangesPane, type AutofixControl } from "../src/components/ChangesPane.tsx";
import { GitChips, GitStrip } from "../src/components/GitChips.tsx";
import { CreatePrDialog } from "../src/components/CreatePrDialog.tsx";
import { useDiffNotes } from "../src/hooks/useDiffNotes.ts";
import { useSessionGit, type SessionGit } from "../src/hooks/useSessionGit.ts";
import { changes, pr, status } from "./fixtures/git.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  sessionStorage.clear();
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
  return host;
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

function fakeGit(over: Partial<SessionGit> = {}): SessionGit {
  return {
    status: status(),
    changes: changes(),
    changesError: null,
    refresh: vi.fn(),
    busy: null,
    notice: null,
    clearNotice: vi.fn(),
    syncConflict: false,
    mergedPr: null,
    logs: {},
    loadLog: vi.fn(),
    createPr: vi.fn(async () => ({ ok: true })),
    merge: vi.fn(async () => {}),
    sync: vi.fn(async () => {}),
    rerun: vi.fn(async () => {}),
    fixCi: vi.fn(async () => {}),
    resolveConflict: vi.fn(),
    ...over,
  };
}

function Pane({
  git,
  onSend = async () => true,
  onCreatePr = () => {},
  autofix,
}: {
  git: SessionGit;
  onSend?: (t: string) => Promise<boolean>;
  onCreatePr?: () => void;
  autofix?: AutofixControl;
}) {
  const notes = useDiffNotes("s1");
  return <ChangesPane git={git} notes={notes} lastPush={{ sha: "7c1e9a4ffff", pushed: true }} onCreatePr={onCreatePr} onSendNotes={onSend} autofix={autofix} />;
}

const button = (host: HTMLElement, text: RegExp) => [...host.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""))!;

describe("GitChips", () => {
  it("every chip opens Changes; Create PR and Fix CI say what they do", () => {
    const onAction = vi.fn();
    const host = mount(<GitChips git={fakeGit({ changes: changes({ behind: 3 }) })} onAction={onAction} />);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["x", "+4−1", "↓3 main", " Create PR"]);
    act(() => host.querySelectorAll("button")[0]!.click());
    expect(onAction).toHaveBeenLastCalledWith("changes");
    act(() => button(host, /Create PR/).click());
    expect(onAction).toHaveBeenLastCalledWith("create-pr");
  });

  it("a failing PR shows its checks and Fix CI; the phone strip is one button", () => {
    const git = fakeGit({ status: status({ pr: pr({ checkSummary: { passed: 2, failed: 1, pending: 0, total: 3, state: "fail" } }) }) });
    const host = mount(<GitChips git={git} onAction={() => {}} />);
    expect(host.querySelector(".git-chip.is-fail")?.textContent).toContain("✗ 1 failing");
    expect(button(host, /Fix CI/)).toBeTruthy();
    cleanup?.();
    const onOpen = vi.fn();
    const strip = mount(<GitStrip git={git} onOpen={onOpen} />);
    expect(strip.querySelectorAll("button")).toHaveLength(1);
    act(() => strip.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("ChangesPane", () => {
  it("shows the branch, the last push, Create PR, and the files", () => {
    const onCreatePr = vi.fn();
    const host = mount(<Pane git={fakeGit()} onCreatePr={onCreatePr} />);
    expect(host.querySelector(".git-branch-line")?.textContent).toBe("claude/x → main");
    expect(host.querySelector(".git-pushed")?.textContent).toContain("Pushed · 7c1e9a4");
    act(() => button(host, /^Create PR$/).click());
    expect(onCreatePr).toHaveBeenCalled();
    const file = host.querySelector<HTMLButtonElement>(".git-file-row")!;
    expect(file.textContent).toContain("src/a.ts");
    act(() => file.click());
    expect(file.getAttribute("aria-expanded")).toBe("true");
    expect([...host.querySelectorAll(".diff-row .diff-ln:nth-child(2)")].map((n) => n.textContent)).toEqual(["", "1", "", "2", "3"]);
  });

  it("a note on a diff line goes to the agent as path:line in one message", async () => {
    const onSend = vi.fn(async () => true);
    const host = mount(<Pane git={fakeGit()} onSend={onSend} />);
    act(() => host.querySelector<HTMLButtonElement>(".git-file-row")!.click());
    const added = host.querySelector<HTMLButtonElement>("button.diff-row.is-add")!;
    act(() => added.click());
    const ta = host.querySelector<HTMLTextAreaElement>(".diff-note-form textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "rename this");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button(host, /Add note/).click());
    expect(host.querySelector(".diff-note")?.textContent).toContain("rename this");
    expect(host.querySelector(".git-notes-bar")?.textContent).toContain("1 note on the diff");
    await act(async () => button(host, /Send to agent/).click());
    expect(onSend).toHaveBeenCalledWith("Notes on the diff:\n- src/a.ts:2: rename this");
    expect(host.querySelector(".git-notes-bar")).toBeNull();
  });

  it("behind the base offers Sync; a conflict offers Resolve with agent", () => {
    const git = fakeGit({ changes: changes({ behind: 2 }) });
    const host = mount(<Pane git={git} />);
    act(() => button(host, /Sync with main/).click());
    expect(git.sync).toHaveBeenCalled();
    cleanup?.();
    const conflicted = fakeGit({ syncConflict: true });
    const again = mount(<Pane git={conflicted} />);
    act(() => button(again, /Resolve with agent/).click());
    expect(conflicted.resolveConflict).toHaveBeenCalled();
  });

  it("a failing check shows its log tail with Fix CI and Re-run", () => {
    const failing = pr({
      checkSummary: { passed: 0, failed: 1, pending: 0, total: 1, state: "fail" },
      checks: [{ id: "77", name: "api / test", kind: "check-run", status: "completed", conclusion: "failure", state: "fail", startedAt: null, completedAt: null, detailsUrl: null, hasLog: true }],
      mergeable: true,
    });
    const git = fakeGit({ status: status({ pr: failing }), logs: { "77": { state: "ready", log: { id: "77", name: "api / test", conclusion: "failure", detailsUrl: null, log: "FAIL voice.test.ts", truncated: false } } } });
    const host = mount(<Pane git={git} />);
    expect(host.querySelector(".git-log")?.textContent).toBe("FAIL voice.test.ts");
    act(() => button(host, /^Fix CI$/).click());
    expect(git.fixCi).toHaveBeenCalled();
    act(() => button(host, /^Re-run$/).click());
    expect(git.rerun).toHaveBeenCalled();
    expect(button(host, /Merge…/).disabled).toBe(true);
    expect(host.querySelector(".git-merge-why")?.textContent).toMatch(/failing/);
    // No Auto-fix control passed (a floppy without a repo): no switch.
    expect(host.querySelector("[role='switch'][aria-label^='Auto-fix']")).toBeNull();
  });

  it("#503: the Auto-fix switch turns on, shows the last send, and says why it can't change", async () => {
    const onToggle = vi.fn(async () => null as string | null);
    const sw = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[role='switch'][aria-label='Auto-fix CI']")!;
    let host = mount(<Pane git={fakeGit({ status: status({ pr: pr() }) })} autofix={{ state: { on: false }, canManage: true, onToggle }} />);
    expect(sw(host).getAttribute("aria-checked")).toBe("false");
    await act(async () => sw(host).click());
    expect(onToggle).toHaveBeenCalledWith(true);

    host = mount(
      <Pane
        git={fakeGit({ status: status({ pr: pr() }) })}
        autofix={{ state: { on: true, lastSha: "abcdef1234567", lastAt: new Date().toISOString() }, canManage: true, onToggle }}
      />,
    );
    expect(sw(host).getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toMatch(/Last sent for abcdef1/);

    const refused = vi.fn(async () => "Auto-fix is on for 10 floppies already.");
    host = mount(<Pane git={fakeGit({ status: status({ pr: pr() }) })} autofix={{ state: { on: false }, canManage: true, onToggle: refused }} />);
    await act(async () => sw(host).click());
    expect(host.querySelector("[role='alert']")?.textContent).toBe("Auto-fix is on for 10 floppies already.");

    host = mount(<Pane git={fakeGit({ status: status({ pr: pr() }) })} autofix={{ state: { on: false, notice: "Auto-fix turned itself off after 3 days of failing CI." }, canManage: false, onToggle }} />);
    expect(sw(host).disabled).toBe(true);
    expect(host.textContent).toMatch(/turned itself off/);
  });

  it("Merge asks once, then squashes into the base", () => {
    const git = fakeGit({ status: status({ pr: pr() }) });
    const host = mount(<Pane git={git} />);
    act(() => button(host, /Merge…/).click());
    act(() => button(host, /Squash and merge into main/).click());
    expect(git.merge).toHaveBeenCalled();
  });

  it("explains a floppy with nothing to show", () => {
    const host = mount(<Pane git={fakeGit({ status: null, changes: changes({ source: "none", reason: "not-found", files: [] }) })} />);
    expect(host.textContent).toContain("Nothing pushed yet: GitHub doesn't have this branch.");
  });
});

describe("CreatePrDialog", () => {
  it("prefills the title, sends draft, and shows the api's refusal inline", async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, error: "This branch already has a pull request.", url: "https://github.com/o/r/pull/1" }));
    const onClose = vi.fn();
    const host = mount(<CreatePrDialog defaultTitle="Fix login" repo="o/r" branch="claude/x" base="main" onSubmit={onSubmit} onClose={onClose} />);
    expect(host.querySelector<HTMLInputElement>("input:not([type])")!.value).toBe("Fix login");
    expect(host.querySelector("textarea")!.placeholder).toMatch(/template/);
    act(() => host.querySelector<HTMLInputElement>("input[type='checkbox']")!.click());
    await act(async () => button(host, /Create PR/).click());
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ title: "Fix login", draft: true });
    expect(host.querySelector("[role='alert']")?.textContent).toContain("already has a pull request");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("useSessionGit actions", () => {
  type Route = (url: string, init?: RequestInit) => unknown;
  function stub(routes: Record<string, Route>) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
        calls.push(`${init?.method ?? "GET"} ${url}`);
        const handler = routes[key];
        const body = handler ? handler(url, init) : {};
        if (body instanceof Response) return body;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    return calls;
  }

  function Probe({ onGit, send, runState = "idle" }: { onGit: (g: SessionGit) => void; send: (t: string) => Promise<boolean>; runState?: string }) {
    const git = useSessionGit({ sessionId: "s1", repo: "o/r", lastPush: null, runState, send });
    onGit(git);
    return null;
  }

  it("Fix CI sends the failing check's log tail through the page's send", async () => {
    const failing = pr({
      number: 9,
      checkSummary: { passed: 0, failed: 1, pending: 0, total: 1, state: "fail" },
      checks: [{ id: "77", name: "api / test", kind: "check-run", status: "completed", conclusion: "failure", state: "fail", startedAt: null, completedAt: null, detailsUrl: null, hasLog: true }],
    });
    const calls = stub({
      "GET /api/sessions/s1/github-status": () => status({ pr: failing }),
      "GET /api/sessions/s1/changes": () => changes(),
      "GET /api/sessions/s1/checks/77/log": () => ({ id: "77", name: "api / test", conclusion: "failure", detailsUrl: null, log: "boom", truncated: false }),
    });
    const send = vi.fn(async () => true);
    let git: SessionGit | null = null;
    mount(<Probe onGit={(g) => (git = g)} send={send} />);
    await flush();
    await act(async () => git!.fixCi());
    await flush();
    expect(send).toHaveBeenCalledWith("CI failed on #9 (api / test). Fix it and push.\n\n```\nboom\n```");
    // Every write refreshes status with fresh=1.
    expect(calls).toContain("GET /api/sessions/s1/github-status?fresh=1");
  });

  it("a merge whose head moved says so and refreshes; a sync that moved the branch tells a live Drive", async () => {
    stub({
      "GET /api/sessions/s1/github-status": () => status({ pr: pr() }),
      "GET /api/sessions/s1/changes": () => changes(),
      "POST /api/sessions/s1/pr/merge": () => new Response(JSON.stringify({ error: "head moved", code: "head-moved" }), { status: 409 }),
      "POST /api/sessions/s1/sync": () => ({ status: "updated", via: "merge", base: "main", branchMoved: true, agentNote: "Pull origin before going on." }),
    });
    const send = vi.fn(async () => true);
    let git: SessionGit | null = null;
    mount(<Probe onGit={(g) => (git = g)} send={send} runState="idle" />);
    await flush();
    await act(async () => git!.merge());
    await flush();
    expect(git!.notice?.text).toMatch(/branch moved/);
    await act(async () => git!.sync());
    await flush();
    expect(send).toHaveBeenCalledWith("Pull origin before going on.");
  });
});
