/**
 * Pure(ish) logic for the teleport extension: the pluggable transcript Store interface, a git-backed
 * implementation of it, and small string/data helpers (owner/repo parsing, header rewriting, model
 * remap, formatting). Git and filesystem access in GitStore is real IO, but every external command
 * goes through an injected `exec` function so tests can stub it against a temp directory — no network,
 * no real git binary required to exercise the logic. Everything here is unit-tested in
 * ../../../tests/teleport.test.ts without pi.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../_shared/env.ts";

// ---------- Store ----------

/** One entry in a store's index: enough to show and pick a session without fetching it. */
export type SessionRef = {
  id: string;
  name?: string;
  cwd: string;
  repo?: string;    // "owner/repo", when the session came from a git checkout
  branch?: string;
  updatedAt: string; // ISO timestamp
  host: string;
};

/** Sidecar metadata written next to a pushed session's jsonl. */
export type Manifest = {
  id: string;
  name?: string;
  host: string;
  cwd: string;
  repo?: { remote: string; ownerRepo: string; branch: string; head: string };
  pushedAt: string; // ISO timestamp
};

/** Pluggable transcript store. GitStore below is the phase-1/2 implementation; OutfitterStore
 * (../outfitter-store.ts) implements the same interface against the Outfitter cloud API instead. */
export interface Store {
  list(): Promise<SessionRef[]>;
  /** opts.force: skip any "stop the active run first" wait a store implementation may do (only
   * meaningful for OutfitterStore -- GitStore has no notion of an active run and ignores it). */
  get(id: string, opts?: { force?: boolean }): Promise<{ file: string; manifest: Manifest }>;
  put(id: string, jsonl: string, manifest: Manifest): Promise<void>;
}

// ---------- GitStore ----------

export type ExecResult = { stdout: string; stderr: string; code: number };
/** Matches pi.exec's shape closely enough to wrap directly: (cmd, args, cwd) => result. */
export type ExecFn = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;
export type Warn = (message: string) => void;

const execFileAsync = promisify(execFile);

/** Default exec: shells out for real via node:child_process. Only used outside of tests. */
async function defaultExec(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return { stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err?.message ?? err), code: typeof err?.code === "number" ? err.code : 1 };
  }
}

/** ~/.kernal-sessions, unless only the pre-rename ~/.mgm-sessions exists: that clone may carry a
 * remote and history, and silently starting a fresh, unsynced store beside it would hide both. */
export function defaultStoreDir(home: string = homedir()): string {
  const current = join(home, ".kernal-sessions");
  const legacy = join(home, ".mgm-sessions");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export type GitStoreOptions = {
  /** Clone directory. Defaults to KERNAL_TELEPORT_STORE, then ~/.kernal-sessions (or an existing
   * pre-rename ~/.mgm-sessions; see defaultStoreDir). */
  dir?: string;
  /** This machine's identifier, stamped on manifests. Defaults to os.hostname(). */
  host?: string;
  /** Injected shell-out, so tests can stub git. Defaults to a real child_process call. */
  exec?: ExecFn;
  /** Called with a human-readable warning on non-fatal problems (e.g. offline). Defaults to a no-op. */
  warn?: Warn;
};

/** A local clone directory (optionally with a `git remote`) used as the transcript store: files
 * sessions/<id>.jsonl, sessions/<id>.json (manifest) and index.json (array of SessionRef). */
export class GitStore implements Store {
  private dir: string;
  private host: string;
  private exec: ExecFn;
  private warn: Warn;
  private repoReady = false;

  constructor(opts: GitStoreOptions = {}) {
    this.dir = opts.dir ?? env("TELEPORT_STORE") ?? defaultStoreDir();
    this.host = opts.host ?? hostname();
    this.exec = opts.exec ?? defaultExec;
    this.warn = opts.warn ?? (() => {});
  }

  getDir(): string {
    return this.dir;
  }

  private async ensureRepo(): Promise<void> {
    if (this.repoReady) return;
    await mkdir(join(this.dir, "sessions"), { recursive: true });
    if (!existsSync(join(this.dir, ".git"))) {
      const init = await this.exec("git", ["init"], this.dir);
      if (init.code !== 0) throw new Error(`teleport: git init failed in ${this.dir}: ${init.stderr.trim()}`);
    }
    // No eager index.json here: readIndex() already tolerates a missing file (fresh/empty store),
    // and creating a placeholder ahead of syncFromRemote() would leave an untracked index.json that
    // blocks `git pull --ff-only` the first time a clone catches up with a remote that already has one.
    this.repoReady = true;
  }

  private async hasRemote(): Promise<boolean> {
    const r = await this.exec("git", ["remote"], this.dir);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /** git pull --ff-only when a remote is configured; tolerate offline/no-remote by falling back to local. */
  private async syncFromRemote(): Promise<void> {
    await this.ensureRepo();
    if (!(await this.hasRemote())) return;
    const r = await this.exec("git", ["pull", "--ff-only"], this.dir);
    if (r.code !== 0) this.warn(`teleport: could not reach the session store remote (offline?); using local copy. ${r.stderr.trim()}`);
  }

  /** Same idea as syncFromRemote(), but called right before put() writes/commits: a ff-only pull
   * that falls back to a rebase when another machine pushed in between (so this clone was behind
   * and would otherwise diverge). Both failure paths are tolerated here — offline stays local-only,
   * put() itself is what enforces that the *push* side of that eventually surfaces as an error. */
  private async syncBeforePut(): Promise<void> {
    if (!(await this.hasRemote())) return;
    const ff = await this.exec("git", ["pull", "--ff-only"], this.dir);
    if (ff.code !== 0) {
      const rebase = await this.exec("git", ["pull", "--rebase"], this.dir);
      if (rebase.code !== 0) {
        this.warn(`teleport: could not sync the session store before pushing (offline?); continuing with the local copy. ${rebase.stderr.trim()}`);
      }
    }
  }

  private async readIndex(): Promise<SessionRef[]> {
    try {
      return JSON.parse(await readFile(join(this.dir, "index.json"), "utf8"));
    } catch {
      return [];
    }
  }

  async list(): Promise<SessionRef[]> {
    await this.syncFromRemote();
    const refs = await this.readIndex();
    return [...refs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async get(id: string): Promise<{ file: string; manifest: Manifest }> {
    await this.syncFromRemote();
    const [file, manifestText] = await Promise.all([
      readFile(join(this.dir, "sessions", `${id}.jsonl`), "utf8"),
      readFile(join(this.dir, "sessions", `${id}.json`), "utf8"),
    ]);
    return { file, manifest: JSON.parse(manifestText) };
  }

  async put(id: string, jsonl: string, manifest: Manifest): Promise<void> {
    await this.ensureRepo();
    // Sync first: a remote may have moved since this clone last synced (another machine pushed a
    // session in between). Without this, the writes below build on a stale index and the commit
    // below diverges from the remote, so every push from here on fails as non-fast-forward.
    await this.syncBeforePut();
    await writeFile(join(this.dir, "sessions", `${id}.jsonl`), jsonl, "utf8");
    await writeFile(join(this.dir, "sessions", `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    // Re-read after syncing (not before): the pull above may have brought in a newer index.json,
    // and index.json is regenerated from the merged state, not carried over from before the sync.
    const refs = await this.readIndex();
    const ref: SessionRef = {
      id: manifest.id, name: manifest.name, cwd: manifest.cwd,
      repo: manifest.repo?.ownerRepo, branch: manifest.repo?.branch,
      updatedAt: manifest.pushedAt, host: manifest.host,
    };
    const nextIndex = [ref, ...refs.filter((r) => r.id !== id)];
    await writeFile(join(this.dir, "index.json"), `${JSON.stringify(nextIndex, null, 2)}\n`, "utf8");

    const add = await this.exec("git", ["add", "sessions", "index.json"], this.dir);
    if (add.code !== 0) throw new Error(`teleport: git add failed: ${add.stderr.trim()}`);
    const commit = await this.exec("git", ["commit", "-m", `teleport: push ${id}`], this.dir);
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw new Error(`teleport: git commit failed: ${commit.stderr.trim()}`);
    }
    if (await this.hasRemote()) {
      let push = await this.exec("git", ["push"], this.dir);
      if (push.code !== 0) {
        // Most likely rejected as non-fast-forward (someone else pushed after our syncBeforePut()
        // above); rebase onto the new remote tip and retry exactly once.
        const rebase = await this.exec("git", ["pull", "--rebase"], this.dir);
        if (rebase.code === 0) push = await this.exec("git", ["push"], this.dir);
      }
      if (push.code !== 0) {
        // Commit already happened locally, but it's not visible elsewhere until a push succeeds -
        // that must not be reported as a successful teleport, so throw rather than warn.
        throw new Error(`teleport: pushed locally only, will not be visible elsewhere until the next successful push: ${push.stderr.trim()}`);
      }
    }
  }
}

// ---------- git helpers (pure) ----------

/** Extracts "owner/repo" from an https, ssh:// or scp-like (git@host:owner/repo) git remote URL. */
export function parseOwnerRepo(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  const urlLike = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+?)(?:\.git)?\/?$/i);
  if (urlLike) return urlLike[1];
  const scpLike = trimmed.match(/^[^@/\s]+@[^:\s]+:(.+?)(?:\.git)?\/?$/);
  if (scpLike) return scpLike[1];
  return undefined;
}

/** True when `git status --porcelain` produced any output. */
export const isWorkingTreeDirty = (porcelain: string): boolean => porcelain.trim().length > 0;

/** From `git status --porcelain=v2 --branch` output: true if the branch has no upstream, or is ahead of it. */
export function needsPush(branchStatus: string): boolean {
  if (!/^# branch\.upstream /m.test(branchStatus)) return true;
  const ab = branchStatus.match(/^# branch\.ab \+(\d+) -(\d+)/m);
  return ab ? Number(ab[1]) > 0 : false;
}

/** Checks that the manifest's origin repo matches the current checkout's, Claude-Code-teleport style. */
export function verifyOwnerRepo(localOwnerRepo: string | undefined, expectedOwnerRepo: string): string | undefined {
  if (localOwnerRepo === expectedOwnerRepo) return undefined;
  return `This session was pushed from ${expectedOwnerRepo}, but the current directory is ${localOwnerRepo ? `a checkout of ${localOwnerRepo}` : "not a checkout of a matching git remote"}. cd into a checkout of ${expectedOwnerRepo} on the right branch first.`;
}

/** Finds the local session file for an id among filenames like "<timestamp>_<id>.jsonl". */
export function findSessionFileForId(files: string[], id: string): string | undefined {
  return files.find((f) => f.endsWith(`_${id}.jsonl`));
}

// ---------- session header / manifest ----------

/** Replaces the first line's (session header) `cwd`, keeping every other line byte-identical.
 * Fallback path only: the primary import path is SessionManager.forkFrom with the same id. */
export function rewriteHeaderCwd(jsonl: string, newCwd: string): string {
  const nl = jsonl.indexOf("\n");
  const firstLine = nl === -1 ? jsonl : jsonl.slice(0, nl);
  const rest = nl === -1 ? "" : jsonl.slice(nl);
  const header = JSON.parse(firstLine);
  header.cwd = newCwd;
  return JSON.stringify(header) + rest;
}

export type GitInfo = { remote: string; branch: string; head: string };

/** Builds a push manifest from git info (all three fields present) or without a repo section. */
export function manifestFromGit(params: { id: string; name?: string; host: string; cwd: string; git?: GitInfo; pushedAt?: string }): Manifest {
  const manifest: Manifest = {
    id: params.id, name: params.name, host: params.host, cwd: params.cwd,
    pushedAt: params.pushedAt ?? new Date().toISOString(),
  };
  if (params.git) {
    const ownerRepo = parseOwnerRepo(params.git.remote);
    if (ownerRepo) manifest.repo = { remote: params.git.remote, ownerRepo, branch: params.git.branch, head: params.git.head };
  }
  return manifest;
}

// ---------- model remap ----------

export type ModelPick = { provider: string; modelId: string };
export const FALLBACK_MODEL: ModelPick = { provider: "litellm", modelId: "local-qwen-mlx" };

/** The last model_change entry in the (already-active-path) entries, if its provider is available on
 * this host; otherwise the local MLX fallback. */
export function pickModelForHost(entries: any[], availableProviders: string[]): ModelPick {
  let last: ModelPick | undefined;
  for (const e of entries) {
    if (e?.type === "model_change") last = { provider: e.provider, modelId: e.modelId };
  }
  if (last && availableProviders.includes(last.provider)) return last;
  return { ...FALLBACK_MODEL };
}

// ---------- formatting ----------

function describeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One-line description of a SessionRef for the interactive picker. */
export function describeRef(ref: SessionRef): string {
  const label = ref.name || ref.id.slice(0, 8);
  const where = ref.repo ? `${ref.repo}${ref.branch ? `@${ref.branch}` : ""}` : ref.cwd;
  return `${label}  —  ${where}  ·  ${ref.host}  ·  ${describeAge(ref.updatedAt)}`;
}
