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
