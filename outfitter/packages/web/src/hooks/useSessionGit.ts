import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type CheckLog,
  type GithubSessionStatus,
  type LastPush,
  type SessionChanges,
} from "../api/client.ts";
import { conflictMessage, conflictedFiles, fixCiMessage } from "../lib/git-view.ts";

/** github-status is cached by the api; this is how often the page re-reads it (as GithubStatus did). */
export const GIT_STATUS_POLL_MS = 60_000;
/** /changes asks the Drive or GitHub for a diff: never more often than this unless forced. */
export const CHANGES_MIN_MS = 15_000;
/** And re-read on its own at this pace while the tab is visible. */
export const CHANGES_POLL_MS = 60_000;

export type GitBusy = "create-pr" | "merge" | "sync" | "rerun" | "fix-ci" | "resolve" | null;

export interface GitNotice {
  tone: "ok" | "warn" | "error";
  text: string;
}

export type LogState = { state: "loading" } | { state: "ready"; log: CheckLog } | { state: "error"; message: string };

export interface CreatePrOutcome {
  ok: boolean;
  /** pr-exists, no-commits, no-branch, or the api's message. */
  error?: string;
  url?: string;
}

export interface SessionGit {
  status: GithubSessionStatus | null;
  changes: SessionChanges | null;
  changesError: string | null;
  /** Re-read both; `fresh` asks the api to skip its github-status cache (after a write). */
  refresh: (fresh?: boolean) => void;
  busy: GitBusy;
  notice: GitNotice | null;
  clearNotice: () => void;
  syncConflict: boolean;
  mergedPr: { number: number; title: string } | null;
  logs: Record<string, LogState>;
  loadLog: (checkId: string) => void;
  createPr: (input: { title: string; body?: string; draft?: boolean }) => Promise<CreatePrOutcome>;
  merge: () => Promise<void>;
  sync: () => Promise<void>;
  rerun: () => Promise<void>;
  fixCi: () => Promise<void>;
  resolveConflict: () => Promise<void>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * #502: one view of the floppy's branch, pull request and checks for the whole page (the header
 * chips, the Changes tab, the phone strip), so github-status and /changes are each read once. Also
 * the actions on them. Anything that talks to the agent goes through `send`, the page's own send
 * path, so it shows in the transcript and queues behind a running turn.
 */
export function useSessionGit({
  sessionId,
  repo,
  lastPush,
  runState,
  send,
}: {
  sessionId: string;
  repo: string | null | undefined;
  lastPush: LastPush | null | undefined;
  runState: string | undefined;
  /** The page's send. Resolves true once the api accepted the message. */
  send: (text: string) => Promise<boolean>;
}): SessionGit {
  const [status, setStatus] = useState<GithubSessionStatus | null>(null);
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [busy, setBusy] = useState<GitBusy>(null);
  const [notice, setNotice] = useState<GitNotice | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  const [mergedPr, setMergedPr] = useState<{ number: number; title: string } | null>(null);
  const [logs, setLogs] = useState<Record<string, LogState>>({});
  // A response for an earlier floppy (the page stays mounted across them) is dropped.
  const current = useRef(sessionId);
  current.current = sessionId;
  const lastChangesAt = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  const changesRef = useRef(changes);
  changesRef.current = changes;
  // One write at a time: a ref, so a double click in the same tick can't start a second.
  const busyRef = useRef<GitBusy>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const runStateRef = useRef(runState);
  runStateRef.current = runState;

  const loadStatus = useCallback(
    (fresh = false) => {
      if (!repo) return;
      const id = sessionId;
      api
        .githubStatus(id, fresh)
        .then((s) => current.current === id && setStatus(s))
        .catch(() => {});
    },
    [sessionId, repo],
  );

  const loadChanges = useCallback(
    (force = false) => {
      if (!repo) return;
      const now = Date.now();
      if (!force && now - lastChangesAt.current < CHANGES_MIN_MS) return;
      lastChangesAt.current = now;
      const id = sessionId;
      api
        .changes(id)
        .then((c) => {
          if (current.current !== id) return;
          setChanges(c);
          setChangesError(null);
        })
        .catch((err) => current.current === id && setChangesError(errorText(err)));
    },
    [sessionId, repo],
  );

  // A new floppy starts clean.
  useEffect(() => {
    setStatus(null);
    setChanges(null);
    setChangesError(null);
    setNotice(null);
    setSyncConflict(false);
    setMergedPr(null);
    setLogs({});
    setBusy(null);
    busyRef.current = null;
    lastChangesAt.current = 0;
  }, [sessionId]);

  // Poll both while the tab is visible; catch up when it's looked at again.
  useEffect(() => {
    if (!repo) return;
    loadStatus();
    loadChanges(true);
    const statusTimer = setInterval(() => document.visibilityState !== "hidden" && loadStatus(), GIT_STATUS_POLL_MS);
    const changesTimer = setInterval(() => document.visibilityState !== "hidden" && loadChanges(), CHANGES_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      loadStatus();
      loadChanges();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(statusTimer);
      clearInterval(changesTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [repo, loadStatus, loadChanges]);

  // A checkpoint that reached GitHub changes both the diff and (soon) the checks. Only a new push
  // on the same floppy: a switch to another floppy, or its first known push arriving, is not one.
  const pushedSha = lastPush?.sha;
  const lastSeenPush = useRef<{ sessionId: string; sha?: string }>({ sessionId, sha: pushedSha });
  useEffect(() => {
    const seen = lastSeenPush.current;
    lastSeenPush.current = { sessionId, sha: pushedSha };
    if (seen.sessionId !== sessionId || !seen.sha || !pushedSha || seen.sha === pushedSha) return;
    loadChanges(true);
    loadStatus(true);
  }, [sessionId, pushedSha, loadChanges, loadStatus]);

  // A turn that ends usually leaves new work in the tree.
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = runState === "running";
    if (wasRunning.current && !running) loadChanges(true);
    wasRunning.current = running;
  }, [runState, loadChanges]);

  const refresh = useCallback(
    (fresh = false) => {
      loadStatus(fresh);
      loadChanges(true);
    },
    [loadStatus, loadChanges],
  );

  /** Claims the one write slot for `kind`, or says no (another write is going). */
  function claim(kind: Exclude<GitBusy, null>): boolean {
    if (busyRef.current !== null) return false;
    busyRef.current = kind;
    setBusy(kind);
    setNotice(null);
    return true;
  }

  /** Frees the slot `kind` held (only that one), and re-reads everything for the floppy it ran on. */
  function release(kind: Exclude<GitBusy, null>, id: string) {
    if (current.current !== id) return;
    if (busyRef.current === kind) {
      busyRef.current = null;
      setBusy(null);
    }
    refresh(true);
  }

  /** Runs one write. The page's send and the floppy are captured before the first await, so a
   * result that comes back after the person moved to another floppy never acts on that one. */
  async function act<T>(kind: Exclude<GitBusy, null>, run: (ctx: { id: string; send: (text: string) => Promise<boolean>; still: () => boolean }) => Promise<T>): Promise<T | undefined> {
    if (!claim(kind)) return undefined;
    const id = sessionId;
    const send = sendRef.current;
    const still = () => current.current === id;
    try {
      return await run({ id, send, still });
    } catch (err) {
      if (still()) setNotice({ tone: "error", text: errorText(err) });
      return undefined;
    } finally {
      release(kind, id);
    }
  }

  const loadLog = useCallback(
    (checkId: string) => {
      setLogs((cur) => (cur[checkId] ? cur : { ...cur, [checkId]: { state: "loading" } }));
      const id = sessionId;
      api
        .sessionCheckLog(id, checkId)
        .then((log) => current.current === id && setLogs((cur) => ({ ...cur, [checkId]: { state: "ready", log } })))
        .catch((err) => current.current === id && setLogs((cur) => ({ ...cur, [checkId]: { state: "error", message: errorText(err) } })));
    },
    [sessionId],
  );

  async function createPr(input: { title: string; body?: string; draft?: boolean }): Promise<CreatePrOutcome> {
    if (!claim("create-pr")) return { ok: false, error: "Another GitHub action is still running." };
    const id = sessionId;
    try {
      const made = await api.createSessionPr(id, input);
      if (current.current === id) setNotice({ tone: "ok", text: `Opened pull request${made.number ? ` #${made.number}` : ""}${made.draft ? " as a draft" : ""}.` });
      return { ok: true, url: made.url };
    } catch (err) {
      if (err instanceof ApiError) {
        const url = typeof err.body?.url === "string" ? err.body.url : undefined;
        if (err.code === "pr-exists") return { ok: false, error: "This branch already has a pull request.", url };
        if (err.code === "no-commits") return { ok: false, error: "Nothing to open a pull request with: the branch has no commits beyond its base." };
        if (err.code === "no-branch") return { ok: false, error: "The branch isn't on GitHub yet: the agent hasn't pushed it." };
      }
      return { ok: false, error: errorText(err) };
    } finally {
      release("create-pr", id);
    }
  }

  async function merge() {
    const pr = statusRef.current?.pr;
    if (!pr?.headSha) return;
    const sha = pr.headSha;
    await act("merge", async ({ id, still }) => {
      try {
        const merged = await api.mergeSessionPr(id, { sha, method: "squash" });
        if (!still()) return;
        setMergedPr({ number: merged.number, title: pr.title });
        setNotice({ tone: "ok", text: `Merged #${merged.number} into ${pr.base ?? "the base branch"}.` });
      } catch (err) {
        if (err instanceof ApiError && err.code === "head-moved") {
          if (still()) setNotice({ tone: "warn", text: "The branch moved since you looked, so nothing was merged. Check the new head and merge again." });
          return;
        }
        throw err;
      }
    });
  }

  async function sync() {
    await act("sync", async ({ id, send, still }) => {
      const result = await api.syncSession(id);
      if (!still()) return;
      if (result.status === "conflict") {
        setSyncConflict(true);
        setNotice({ tone: "warn", text: `Merging ${result.base} into the branch conflicts. Resolve it with the agent.` });
        return;
      }
      setSyncConflict(false);
      if (result.status === "up-to-date") {
        setNotice({ tone: "ok", text: `Already up to date with ${result.base}.` });
        return;
      }
      if (result.branchMoved && result.agentNote) {
        // A live Drive's checkout is now behind GitHub's branch: tell the agent, or say so.
        const live = runStateRef.current !== undefined && ["running", "idle", "queued", "provisioning"].includes(runStateRef.current);
        if (live && (await send(result.agentNote))) {
          if (still()) setNotice({ tone: "ok", text: `Synced with ${result.base}, and told the agent to pull.` });
        } else if (still()) {
          setNotice({ tone: "warn", text: `Synced with ${result.base}. ${result.agentNote}` });
        }
        return;
      }
      setNotice({ tone: "ok", text: `Synced with ${result.base}.` });
    });
  }

  async function rerun() {
    await act("rerun", async ({ id, still }) => {
      const result = await api.rerunSessionChecks(id);
      if (!still()) return;
      setNotice(
        result.status === "rerun"
          ? { tone: "ok", text: `Re-running ${result.rerun.map((r) => r.name).join(", ") || "the failed checks"}.` }
          : { tone: "warn", text: "Nothing to re-run: no failed workflow runs on the head." },
      );
    });
  }

  async function fixCi() {
    const pr = statusRef.current?.pr;
    if (!pr) return;
    const failing = pr.checks.find((c) => c.state === "fail") ?? null;
    const known = failing ? logs[failing.id] : undefined;
    await act("fix-ci", async ({ id, send, still }) => {
      let tail = "";
      if (failing?.hasLog) {
        if (known?.state === "ready") tail = known.log.log;
        else
          tail = await api
            .sessionCheckLog(id, failing.id)
            .then((l) => l.log)
            .catch(() => "");
      }
      if (!still()) return;
      await send(fixCiMessage(pr, failing, tail));
    });
  }

  async function resolveConflict() {
    const c = changesRef.current;
    const s = statusRef.current;
    const base = c?.base ?? s?.baseBranch ?? "the base branch";
    const text = conflictMessage(conflictedFiles(c).map((f) => f.path), base, c?.branch ?? s?.branch ?? null);
    await act("resolve", async ({ send, still }) => {
      if ((await send(text)) && still()) setSyncConflict(false);
    });
  }

  return {
    status,
    changes,
    changesError,
    refresh,
    busy,
    notice,
    clearNotice: () => setNotice(null),
    syncConflict,
    mergedPr,
    logs,
    loadLog,
    createPr,
    merge,
    sync,
    rerun,
    fixCi,
    resolveConflict,
  };
}
