/**
 * Snapshot restore: write the run.spec snapshot JSONL to a temp file, then import it into the agent
 * dir's session store for /workspace under the same session id, using
 * `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir, { id })` from
 * `@earendil-works/pi-coding-agent` -- the same pattern kernal's own teleport extension uses
 * (kernal/.pi/extensions/teleport/cli.ts). That package is only present at runtime inside the sandbox
 * image (/opt/kernal/node_modules), not a dependency of agentd itself, so it is loaded with a dynamic
 * `import()` at call time; unit tests inject a stub via `ForkFromFn`.
 */
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SessionManagerLike {
  getSessionFile(): string | undefined;
}

/** Matches `SessionManager.forkFrom`'s signature closely enough to swap in a test stub. */
export type ForkFromFn = (
  sourcePath: string,
  targetCwd: string,
  sessionDir: string | undefined,
  options?: { id?: string },
) => SessionManagerLike;

export interface ImportSessionOptions {
  /** Injected for tests; defaults to a dynamic import of the real pi-coding-agent package. */
  forkFrom?: ForkFromFn;
  /** Session storage directory override (defaults to pi's own default for `targetCwd`). */
  sessionDir?: string;
}

let cachedForkFrom: ForkFromFn | undefined;

// Not a dependency of agentd itself (only present at runtime inside the sandbox image, see
// image/Dockerfile); built from a non-literal specifier so tsc does not try to resolve it.
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

async function loadForkFrom(): Promise<ForkFromFn> {
  if (cachedForkFrom) return cachedForkFrom;
  const mod: any = await import(PI_CODING_AGENT_PACKAGE);
  const SessionManager = mod.SessionManager ?? mod.default?.SessionManager;
  if (!SessionManager?.forkFrom) {
    throw new Error("session: @earendil-works/pi-coding-agent does not export SessionManager.forkFrom");
  }
  cachedForkFrom = SessionManager.forkFrom.bind(SessionManager);
  return cachedForkFrom!;
}

/** Writes `jsonl` to a fresh temp file and returns its path. */
export async function writeSnapshotFile(jsonl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-snapshot-"));
  const path = join(dir, "snapshot.jsonl");
  await writeFile(path, jsonl, "utf8");
  return path;
}

/** A session file containing only a header, for the "no snapshot" case (brand-new session). Fed
 * through the same `forkFrom` import path as a real snapshot -- forkFrom copies zero non-header
 * entries -- so agentd always ends up with a session file located by pi's normal session-dir rules,
 * under the run's session id, whether or not there was anything to restore. */
export function emptySessionJsonl(sessionId: string, cwd: string): string {
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  };
  return `${JSON.stringify(header)}\n`;
}

/** Bug 8 (docs/reports/cloud-fixes.md): "duplicate model_change/thinking_level_change entries on
 * each restore". Cause: agentd's own entry ingestion is already idempotent by entry id (the API's
 * unique `{sessionId, "entry.id"}` index, `insertIfNew` -- see store/mongo.ts/memory.ts), so a
 * resent copy of a *previously seen* entry is already a no-op. The duplicates are not resends of
 * the same entry id at all: every restore is a brand-new `pi --mode rpc` process, and run.ts always
 * passed `--model`/the `:thinking` suffix unconditionally (guru.ts's renderGuru); pi treats an
 * explicit `--model`/`--thinking` CLI flag as the user setting that value for this process and logs
 * a fresh model_change/thinking_level_change entry (with a fresh id) even when it exactly matches
 * what the restored session already ended with. So each restore appended a *new*, genuinely
 * distinct-id entry restating the same model/thinking level -- no amount of "idempotent by id"
 * ingestion can catch that, since the ids really do differ.
 *
 * Fix: before spawning pi, read the restored snapshot's own last model_change/thinking_level_change
 * entries (this function) and skip passing `--model`/the thinking suffix when they already agree
 * with the guru's resolved model/thinking (run.ts's begin()) -- pi then has no reason to assert
 * them again, and a real change (laptop-preflight fallback, an edited Tape, a fresh session with no
 * prior entries at all) still passes `--model` exactly as before. */
export interface LastKnownModelState {
  /** `provider/modelId`, from the last model_change entry, if any. */
  model?: string;
  /** From the last thinking_level_change entry, if any. */
  thinking?: string;
}

/** Pure: scans a session JSONL snapshot's entries in file order and returns the last-seen model and
 * thinking level, independently (a session may have changed one without the other). Malformed lines
 * are skipped, not thrown -- this is a best-effort optimization, never load-bearing for correctness. */
export function lastKnownModelState(jsonl: string): LastKnownModelState {
  const result: LastKnownModelState = {};
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === "model_change") {
      const provider = parsed.provider;
      const modelId = parsed.modelId;
      if (typeof provider === "string" && typeof modelId === "string") result.model = `${provider}/${modelId}`;
    } else if (parsed.type === "thinking_level_change") {
      const level = parsed.thinkingLevel;
      if (typeof level === "string") result.thinking = level;
    }
  }
  return result;
}

/** Imports the snapshot at `snapshotFile` into the session store for `cwd`, forcing the same
 * `sessionId` so the run continues the same conversation. Returns the resulting session file path
 * that `pi --session <path>` should be pointed at. */
export async function importSession(
  snapshotFile: string,
  cwd: string,
  sessionId: string,
  opts: ImportSessionOptions = {},
): Promise<string> {
  const forkFrom = opts.forkFrom ?? (await loadForkFrom());
  const manager = forkFrom(snapshotFile, cwd, opts.sessionDir, { id: sessionId });
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("session: forkFrom returned a manager with no session file");
  return sessionFile;
}
