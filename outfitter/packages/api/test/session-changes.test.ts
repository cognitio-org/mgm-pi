// #499: the Changes pane's file list. The parser runs against fixtures and against a real git
// repository diffed the way agentd does (packages/agentd/src/git.ts's diff()).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capChanges,
  capLivePatch,
  filesFromGithubCompare,
  loadSessionChanges,
  parseUnifiedPatch,
  unquoteGitPath,
  type BranchCompare,
  type ChangedFile,
} from "../src/session-changes.ts";

const MODIFIED = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "--- a line that was a dashed comment",
  "+++ a line that is now a plus comment",
  " keep",
].join("\n");

test("a modified file: counts only hunk lines, even ones that look like headers", () => {
  const [file] = parseUnifiedPatch(MODIFIED);
  assert.equal(file!.path, "src/a.ts");
  assert.equal(file!.status, "M");
  assert.equal(file!.additions, 2);
  assert.equal(file!.deletions, 2);
  assert.ok(file!.patch!.startsWith("@@ -1,3 +1,3 @@"));
  assert.ok(!file!.patch!.includes("diff --git"));
});

test("added, deleted, renamed, binary, mode-only and quoted paths", () => {
  const patch = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "index e69de29..0000000",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/old name.ts b/new name.ts",
    "similarity index 90%",
    "rename from old name.ts",
    "rename to new name.ts",
    "index 1..2 100644",
    "--- a/old name.ts",
    "+++ b/new name.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/moved.ts b/dir/moved.ts",
    "similarity index 100%",
    "rename from moved.ts",
    "rename to dir/moved.ts",
    "diff --git a/logo.png b/logo.png",
    "index 3..4 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/run me.sh b/run me.sh",
    "old mode 100644",
    "new mode 100755",
    'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
    "index 5..6 100644",
    '--- "a/caf\\303\\251.md"',
    '+++ "b/caf\\303\\251.md"',
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const files = parseUnifiedPatch(patch);
  const by = new Map(files.map((f) => [f.path, f]));
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ["new.txt", "A"],
      ["gone.txt", "D"],
      ["new name.ts", "R"],
      ["dir/moved.ts", "R"],
      ["logo.png", "M"],
      ["run me.sh", "M"],
      ["café.md", "M"],
    ],
  );
  assert.equal(by.get("new.txt")!.additions, 2);
  assert.equal(by.get("gone.txt")!.deletions, 1);
  assert.equal(by.get("new name.ts")!.oldPath, "old name.ts");
  assert.equal(by.get("dir/moved.ts")!.oldPath, "moved.ts");
  assert.equal(by.get("dir/moved.ts")!.patch, undefined);
  assert.equal(by.get("logo.png")!.binary, true);
  assert.equal(by.get("logo.png")!.patch, undefined);
  assert.equal(by.get("run me.sh")!.additions, 0);
});

test("a conflicted file (diff --cc) is U", () => {
  const patch = [
    "diff --cc src/voice.ts",
    "index 1,2..0000000",
    "--- a/src/voice.ts",
    "+++ b/src/voice.ts",
    "@@@ -1,1 -1,1 +1,5 @@@",
    "++<<<<<<< HEAD",
    " +ours",
    "++=======",
    "+ theirs",
    "++>>>>>>> main",
  ].join("\n");
  const [file] = parseUnifiedPatch(patch);
  assert.equal(file!.path, "src/voice.ts");
  assert.equal(file!.status, "U");
  assert.equal(file!.additions, 5);
});

test("binary lines with /dev/null, quotes, or ' and ' in a path", () => {
  const added = parseUnifiedPatch(["diff --git a/x and y.png b/x and y.png", "new file mode 100644", "index 0..1", "Binary files /dev/null and b/x and y.png differ"].join("\n"));
  assert.deepEqual(added, [{ path: "x and y.png", status: "A", additions: 0, deletions: 0, binary: true }]);
  const removed = parseUnifiedPatch(["diff --git a/old.bin b/old.bin", "deleted file mode 100644", "Binary files a/old.bin and /dev/null differ"].join("\n"));
  assert.deepEqual(removed.map((f) => [f.path, f.status]), [["old.bin", "D"]]);
  const quoted = parseUnifiedPatch(['diff --git "a/caf\\303\\251.bin" "b/caf\\303\\251.bin"', 'Binary files "a/caf\\303\\251.bin" and "b/caf\\303\\251.bin" differ'].join("\n"));
  assert.deepEqual(quoted.map((f) => [f.path, f.status, f.binary]), [["café.bin", "M", true]]);
});

test("sections are listed as they come (agentd sends each path once)", () => {
  const a = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-x", "+y"].join("\n");
  const b = ["diff --git a/b b/b", "new file mode 100644", "--- /dev/null", "+++ b/b", "@@ -0,0 +1 @@", "+z"].join("\n");
  assert.deepEqual(parseUnifiedPatch(`${a}\n\n${b}\n`).map((f) => f.path), ["a", "b"]);
});

test("capLivePatch cuts an oversized live patch at a file boundary", () => {
  const one = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";
  const two = "diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+" + "z".repeat(200) + "\n";
  assert.deepEqual(capLivePatch(one + two), { patch: one + two, truncated: false });
  assert.deepEqual(capLivePatch(one + two, one.length + 20), { patch: one, truncated: true });
});

test("unquoteGitPath decodes octal escapes and leaves plain paths alone", () => {
  assert.equal(unquoteGitPath('"a\\tb\\"c"'), 'a\tb"c');
  assert.equal(unquoteGitPath('"\\360\\237\\230\\200"'), "😀");
  assert.equal(unquoteGitPath("plain path"), "plain path");
  assert.deepEqual(parseUnifiedPatch(""), []);
  assert.deepEqual(parseUnifiedPatch("not a patch"), []);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

test("a real repository, diffed the way agentd does it", { skip: spawnSync("git", ["--version"]).status !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "T");
    writeFileSync(join(dir, "keep.ts"), "a\nb\nc\n");
    writeFileSync(join(dir, "drop.ts"), "x\n");
    writeFileSync(join(dir, "old.ts"), "1\n2\n3\n4\n5\n6\n7\n8\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    git(dir, "checkout", "-qb", "outfitter/s1");
    writeFileSync(join(dir, "keep.ts"), "a\nB\nc\nd\n");
    unlinkSync(join(dir, "drop.ts"));
    renameSync(join(dir, "old.ts"), join(dir, "renamed.ts"));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "work");
    writeFileSync(join(dir, "keep.ts"), "a\nB\nc\nd\ne\n"); // uncommitted
    writeFileSync(join(dir, "new file.md"), "hello\n"); // untracked
    // agentd: the merge-base against the working tree, then each untracked file vs /dev/null.
    const mergeBase = git(dir, "merge-base", "main", "HEAD").trim();
    const tracked = git(dir, "diff", mergeBase);
    const untracked = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", "new file.md"], { cwd: dir, encoding: "utf8" }).stdout;
    const files = parseUnifiedPatch([tracked, untracked].filter(Boolean).join("\n"));
    assert.equal(files.length, 4, "each path once");
    const by = new Map(files.map((f) => [f.path, f]));
    assert.deepEqual([...by.keys()].sort(), ["drop.ts", "keep.ts", "new file.md", "renamed.ts"]);
    assert.equal(by.get("drop.ts")!.status, "D");
    assert.equal(by.get("renamed.ts")!.status, "R");
    assert.equal(by.get("renamed.ts")!.oldPath, "old.ts");
    assert.deepEqual([by.get("keep.ts")!.status, by.get("keep.ts")!.additions, by.get("keep.ts")!.deletions], ["M", 3, 1]);
    assert.deepEqual([by.get("new file.md")!.status, by.get("new file.md")!.additions], ["A", 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capChanges drops oversized patches, then stops at the total, and caps the file count", () => {
  const file = (path: string, size: number): ChangedFile => ({ path, status: "M", additions: 1, deletions: 0, patch: "x".repeat(size) });
  const out = capChanges([file("a", 10), file("big", 50), file("b", 30), file("c", 30)], {
    maxFilePatchBytes: 40,
    maxTotalPatchBytes: 50,
  });
  assert.equal(out.truncated, true);
  assert.deepEqual(
    out.files.map((f) => [f.path, f.patch?.length ?? null, f.patchOmitted ?? false, f.additions]),
    [
      ["a", 10, false, 1],
      ["big", null, true, 1],
      ["b", 30, false, 1],
      ["c", null, true, 1],
    ],
  );
  const many = capChanges([file("a", 1), file("b", 1), file("c", 1)], { maxFiles: 2 });
  assert.equal(many.files.length, 2);
  assert.equal(many.truncated, true);
  assert.equal(capChanges([file("a", 1)]).truncated, false);
});

test("GitHub compare rows map to letters, keep renames, and mark a missing patch", () => {
  const files = filesFromGithubCompare([
    { filename: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
    { filename: "b.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" },
    { filename: "c.ts", status: "removed", additions: 0, deletions: 4 },
    { filename: "d.ts", previous_filename: "old/d.ts", status: "renamed", additions: 0, deletions: 0 },
    { filename: "e.ts", status: "unchanged", additions: 0, deletions: 0 },
    { filename: "logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
    { filename: 42, status: "modified" },
    null,
  ]);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.oldPath ?? null, f.patchOmitted ?? false, f.binary ?? false]),
    [
      ["a.ts", "M", null, false, false],
      ["b.ts", "A", null, false, false],
      ["c.ts", "D", null, true, false],
      ["d.ts", "R", "old/d.ts", false, false],
      ["logo.png", "M", null, false, true],
    ],
  );
  assert.deepEqual(filesFromGithubCompare(undefined), []);
});

const SESSION = {
  repo: "acme/widget",
  branch: "outfitter/s1",
  baseBranch: "main",
  checkpoint: { branch: "outfitter/s1", head: "a".repeat(40), landedAt: "2026-10-07T10:00:00.000Z" },
};

const neverCompare = async (): Promise<BranchCompare> => {
  throw new Error("should not compare");
};

test("a live Drive answers from its diff, with the last push", async () => {
  const changes = await loadSessionChanges(SESSION, {
    liveDiff: async () => ({ base: "main", patch: MODIFIED }),
    compare: neverCompare,
  });
  assert.equal(changes.source, "drive");
  assert.equal(changes.base, "main");
  assert.equal(changes.branch, "outfitter/s1");
  assert.equal(changes.head, undefined, "the list includes unpushed work; pushed.sha says what GitHub has");
  assert.deepEqual(changes.pushed, { sha: "a".repeat(40), at: "2026-10-07T10:00:00.000Z" });
  assert.equal(changes.truncated, false);
  assert.deepEqual(changes.files.map((f) => f.path), ["src/a.ts"]);
  const cut = await loadSessionChanges(SESSION, {
    liveDiff: async () => ({ base: "main", patch: MODIFIED, truncated: true }),
    compare: neverCompare,
  });
  assert.equal(cut.truncated, true, "agentd's own cap shows");
});

test("asleep (or a Drive that can't answer) reads the pushed branch on GitHub", async () => {
  const seen: unknown[] = [];
  const compare = async (args: unknown): Promise<BranchCompare> => {
    seen.push(args);
    return { ok: true, ahead: 2, behind: 1, head: "b".repeat(40), files: [{ path: "x", status: "A", additions: 1, deletions: 0 }], partial: true };
  };
  const asleep = await loadSessionChanges(SESSION, { compare });
  assert.equal(asleep.source, "github");
  assert.equal(asleep.ahead, 2);
  assert.equal(asleep.behind, 1);
  assert.equal(asleep.head, "b".repeat(40));
  assert.equal(asleep.truncated, true);
  assert.deepEqual(seen[0], { repo: "acme/widget", branch: "outfitter/s1", baseBranch: "main", expectedHead: "a".repeat(40) });
  const failing = await loadSessionChanges(SESSION, {
    liveDiff: async () => {
      throw new Error("timed out waiting for agentd reply");
    },
    compare,
  });
  assert.equal(failing.source, "github");
});

test("no repository, no branch, or GitHub can't say: source none with a reason", async () => {
  const none = await loadSessionChanges({ repo: null }, { liveDiff: async () => ({ patch: MODIFIED }), compare: neverCompare });
  assert.deepEqual(none, { source: "none", reason: "no-repository", base: null, branch: null, truncated: false, files: [] });
  const noBranch = await loadSessionChanges({ repo: "acme/widget", baseBranch: "main" }, { compare: neverCompare });
  assert.equal(noBranch.reason, "no-branch");
  const notPushed = await loadSessionChanges(
    { repo: "acme/widget", branch: "outfitter/s1", baseBranch: "main" },
    { compare: async () => ({ ok: false, reason: "not-found" }) },
  );
  assert.equal(notPushed.source, "none");
  assert.equal(notPushed.reason, "not-found");
  assert.equal(notPushed.pushed, undefined);
});
