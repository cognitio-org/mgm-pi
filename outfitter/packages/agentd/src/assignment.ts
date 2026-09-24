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
 *    this polls until `run-id`, `run-token` and (`api` or env `OUTFITTER_API`) are all non-empty --
 *    all three, not just the first two. In production the kubelet's projected-volume refresh swaps
 *    the whole `..data` symlink to a fresh timestamped directory in one atomic rename (verified
 *    with the real layout in `assignment.test.ts`), so run-id/run-token/api become visible together,
 *    not staggered; waiting on all three is a belt-and-suspenders guard against this module's own
 *    three separate `readFile` calls landing squarely on either side of that rename (which the
 *    kubelet's atomicity should prevent, but three independent reads can't fully rule out) -- not a
 *    real production race that's been observed, but cheap insurance against a false "missing
 *    OUTFITTER_API" if it ever happened.
 *
 * `isWarmAssignmentWait` is the one selection rule ("does this process wait on files, or read
 * env") -- `main.ts` calls it too, so the two never disagree about which path a given env implies.
 *
 * #45 token isolation: the resolved values are returned to the caller and held in memory only. This
 * module never writes to `process.env` except to `delete` the sensitive vars off the env object it
 * was given, on the env path, right after reading them -- see `resolveAssignment`'s doc. Never logs
 * a token; callers must register it with `logger.addSecret` before logging anything else. The
 * optional heartbeat (below) reports presence only, by design -- never a value.
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

/** Presence only (never a value) for the periodic heartbeat while waiting on the file path. */
export interface AssignmentPresence {
  runId: boolean;
  runToken: boolean;
  api: boolean;
}

export interface ResolveAssignmentOptions {
  /** Poll interval while waiting for the downward-API files, ms. Default 250. */
  pollMs?: number;
  /** Optional deadline (ms since the wait started). Exceeding it throws instead of continuing to
   * wait. Default: none -- a warm pod that is never claimed waits idle, indefinitely, without
   * dialling out (spec §3.5, plan PR4 acceptance). Tests use this to bound a "never resolves" case. */
  deadlineMs?: number;
  /** How often to report a heartbeat while still waiting, ms. Default 5 minutes. Only relevant with
   * `onHeartbeat` set. */
  heartbeatMs?: number;
  /** Called at most every `heartbeatMs` while still waiting on the file path, with presence only
   * (see `AssignmentPresence`) -- e.g. so a caller can log that it's alive and what it's still
   * missing, without ever logging a value. Never called on the env path (which never waits). */
  onHeartbeat?: (presence: AssignmentPresence) => void;
  /** Injectable file reader, for tests. Defaults to `fs.readFile(path, "utf8")`; a missing file
   * (ENOENT) reads as `""`, same as an existing-but-empty one. */
  readFile?: (path: string) => Promise<string>;
  /** Injectable clock, for tests. Default `Date.now`. */
  now?: () => number;
  /** Injectable sleep, for tests. Default a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;

/** The one rule for which path a given env implies: a GKE warm pod is the only case that waits on
 * files -- `RUN_ID` isn't in env yet, but `OUTFITTER_ASSIGNMENT_DIR` is. Every other combination
 * (including "neither is set") is the env path, which resolves (or fails) immediately. Exported so
 * `main.ts` can decide *when* to call `resolveAssignment` (before or after its own run-independent
 * setup) without duplicating this condition or risking the two disagreeing. */
export function isWarmAssignmentWait(env: NodeJS.ProcessEnv): boolean {
  return !env.RUN_ID && !!env.OUTFITTER_ASSIGNMENT_DIR;
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
 * exist yet (or a directory that doesn't exist yet at all) or whose annotation is unset -- see the
 * module doc. Node follows symlinks transparently, so this reads correctly through the kubelet's
 * real layout (`run-id` etc. are themselves symlinks through a `..data` symlink) with no special
 * handling. */
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
  if (isWarmAssignmentWait(env)) {
    const dir = env.OUTFITTER_ASSIGNMENT_DIR!;
    const readFile = opts.readFile ?? defaultReadFile;
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? defaultSleep;
    const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const start = now();
    let lastHeartbeat = start;

    for (;;) {
      const files = await readAssignmentFiles(dir, readFile);
      const apiOrigin = files.api || env.OUTFITTER_API;
      // All three, not just run-id/run-token -- see the module doc's belt-and-suspenders note.
      if (files.runId && files.runToken && apiOrigin) {
        return { runId: files.runId, runToken: files.runToken, apiOrigin, waitedMs: now() - start };
      }
      const nowMs = now();
      if (opts.onHeartbeat && nowMs - lastHeartbeat >= heartbeatMs) {
        opts.onHeartbeat({ runId: !!files.runId, runToken: !!files.runToken, api: !!apiOrigin });
        lastHeartbeat = nowMs;
      }
      if (opts.deadlineMs !== undefined && nowMs - start >= opts.deadlineMs) {
        throw new Error(`agentd: timed out after ${opts.deadlineMs}ms waiting for the run assignment under ${dir}`);
      }
      await sleep(pollMs);
    }
  }

  const apiOrigin = requireEnv(env, "OUTFITTER_API");
  const runId = requireEnv(env, "RUN_ID");
  const runToken = requireEnv(env, "RUN_TOKEN");
  // Read exactly once, here, and returned to the caller to hold in memory: delete it from whatever
  // `env` object this call was given, so a caller that passes process.env directly (this file's
  // own tests do) can't leak it to a child spawned afterwards. main.ts itself passes a *snapshot*
  // (not the real process.env) and deletes RUN_TOKEN from the real process.env separately, earlier
  // than this call even happens -- see its module doc. Either way, by the time this returns,
  // nothing that still holds a reference to the real process.env has RUN_TOKEN in it.
  delete env.RUN_TOKEN;
  return { runId, runToken, apiOrigin, waitedMs: 0 };
}
