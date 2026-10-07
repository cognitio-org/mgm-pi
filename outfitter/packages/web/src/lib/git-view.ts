// #502: what the floppy page shows about its branch, pull request and checks (docs/design/
// sessions-redesign-demo.html notes 15-20): the header's git chips, the Changes tab's diffs, the
// merge rules, and the messages the page sends the agent (Fix CI, resolve a conflict, diff notes).
// Pure, from GET /github-status (#500) and GET /changes (#499), so every rule is testable.

import type { ChangedFile, GithubCheck, GithubSessionPr, GithubSessionStatus, SessionChanges } from "../api/client.ts";

// ---------- patch hunks ----------

export type DiffRowKind = "hunk" | "add" | "del" | "ctx" | "meta";

export interface DiffRow {
  kind: DiffRowKind;
  /** Line number in the base file (del, ctx). */
  oldLine?: number;
  /** Line number in the branch's file (add, ctx). What a note on this line names. */
  newLine?: number;
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** GitHub-style patch text (from the first `@@`) to numbered rows. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line.slice(1).trim() });
      continue;
    }
    const mark = line.charAt(0);
    const text = line.slice(1);
    if (mark === "+") rows.push({ kind: "add", newLine: newLine++, text });
    else if (mark === "-") rows.push({ kind: "del", oldLine: oldLine++, text });
    else rows.push({ kind: "ctx", oldLine: oldLine++, newLine: newLine++, text });
  }
  return rows;
}

/** The line a note names: the branch's line, or for a removed line the base's. */
export function rowLine(row: DiffRow): number | undefined {
  return row.newLine ?? row.oldLine;
}

// ---------- header chips ----------

export type GitChip =
  | { kind: "branch"; branch: string; base: string | null }
  | { kind: "lines"; additions: number; deletions: number; files: number }
  | { kind: "behind"; behind: number; base: string }
  | { kind: "conflict" }
  | { kind: "pr"; number: number; draft: boolean; merged: boolean; title: string; checks: CheckSummaryView | null }
  | { kind: "create-pr" }
  | { kind: "fix-ci" };

export interface CheckSummaryView {
  tone: "pass" | "fail" | "run";
  text: string;
  glyph: string;
}

/** "✓ 3/3", "✗ 1 failing", "◌ 2 running", or null when the PR has no checks. */
export function checkSummary(pr: GithubSessionPr): CheckSummaryView | null {
  const s = pr.checkSummary;
  if (s.total === 0 || s.state === "none") return null;
  if (s.failed > 0) return { tone: "fail", text: `✗ ${s.failed} failing`, glyph: "✗" };
  if (s.pending > 0) return { tone: "run", text: `◌ ${s.pending} running`, glyph: "◌" };
  return { tone: "pass", text: `✓ ${s.passed}/${s.total}`, glyph: "✓" };
}

export function conflictedFiles(changes: SessionChanges | null): ChangedFile[] {
  return changes?.files.filter((f) => f.status === "U") ?? [];
}

/** The branch has something a pull request could carry. */
export function hasBranchChanges(status: GithubSessionStatus | null, changes: SessionChanges | null): boolean {
  if (changes && changes.files.length > 0) return true;
  return (changes?.ahead ?? status?.diff?.ahead ?? 0) > 0;
}

export interface ChipInput {
  status: GithubSessionStatus | null;
  changes: SessionChanges | null;
  /** The sync just reported a conflict with the base. */
  syncConflict?: boolean;
  /** A pull request this page merged (GitHub no longer lists it as open). */
  mergedPr?: { number: number; title: string } | null;
}

/** The header's git chips, in order: branch, lines, behind or conflict, PR, then an action. */
export function gitChips({ status, changes, syncConflict, mergedPr }: ChipInput): GitChip[] {
  const branch = changes?.branch ?? status?.branch ?? null;
  if (!branch) return [];
  const base = changes?.base ?? status?.baseBranch ?? null;
  const chips: GitChip[] = [{ kind: "branch", branch, base }];
  const files = changes?.files ?? [];
  const additions = changes ? files.reduce((n, f) => n + f.additions, 0) : (status?.diff?.additions ?? 0);
  const deletions = changes ? files.reduce((n, f) => n + f.deletions, 0) : (status?.diff?.deletions ?? 0);
  if (additions > 0 || deletions > 0) chips.push({ kind: "lines", additions, deletions, files: files.length });
  const pr = status?.pr ?? null;
  const conflict = Boolean(syncConflict) || conflictedFiles(changes).length > 0 || pr?.mergeableState === "dirty";
  const behind = changes?.behind ?? status?.diff?.behind ?? 0;
  if (conflict) chips.push({ kind: "conflict" });
  else if (behind > 0 && base) chips.push({ kind: "behind", behind, base });
  if (pr) {
    chips.push({ kind: "pr", number: pr.number, draft: pr.draft, merged: false, title: pr.title, checks: checkSummary(pr) });
    if (pr.checkSummary.failed > 0) chips.push({ kind: "fix-ci" });
  } else if (mergedPr) {
    chips.push({ kind: "pr", number: mergedPr.number, draft: false, merged: true, title: mergedPr.title, checks: null });
  } else if (hasBranchChanges(status, changes)) {
    chips.push({ kind: "create-pr" });
  }
  return chips;
}

// ---------- merge ----------

export interface MergeState {
  /** Merge… may be offered at all (the tape allows merging from the cloud). */
  offered: boolean;
  /** It can go now. */
  enabled: boolean;
  /** Why not, in a sentence, when it can't. */
  reason: string | null;
}

export function mergeState(status: GithubSessionStatus | null): MergeState {
  const pr = status?.pr;
  if (!pr) return { offered: false, enabled: false, reason: null };
  if (!status?.mergeAllowed)
    return { offered: false, enabled: false, reason: "Merging from the cloud is off for this tape. Merge on GitHub, or turn it on in the tape." };
  const base = pr.base ?? "the base branch";
  const no = (reason: string): MergeState => ({ offered: true, enabled: false, reason });
  if (!pr.headSha) return no("GitHub hasn't said which commit is the head yet.");
  if (pr.draft) return no("This pull request is a draft. Mark it ready on GitHub first.");
  if (pr.checkSummary.failed > 0) return no("A check is failing.");
  if (pr.checkSummary.pending > 0) return no("Waiting for checks to pass.");
  if (pr.checksError) return no("The checks couldn't be read.");
  if (pr.mergeable === null) return no("GitHub is still working out whether this can merge.");
  if (pr.mergeable === false || pr.mergeableState === "dirty") return no(`It conflicts with ${base}: sync or resolve first.`);
  if (pr.mergeableState === "blocked") return no(pr.review === "changes_requested" ? "Changes were requested in review." : "Branch protection is holding it (a review or a required check).");
  if (pr.mergeableState === "behind") return no(`It's behind ${base}: sync first.`);
  return { offered: true, enabled: true, reason: null };
}

// ---------- copy ----------

const NONE_COPY: Record<string, string> = {
  "no-repository": "This floppy has no repository. Pick one when you start a floppy to get branch, diff and PR tools here.",
  "no-branch": "No branch yet: the agent hasn't pushed anything.",
  "not-found": "Nothing pushed yet: GitHub doesn't have this branch.",
  "not-installed": "The Outfitter GitHub App can't see this repository. Install it on the repository's account.",
  "not-configured": "GitHub isn't set up on this Outfitter yet.",
  misconfigured: "GitHub is set up wrong on this Outfitter (a Sysop can fix it in the Control Panel).",
  unavailable: "GitHub isn't answering right now. This refreshes on its own.",
  invalid: "The repository name doesn't look right.",
};

/** Friendly words for GET /changes's `source: "none"` reasons. */
export function changesNoneCopy(reason: string | undefined): string {
  return (reason && NONE_COPY[reason]) || "No changes to show yet.";
}

/** "1m ago", "3h ago", "Oct 2". */
export function ago(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Pushed 1m ago · 7c1e9a4", or the sha alone for a push recorded before its time was. */
export function pushedLine(push: { sha: string; at?: string } | null | undefined, now: number = Date.now()): string {
  if (!push) return "Nothing pushed yet";
  const sha = push.sha.slice(0, 7);
  return push.at ? `Pushed ${ago(push.at, now)} · ${sha}` : `Pushed · ${sha}`;
}

/** A finished check's run time: "48s", "2m 10s". */
export function checkDuration(check: Pick<GithubCheck, "startedAt" | "completedAt" | "state">): string {
  if (check.state === "running") return "running";
  if (!check.startedAt || !check.completedAt) return "";
  const s = Math.max(0, Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000));
  if (Number.isNaN(s)) return "";
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export interface DiffNote {
  path: string;
  line: number;
  /** Which side the line is on: the branch's file, or a line the branch removed. */
  side: "new" | "old";
  text: string;
}

/** One message for the agent with every note, `path:line: note` each. */
export function notesMessage(notes: DiffNote[]): string {
  const lines = notes.map((n) => `- ${n.path}:${n.line}${n.side === "old" ? " (removed line)" : ""}: ${n.text.replace(/\s+/g, " ").trim()}`);
  return `Notes on the diff:\n${lines.join("\n")}`;
}

export function fixCiMessage(pr: Pick<GithubSessionPr, "number">, check: Pick<GithubCheck, "name"> | null, logTail?: string): string {
  const head = `CI failed on #${pr.number}${check ? ` (${check.name})` : ""}. Fix it and push.`;
  const tail = logTail?.trim();
  return tail ? `${head}\n\n\`\`\`\n${tail}\n\`\`\`` : head;
}

export function conflictMessage(files: string[], base: string, branch: string | null): string {
  const where = branch ? `Merging ${base} into ${branch}` : `Merging ${base} into this branch`;
  const list = files.length > 0 ? ` conflicts in ${files.join(", ")}` : " conflicts";
  return `${where}${list}. Merge ${base} in, resolve the conflicts, run the tests, and push.`;
}
