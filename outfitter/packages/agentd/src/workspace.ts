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
import { validateSnapshotUrl, snapshotHostAllowlist, isDevMode } from "./snapshot-url.js";

const execFileAsync = promisify(execFile);

/** Parses a `tar -tvzf` listing line (BSD or GNU format) into just what safeExtractTar needs to
 * reject a dangerous entry: whether it's a symlink/hardlink, and the path itself. Both formats put
 * the path last on the line (after ` -> target` for a symlink); permission bits at the start (`l`
 * for symlink, `h`/second link for hardlink in GNU's case) are what we key off of rather than
 * parsing the whole table precisely -- this only needs to be conservative, not a full parser. */
function parseTarEntry(line: string): { path: string; isLink: boolean } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const isLink = trimmed.startsWith("l") || trimmed.startsWith("h") || / -> /.test(trimmed) || / link to /.test(trimmed);
  const arrowIdx = trimmed.indexOf(" -> ");
  const linkToIdx = trimmed.indexOf(" link to ");
  let pathPart = trimmed;
  if (arrowIdx !== -1) pathPart = trimmed.slice(0, arrowIdx);
  else if (linkToIdx !== -1) pathPart = trimmed.slice(0, linkToIdx);
  // `-tvzf` output is a whitespace-separated table (perms, owner/group, size, date, time, path);
  // the path is everything after the 5th (GNU) or similar run of fields. Splitting on whitespace
  // and taking the last field is wrong when paths contain spaces, so instead find where the
  // timestamp (HH:MM or a 4-digit year) ends and take the rest of the line as the path.
  const timeMatch = pathPart.match(/\s(\d{2}:\d{2}|\d{4})\s/);
  const path = timeMatch ? pathPart.slice(timeMatch.index! + timeMatch[0].length) : undefined;
  if (!path) return undefined;
  return { path: path.trim(), isLink };
}

/** Rejects a tar entry path that would let extraction write outside the destination directory: an
 * absolute path, or one containing a `..` path segment. */
function isUnsafeTarPath(path: string): boolean {
  if (path.startsWith("/")) return true;
  return path.split("/").some((seg) => seg === "..");
}

/** Pre-scans `tarPath` with `tar -tvzf` and extracts only if every entry is a plain file/directory
 * with a safe relative path -- finding #3 in docs/reports/security-review-pr1.md: a crafted tarball
 * could otherwise write outside the workspace (absolute path, `../` traversal) or plant a symlink
 * that redirects a later write outside the workspace. Extraction itself also drops ownership/
 * permission bits from the archive (`--no-same-owner --no-same-permissions`) so nothing in the
 * tarball can grant itself elevated permissions once extracted. */
async function safeExtractTar(tarPath: string, cwd: string): Promise<void> {
  const listing = await execFileAsync("tar", ["-tvzf", tarPath]);
  const lines = listing.stdout.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const entry = parseTarEntry(line);
    if (!entry) continue; // unparseable line: fall through to isUnsafeTarPath below via the raw check
    if (entry.isLink) {
      throw new Error(`safeExtractTar: refusing tarball with a symlink/hardlink entry: ${entry.path}`);
    }
    if (isUnsafeTarPath(entry.path)) {
      throw new Error(`safeExtractTar: refusing tarball with an unsafe path: ${entry.path}`);
    }
  }
  await execFileAsync("tar", ["-xzf", tarPath, "-C", cwd, "--no-same-owner", "--no-same-permissions"]);
}

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
  /** Overrides SNAPSHOT_HOST_ALLOWLIST/OUTFITTER_DEV-derived validation, for tests. */
  allowlist?: string[];
  devMode?: boolean;
}

/** Restores a workspace from a tarball at a local file path, a `file://` URL, or an http(s) URL
 * (`run.spec.workspace.snapshotUrl`). `cwd` must already exist. GCS support comes later.
 *
 * Finding #3 (docs/reports/security-review-pr1.md): `snapshotUrl` ultimately comes from a
 * `checkpoint` frame's `workspaceUrl`, so it's validated here too (in addition to the API's own
 * validation when it persists the frame -- see packages/api/src/snapshot-url.ts) rather than
 * trusted blindly: an https URL must resolve to an allowlisted host (SNAPSHOT_HOST_ALLOWLIST), and
 * a file://-or-plain-path URL is only accepted when OUTFITTER_DEV=1. The tarball itself is
 * extracted via safeExtractTar, which pre-scans for path traversal/symlink entries. */
export async function restoreWorkspace(
  snapshotUrl: string,
  cwd: string,
  opts: RestoreWorkspaceOptions = {},
): Promise<void> {
  validateSnapshotUrl(snapshotUrl, {
    allowlist: opts.allowlist ?? snapshotHostAllowlist(),
    devMode: opts.devMode ?? isDevMode(),
  });

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

  await safeExtractTar(tarPath, cwd);
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
