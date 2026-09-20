/**
 * Repo-less run support (protocol.md: `run.spec.repo` is optional for non-coding sessions).
 * Without git there is no commit/push/diff, so agentd tracks file mtimes itself for "what changed
 * since the last checkpoint" and tars the workspace on checkpoint instead of pushing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const execFileAsync = promisify(execFile);

export type FileMtimes = Map<string, number>;

/** Recursively lists every regular file under `cwd` (skipping `.git`, present or not) with its
 * mtime in ms, for diffing "what changed since the last checkpoint" without git. */
export async function snapshotWorkspaceFiles(cwd: string): Promise<FileMtimes> {
  const result: FileMtimes = new Map();

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir removed mid-walk, or doesn't exist yet -- treat as empty
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        const st = await stat(abs);
        result.set(relPath, st.mtimeMs);
      }
    }
  }

  await walk(cwd, "");
  return result;
}

/** Paths added, modified, or removed between two snapshots, sorted. */
export function diffWorkspaceFiles(before: FileMtimes, after: FileMtimes): string[] {
  const changed = new Set<string>();
  for (const [path, mtime] of after) {
    if (before.get(path) !== mtime) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

export interface RestoreWorkspaceOptions {
  fetchFn?: typeof fetch;
}

/** Restores a workspace from a tarball at a local file path, a `file://` URL, or an http(s) URL
 * (`run.spec.workspace.snapshotUrl`). `cwd` must already exist. GCS support comes later. */
export async function restoreWorkspace(
  snapshotUrl: string,
  cwd: string,
  opts: RestoreWorkspaceOptions = {},
): Promise<void> {
  let tarPath: string;
  let cleanup: (() => Promise<void>) | undefined;

  if (snapshotUrl.startsWith("http://") || snapshotUrl.startsWith("https://")) {
    const fetchFn = opts.fetchFn ?? fetch;
    const res = await fetchFn(snapshotUrl);
    if (!res.ok || !res.body) {
      throw new Error(`restoreWorkspace: fetch ${snapshotUrl} failed: ${res.status}`);
    }
    const dest = join(cwd, `.outfitter-snapshot-${Date.now()}.tar.gz`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
    tarPath = dest;
    cleanup = () => rm(dest, { force: true });
  } else {
    tarPath = snapshotUrl.startsWith("file://") ? new URL(snapshotUrl).pathname : snapshotUrl;
  }

  await execFileAsync("tar", ["-xzf", tarPath, "-C", cwd]);
  if (cleanup) await cleanup();
}

/** Tars `cwd` into `<snapshotDir>/<sessionId>-<timestamp>.tar.gz` and returns its path. Returns
 * `undefined` (after logging why) when `snapshotDir` is unset -- the GCS upload step lands later,
 * per protocol.md's note on `WORKSPACE_SNAPSHOT_DIR`. */
export async function checkpointWorkspaceTarball(
  cwd: string,
  sessionId: string,
  snapshotDir: string | undefined,
  onLog: (line: string) => void,
): Promise<string | undefined> {
  if (!snapshotDir) {
    onLog("checkpoint: WORKSPACE_SNAPSHOT_DIR is not set; skipping workspace tarball for this repo-less run");
    return undefined;
  }
  await mkdir(snapshotDir, { recursive: true });
  const dest = join(snapshotDir, `${sessionId}-${Date.now()}.tar.gz`);
  await execFileAsync("tar", ["-czf", dest, "-C", cwd, "."]);
  return dest;
}
