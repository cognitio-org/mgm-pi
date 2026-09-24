/**
 * Resolves the run assignment (RUN_ID, RUN_TOKEN, OUTFITTER_API) agentd needs before it can connect
 * to the link (docs/protocol.md "agentd <-> api"; docs/specs/gke-sandbox-provider.md §3.5).
 *
 * Two sources, in order:
 *  - **Env** (Cloud Run, docker, inprocess, GKE cold claims): `RUN_ID`/`RUN_TOKEN`/`OUTFITTER_API`
 *    are already set when the process starts, exactly as before this module existed.
 *  - **Downward-API files** (GKE warm pods, spec §3.5 Option B): a warm pod boots with no run
 *    assignment at all -- `RUN_ID` is absent from env -- and picks one up only once a
 *    `SandboxClaim`'s `additionalPodMetadata.annotations` patches the running pod's metadata, which
 *    the kubelet mirrors into files under `OUTFITTER_ASSIGNMENT_DIR` (default
 *    `/etc/outfitter/assignment/{run-id,run-token,api}`, root-only 0400 -- see
 *    `deploy/gke/sandbox-template.yaml`). An unset annotation still creates the file, just empty, so
 *    this polls (spike S1: gVisor's view of the kubelet's atomic symlink swap is not reliably visible
 *    to inotify) until `run-id`, `run-token` and (`api` or env `OUTFITTER_API`) are all non-empty --
 *    all three, not just the first two, so a read that lands between two downward-API refreshes
 *    keeps polling instead of raising a false "missing OUTFITTER_API".
 *
 * #45 token isolation: the resolved values are returned to the caller and held in memory only. This
 * module never writes to `process.env` except to `delete` the sensitive vars off the env object it
 * was given, on the env path, right after reading them -- see `resolveAssignment`'s doc. Never logs
 * a token; callers must register it with `logger.addSecret` before logging anything else.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

export interface Assignment {
  runId: string;
  runToken: string;
  apiOrigin: string;
  /** 0 on the env path. On the file path, how long resolveAssignment actually waited for the
   * downward-API files to become non-empty. */
  waitedMs: number;
}

export interface ResolveAssignmentOptions {
  /** Poll interval while waiting for the downward-API files, ms. Default 100. */
  pollMs?: number;
  /** Optional deadline (ms since the wait started). Exceeding it throws instead of continuing to
   * wait. Default: none -- a warm pod that is never claimed waits idle, indefinitely, without
   * dialling out (spec §3.5, plan PR4 acceptance). Tests use this to bound a "never resolves" case. */
  deadlineMs?: number;
  /** Injectable file reader, for tests. Defaults to `fs.readFile(path, "utf8")`; a missing file
   * (ENOENT) reads as `""`, same as an existing-but-empty one. */
  readFile?: (path: string) => Promise<string>;
  /** Injectable clock, for tests. Default `Date.now`. */
  now?: () => number;
  /** Injectable sleep, for tests. Default a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`agentd: missing required env var ${name}`);
  return value;
}

async function defaultReadFile(path: string): Promise<string> {
  try {
    return await fsReadFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads and trims `run-id`/`run-token`/`api` under `dir`. Empty string for a file that doesn't
 * exist yet or whose annotation is unset (see the module doc). */
async function readAssignmentFiles(
  dir: string,
  readFile: (path: string) => Promise<string>,
): Promise<{ runId: string; runToken: string; api: string }> {
  const [runId, runToken, api] = await Promise.all([
    readFile(join(dir, "run-id")),
    readFile(join(dir, "run-token")),
    readFile(join(dir, "api")),
  ]);
  return { runId: runId.trim(), runToken: runToken.trim(), api: api.trim() };
}

/** Env first (Cloud Run, docker, inprocess, GKE cold) -- unchanged from before this module existed.
 * Otherwise, if `OUTFITTER_ASSIGNMENT_DIR` is set, waits for the downward-API files a warm
 * `SandboxClaim`'s annotations produce (GKE warm). Otherwise throws the same "missing required env
 * var" error agentd has always thrown when it isn't given a run to drive. */
export async function resolveAssignment(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveAssignmentOptions = {},
): Promise<Assignment> {
  const dir = env.OUTFITTER_ASSIGNMENT_DIR;
  // Only the "no RUN_ID yet, but a warm pod's assignment dir exists" case waits on files. Every
  // other case -- including "neither RUN_ID nor the dir is set" -- falls through to the env
  // checks below, unchanged from before this module existed (same order, same error text).
  if (!env.RUN_ID && dir) {
    const readFile = opts.readFile ?? defaultReadFile;
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? defaultSleep;
    const pollMs = opts.pollMs ?? 100;
    const start = now();

    for (;;) {
      const files = await readAssignmentFiles(dir, readFile);
      const apiOrigin = files.api || env.OUTFITTER_API;
      // All three: the kubelet's downward-API refresh swaps the whole projected volume's `..data`
      // symlink in one atomic step (spec §3.5), and gke.ts sets all three annotations in a single
      // additionalPodMetadata.annotations patch -- so run-id/run-token/api become visible together.
      // Waiting on all three, not just run-id/run-token, means a read that lands squarely between
      // two refreshes just keeps polling instead of racing `apiOrigin` into a false "missing" error.
      if (files.runId && files.runToken && apiOrigin) {
        return { runId: files.runId, runToken: files.runToken, apiOrigin, waitedMs: now() - start };
      }
      if (opts.deadlineMs !== undefined && now() - start >= opts.deadlineMs) {
        throw new Error(`agentd: timed out after ${opts.deadlineMs}ms waiting for the run assignment under ${dir}`);
      }
      await sleep(pollMs);
    }
  }

  const apiOrigin = requireEnv(env, "OUTFITTER_API");
  const runId = requireEnv(env, "RUN_ID");
  const runToken = requireEnv(env, "RUN_TOKEN");
  // Read exactly once, here, and returned to the caller to hold in memory: drop it from env
  // immediately so nothing agentd spawns can inherit it by accident (see the module doc and
  // main.ts's own doc comment on the same line, before this module existed).
  delete env.RUN_TOKEN;
  return { runId, runToken, apiOrigin, waitedMs: 0 };
}
