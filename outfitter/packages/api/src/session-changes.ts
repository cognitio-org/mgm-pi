// #499: a session's changed files for the Changes pane. Two sources share one shape:
//  - a live Drive: agentd's `diff` (base...HEAD, then the working tree, then untracked files, as
//    one unified patch; packages/agentd/src/git.ts) parsed here into per-file entries;
//  - a sleeping Drive: GitHub's compare of base...branch on the pushed branch (GithubCatalog).
// Everything here is pure, so the parsing and the size caps are tested without a Drive or GitHub.

/** A = added, M = modified, D = deleted, R = renamed, C = copied, U = unmerged (a conflict). */
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "U";

export interface ChangedFile {
  path: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  /** The file's hunks (from its first `@@`), without the `diff --git` header. Absent for a binary
   * file, a change with no hunks (a pure rename or mode change), or one dropped by the size caps
   * (then `patchOmitted`). */
  patch?: string;
  /** The patch existed but was over a size cap, or GitHub left it out (too large to show). */
  patchOmitted?: boolean;
}

export interface SessionChanges {
  /** Where the list came from: the live Drive, the pushed branch on GitHub, or nowhere. */
  source: "drive" | "github" | "none";
  /** Why the source is "none" (no repository, the GitHub App can't reach it, nothing pushed...). */
  reason?: string;
  base: string | null;
  branch: string | null;
  /** The branch tip GitHub compared (GitHub source only; a live Drive's list includes unpushed
   * work, so it has none). */
  head?: string;
  /** Commits the branch has that the base doesn't, and the reverse (GitHub only). */
  ahead?: number;
  behind?: number;
  /** The last checkpoint that landed on GitHub, from the session. */
  pushed?: { sha: string; at?: string };
  /** Some files, or some patches, were left out: over the caps, or GitHub's own 300-file limit. */
  truncated: boolean;
  files: ChangedFile[];
}

/** One file's patch above this is dropped (counts stay). */
export const MAX_FILE_PATCH_BYTES = 100_000;
/** Patches stop being included once this many bytes have been. */
export const MAX_TOTAL_PATCH_BYTES = 1_000_000;
/** Files past this many are left out. */
export const MAX_FILES = 1_000;

/** Undoes git's C-style quoting of a path (`"a/caf\303\251 x"`). Unquoted input is returned as is. */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      const oct = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next]!);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `a/foo` -> `foo`, `/dev/null` -> null. */
function stripSide(raw: string, prefix: "a/" | "b/"): string | null {
  const value = unquoteGitPath(raw.trim());
  if (value === "/dev/null") return null;
  return value.startsWith(prefix) ? value.slice(2) : value;
}

/** The two paths of a `diff --git a/X b/Y` line when there are no `---`/`+++` lines to go by
 * (binary, rename-only, mode-only). Unambiguous when quoted or when X and Y are the same. */
function pathsFromGitHeader(rest: string): { from: string; to: string } | null {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted && (quoted[1]!.startsWith('"') || quoted[2]!.startsWith('"'))) {
    return { from: stripSide(quoted[1]!, "a/") ?? "", to: stripSide(quoted[2]!, "b/") ?? "" };
  }
  // a/P b/P with the same P (spaces allowed): the halves are equal length.
  if (rest.startsWith("a/")) {
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest[half] === " ") {
      const from = rest.slice(2, half);
      const to = rest.slice(half + 3);
      if (rest.slice(half + 1, half + 3) === "b/" && from === to) return { from, to };
    }
  }
  if (quoted) return { from: stripSide(quoted[1]!, "a/") ?? "", to: stripSide(quoted[2]!, "b/") ?? "" };
  return null;
}

interface Section {
  combined: boolean;
  header: string;
  lines: string[];
}

function splitSections(patch: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of patch.split("\n")) {
    const git = line.startsWith("diff --git ");
    const combined = line.startsWith("diff --cc ") || line.startsWith("diff --combined ");
    if (git || combined) {
      current = { combined, header: line, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

function parseSection(section: Section): ChangedFile | null {
  let from: string | null | undefined;
  let to: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let copyFrom: string | undefined;
  let copyTo: string | undefined;
  let isNew = false;
  let isDeleted = false;
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let hunkStart = -1;
  const width = section.combined ? 2 : 1;

  for (let i = 0; i < section.lines.length; i++) {
    const line = section.lines[i]!;
    if (hunkStart < 0) {
      if (line.startsWith("@@")) {
        hunkStart = i;
        continue;
      }
      if (line.startsWith("--- ")) from = stripSide(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) to = stripSide(line.slice(4), "b/");
      else if (line.startsWith("rename from ")) renameFrom = unquoteGitPath(line.slice(12));
      else if (line.startsWith("rename to ")) renameTo = unquoteGitPath(line.slice(10));
      else if (line.startsWith("copy from ")) copyFrom = unquoteGitPath(line.slice(10));
      else if (line.startsWith("copy to ")) copyTo = unquoteGitPath(line.slice(8));
      else if (line.startsWith("new file mode")) isNew = true;
      else if (line.startsWith("deleted file mode")) isDeleted = true;
      else if (line.startsWith("GIT binary patch")) binary = true;
      else if (line.startsWith("Binary files ")) {
        binary = true;
        const m = line.match(BINARY_LINE);
        if (m) {
          from ??= stripSide(m[1]!, "a/");
          to ??= stripSide(m[2]!, "b/");
        }
      }
      continue;
    }
    if (line.startsWith("@@")) continue;
    const marks = line.slice(0, width);
    if (marks.includes("+")) additions++;
    else if (marks.includes("-")) deletions++;
  }

  const rest = section.header.replace(/^diff --(git|cc|combined) /, "");
  let path: string | undefined;
  let oldPath: string | undefined;
  if (section.combined) {
    path = to ?? unquoteGitPath(rest);
  } else if (renameTo !== undefined || copyTo !== undefined) {
    path = renameTo ?? copyTo;
    oldPath = renameFrom ?? copyFrom;
  } else if (to) {
    path = to;
  } else if (from) {
    path = from;
  } else {
    const both = pathsFromGitHeader(rest);
    path = both?.to || both?.from;
  }
  if (!path) return null;

  let status: ChangeStatus;
  if (section.combined) status = "U";
  else if (renameTo !== undefined) status = "R";
  else if (copyTo !== undefined) status = "C";
  else if (isNew || from === null) status = "A";
  else if (isDeleted || to === null) status = "D";
  else status = "M";

  const file: ChangedFile = { path, status, additions, deletions };
  if (oldPath !== undefined && oldPath !== path) file.oldPath = oldPath;
  if (binary) file.binary = true;
  if (hunkStart >= 0) {
    const hunks = section.lines.slice(hunkStart);
    while (hunks.length > 0 && hunks[hunks.length - 1] === "") hunks.pop();
    if (hunks.length > 0) file.patch = hunks.join("\n");
  }
  return file;
}

/** Parses a unified `git diff` (several concatenated, `diff --cc` included) into one entry per
 * section, in order. agentd's patch (packages/agentd/src/git.ts) is one diff from the merge-base to
 * the working tree plus one `--no-index` diff per untracked file, so each path appears once; no
 * merging of sections is needed (or attempted). */
export function parseUnifiedPatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const section of splitSections(patch)) {
    const file = parseSection(section);
    if (file) files.push(file);
  }
  return files;
}

/** `Binary files a/X and b/Y differ`, either side `/dev/null` or C-quoted. The first path is
 * non-greedy and the second must start with `b/` (or be quoted or /dev/null), so a path containing
 * " and " splits at the right place in the usual case. */
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const BINARY_LINE = new RegExp(String.raw`^Binary files (${QUOTED}|/dev/null|a/.+?) and (${QUOTED}|/dev/null|b/.+) differ$`);

/** The most of a live patch the api will split (agentd caps its own at 2 MB; this guards an older
 * agentd, or a forged frame). */
export const MAX_LIVE_PATCH_BYTES = 4 * 1024 * 1024;

/** Cuts `patch` at the last file boundary under `maxBytes`. Same rule as agentd's capPatch. */
export function capLivePatch(patch: string, maxBytes = MAX_LIVE_PATCH_BYTES): { patch: string; truncated: boolean } {
  if (patch.length <= maxBytes / 4 || Buffer.byteLength(patch, "utf8") <= maxBytes) return { patch, truncated: false };
  const head = Buffer.from(patch, "utf8").subarray(0, maxBytes).toString("utf8");
  const cut = Math.max(head.lastIndexOf("\ndiff --git "), head.lastIndexOf("\ndiff --cc "));
  return { patch: cut > 0 ? head.slice(0, cut + 1) : "", truncated: true };
}

/** GitHub's compare `files[]` status words to our letters. `unchanged` is not a change. */
const GITHUB_STATUS: Record<string, ChangeStatus> = {
  added: "A",
  removed: "D",
  modified: "M",
  changed: "M",
  renamed: "R",
  copied: "C",
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** GitHub compare `files[]` rows to ChangedFile. GitHub leaves out the patch of a binary file and of
 * one too large for it to render; a row with line changes but no patch is marked `patchOmitted`. */
export function filesFromGithubCompare(rows: unknown): ChangedFile[] {
  if (!Array.isArray(rows)) return [];
  const files: ChangedFile[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.filename !== "string" || !r.filename) continue;
    const status = typeof r.status === "string" ? GITHUB_STATUS[r.status] : undefined;
    if (!status) continue;
    const file: ChangedFile = { path: r.filename, status, additions: count(r.additions), deletions: count(r.deletions) };
    if (typeof r.previous_filename === "string" && r.previous_filename && r.previous_filename !== r.filename) {
      file.oldPath = r.previous_filename;
    }
    if (typeof r.patch === "string" && r.patch) file.patch = r.patch;
    else if (file.additions + file.deletions > 0) file.patchOmitted = true;
    // No patch and no line counts: a binary file (or an empty one; GitHub doesn't say which). A
    // pure rename or copy is neither.
    else if (status !== "R" && status !== "C") file.binary = true;
    files.push(file);
  }
  return files;
}

/** Applies MAX_FILES, MAX_FILE_PATCH_BYTES and MAX_TOTAL_PATCH_BYTES. Counts are never dropped from
 * a file that is kept. `truncated` is true when anything was left out. */
export function capChanges(
  files: ChangedFile[],
  limits: { maxFiles?: number; maxFilePatchBytes?: number; maxTotalPatchBytes?: number } = {},
): { files: ChangedFile[]; truncated: boolean } {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxFile = limits.maxFilePatchBytes ?? MAX_FILE_PATCH_BYTES;
  const maxTotal = limits.maxTotalPatchBytes ?? MAX_TOTAL_PATCH_BYTES;
  let truncated = files.length > maxFiles;
  let total = 0;
  const kept = files.slice(0, maxFiles).map((file) => {
    if (file.patch === undefined) return file;
    const size = Buffer.byteLength(file.patch, "utf8");
    if (size > maxFile || total + size > maxTotal) {
      truncated = true;
      const { patch: _dropped, ...rest } = file;
      return { ...rest, patchOmitted: true };
    }
    total += size;
    return file;
  });
  return { files: kept, truncated };
}

/** The session fields the Changes pane reads. */
export interface ChangesSession {
  repo: string | null;
  branch?: string;
  baseBranch?: string;
  checkpoint?: { branch?: string; head?: string; landedAt?: string };
}

/** GithubCatalog.compareBranch's answer (github-catalog.ts), restated so this module stays pure. */
export type BranchCompare =
  | { ok: true; ahead?: number; behind?: number; head?: string; files: ChangedFile[]; partial: boolean }
  | { ok: false; reason: string };

export interface ChangesSources {
  /** agentd's diff on the live Drive; absent (or throwing) when there's no live run to ask. */
  liveDiff?: () => Promise<Record<string, unknown>>;
  compare: (args: { repo: string; branch: string; baseBranch: string; expectedHead: string | null }) => Promise<BranchCompare>;
}

/** The last checkpoint that landed on GitHub (agentlink.ts records head and landedAt). */
export function lastPush(checkpoint: ChangesSession["checkpoint"]): { sha: string; at?: string } | undefined {
  if (!checkpoint?.head) return undefined;
  return { sha: checkpoint.head, ...(checkpoint.landedAt ? { at: checkpoint.landedAt } : {}) };
}

/** #499: the live Drive's working tree when it can answer, else the pushed branch on GitHub. */
export async function loadSessionChanges(session: ChangesSession, sources: ChangesSources): Promise<SessionChanges> {
  const base = session.baseBranch ?? null;
  const branch = session.branch ?? session.checkpoint?.branch ?? null;
  const pushed = lastPush(session.checkpoint);
  const common = { base, branch, ...(pushed ? { pushed } : {}) };
  if (!session.repo) return { source: "none", reason: "no-repository", ...common, truncated: false, files: [] };

  if (sources.liveDiff) {
    try {
      const result = await sources.liveDiff();
      if (typeof result.patch === "string") {
        const live = capLivePatch(result.patch);
        const capped = capChanges(parseUnifiedPatch(live.patch));
        // No `head`: the list includes work not pushed yet; `pushed.sha` says what GitHub has.
        return {
          source: "drive",
          ...common,
          base: typeof result.base === "string" && result.base ? result.base : base,
          truncated: result.truncated === true || live.truncated || capped.truncated,
          files: capped.files,
        };
      }
    } catch (err) {
      // A Drive that went to sleep mid-request, or timed out: the pushed branch is the next best.
      console.warn(`[changes] live diff failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!branch || !base) return { source: "none", reason: "no-branch", ...common, truncated: false, files: [] };
  const compared = await sources.compare({ repo: session.repo, branch, baseBranch: base, expectedHead: pushed?.sha ?? null });
  if (!compared.ok) return { source: "none", reason: compared.reason, ...common, truncated: false, files: [] };
  const capped = capChanges(compared.files);
  const head = compared.head ?? pushed?.sha;
  return {
    source: "github",
    ...common,
    ...(head ? { head } : {}),
    ...(compared.ahead !== undefined ? { ahead: compared.ahead } : {}),
    ...(compared.behind !== undefined ? { behind: compared.behind } : {}),
    truncated: compared.partial || capped.truncated,
    files: capped.files,
  };
}
