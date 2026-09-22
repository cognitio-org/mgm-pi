/**
 * kernal-github phase 1: the shared git module, the GitHub CLI helper, and the tool's actions.
 *
 * The git tests run against real temporary repositories with a real `git` and a local bare remote,
 * because the things that break here are git's own edge cases: a file name with a space, a hook that
 * refuses a commit, a push that is rejected. The `gh` tests use a fake executable, so nothing here
 * touches the network or a real GitHub account.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as git from "../.pi/extensions/_shared/git.ts";
import * as ghlib from "../.pi/extensions/kernal-github/gh.ts";
import { attributionFrom, checksLine, cloudTrailers, commitTrailers, renderStatus, repoStatus, rollup, runAction, statusForModel } from "../.pi/extensions/kernal-github/lib.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.invalid" };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kernal-git-"));
  run(dir, "init", "--quiet", "--initial-branch=main");
  run(dir, "config", "user.name", "T");
  run(dir, "config", "user.email", "t@e.invalid");
  run(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  run(dir, "add", "README.md");
  run(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

/** A bare repository this one pushes to, wired as `origin`. */
function withRemote(repo: string): string {
  const remote = mkdtempSync(join(tmpdir(), "kernal-remote-"));
  run(remote, "init", "--quiet", "--bare");
  // The bare repo's HEAD decides what a later `git clone` checks out; without this it is whatever
  // this machine's git defaults to (master here), and a clone would work on a different branch.
  run(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  run(repo, "remote", "add", "origin", remote);
  return remote;
}

const trash: string[] = [];
after(() => { for (const d of trash) rmSync(d, { recursive: true, force: true }); });
const temp = (d: string) => { trash.push(d); return d; };

describe("the shared git module", () => {
  test("status: branch, upstream, ahead and behind, and every kind of change", async () => {
    const repo = temp(newRepo());
    const remote = temp(withRemote(repo));
    run(repo, "push", "--quiet", "--set-upstream", "origin", "main");

    writeFileSync(join(repo, "staged.txt"), "a\n");
    run(repo, "add", "staged.txt");
    writeFileSync(join(repo, "README.md"), "# changed\n");
    writeFileSync(join(repo, "untracked file.txt"), "u\n");   // a space, to catch naive splitting
    run(repo, "commit", "--quiet", "--allow-empty", "-m", "local only");

    const s = (await git.status(repo))!;
    assert.equal(s.branch, "main");
    assert.equal(s.upstream, "origin/main");
    assert.equal(s.ahead, 1);
    assert.equal(s.behind, 0);
    assert.deepEqual(s.unstaged.map((f) => f.path), ["README.md"]);
    assert.deepEqual(s.untracked, ["untracked file.txt"]);
    assert.equal(s.clean, false);
    assert.equal(s.lastCommit?.subject, "local only");
    assert.ok(s.root.endsWith(repo.split("/").pop()!));

    // behind: push a commit from a second clone, then re-read
    const other = temp(mkdtempSync(join(tmpdir(), "kernal-clone-")));
    run(other, "clone", "--quiet", remote, "c");
    const clone = join(other, "c");
    run(clone, "config", "user.email", "t@e.invalid");
    run(clone, "config", "user.name", "T");
    run(clone, "commit", "--quiet", "--allow-empty", "-m", "remote side");
    run(clone, "push", "--quiet");
    run(repo, "fetch", "--quiet");
    const after2 = (await git.status(repo))!;
    assert.equal(after2.ahead, 1);
    assert.equal(after2.behind, 1);
  });

  test("status: a rename keeps both paths, and an unborn branch is reported", async () => {
    const repo = temp(newRepo());
    run(repo, "mv", "README.md", "READ ME.md");
    const s = (await git.status(repo))!;
    assert.deepEqual(s.staged.map((f) => f.path), ["READ ME.md"]);
    assert.equal(s.staged[0].from, "README.md");

    const empty = temp(mkdtempSync(join(tmpdir(), "kernal-empty-")));
    run(empty, "init", "--quiet", "--initial-branch=main");
    const e = (await git.status(empty))!;
    assert.equal(e.unborn, true);
    assert.equal(e.branch, "main");
    assert.equal(e.clean, true);
  });

  test("status: undefined outside a repository, and isClean / isPushed answer teleport's questions", async () => {
    const plain = temp(mkdtempSync(join(tmpdir(), "kernal-plain-")));
    assert.equal(await git.status(plain), undefined);
    assert.equal(await git.repoRoot(plain), undefined);

    const repo = temp(newRepo());
    temp(withRemote(repo));
    assert.equal(await git.isClean(repo), true);
    assert.equal(await git.isPushed(repo), false, "no upstream yet");
    run(repo, "push", "--quiet", "--set-upstream", "origin", "main");
    assert.equal(await git.isPushed(repo), true);
    writeFileSync(join(repo, "dirty.txt"), "x\n");
    assert.equal(await git.isClean(repo), false);
  });

  test("commit: names its own paths, message via stdin, trailers added once", async () => {
    const repo = temp(newRepo());
    writeFileSync(join(repo, "wanted.txt"), "1\n");
    writeFileSync(join(repo, "other.txt"), "2\n");
    const res = await git.commit(repo, {
      message: 'Subject "with quotes"\n\nBody -- and a dash.',
      paths: ["wanted.txt"],
      trailers: ["Co-Authored-By: Kernal <noreply@kernal.invalid>"],
    });
    assert.equal(res.ok, true);
    const body = run(repo, "log", "-1", "--format=%B");
    assert.match(body, /Subject "with quotes"/);
    assert.match(body, /Co-Authored-By: Kernal <noreply@kernal\.invalid>/);
    assert.equal(body.match(/Co-Authored-By/g)?.length, 1);
    assert.equal(run(repo, "status", "--porcelain"), "?? other.txt", "the file that was not named is untouched");

    const again = await git.commit(repo, { message: "Nothing here", paths: [] });
    assert.equal(again.ok, false);
    assert.equal((again as any).reason, "nothing-to-commit");
  });

  test("commit: a hook that refuses is reported, with its output, and nothing is committed", async () => {
    const repo = temp(newRepo());
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint failed: two blank lines'\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, "a.txt"), "a\n");
    const res = await git.commit(repo, { message: "try", paths: ["a.txt"] });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "hook-failed");
    assert.match((res as any).detail, /lint failed/);
    assert.equal(run(repo, "log", "-1", "--format=%s"), "first", "no commit was made");

    // A failure with no hook in the repository is an ordinary error, not a hook refusal.
    const plainFail = await git.commit(repo, { message: "try", paths: ["does-not-exist.txt"] });
    assert.equal(plainFail.ok, false);
    assert.equal((plainFail as any).reason, "error");
  });

  test("withTrailers: appends to an existing trailer block, and never duplicates", () => {
    assert.equal(git.withTrailers("Subject", ["A: b"]), "Subject\n\nA: b\n");
    assert.equal(git.withTrailers("Subject\n\nBody text.", ["A: b"]), "Subject\n\nBody text.\n\nA: b\n");
    assert.equal(git.withTrailers("Subject\n\nSigned-off-by: X <x@y.z>", ["A: b"]), "Subject\n\nSigned-off-by: X <x@y.z>\nA: b\n");
    assert.equal(git.withTrailers("Subject\n\nA: b", ["A: b"]), "Subject\n\nA: b\n");
  });

  test("push: sets upstream, pushes the exact commit, and reports a rejection as one", async () => {
    const repo = temp(newRepo());
    const remote = temp(withRemote(repo));
    const first = await git.push(repo);
    assert.equal(first.ok, true);
    assert.equal((first as any).setUpstream, true);
    assert.equal(run(remote, "rev-parse", "main"), run(repo, "rev-parse", "HEAD"));

    // someone else moves origin/main; our next push must be refused, not forced
    const other = temp(mkdtempSync(join(tmpdir(), "kernal-clone-")));
    run(other, "clone", "--quiet", remote, "c");
    const clone = join(other, "c");
    run(clone, "config", "user.email", "t@e.invalid"); run(clone, "config", "user.name", "T");
    run(clone, "commit", "--quiet", "--allow-empty", "-m", "theirs");
    run(clone, "push", "--quiet");
    run(repo, "commit", "--quiet", "--allow-empty", "-m", "ours");
    const clash = await git.push(repo);
    assert.equal(clash.ok, false);
    assert.equal((clash as any).reason, "rejected");
  });

  test("pull: fast-forwards, and a conflict comes back as the file list", async () => {
    const repo = temp(newRepo());
    const remote = temp(withRemote(repo));
    run(repo, "push", "--quiet", "--set-upstream", "origin", "main");
    const other = temp(mkdtempSync(join(tmpdir(), "kernal-clone-")));
    run(other, "clone", "--quiet", remote, "c");
    const clone = join(other, "c");
    run(clone, "config", "user.email", "t@e.invalid"); run(clone, "config", "user.name", "T");
    writeFileSync(join(clone, "README.md"), "# theirs\n");
    run(clone, "commit", "--quiet", "-am", "theirs");
    run(clone, "push", "--quiet");

    const ff = await git.pull(repo);
    assert.equal(ff.ok, true);
    assert.equal((ff as any).changed, true);

    // now both sides change the same line
    writeFileSync(join(repo, "README.md"), "# ours\n");
    run(repo, "commit", "--quiet", "-am", "ours");
    writeFileSync(join(clone, "README.md"), "# theirs again\n");
    run(clone, "commit", "--quiet", "-am", "theirs again");
    run(clone, "push", "--quiet");
    const conflict = await git.pull(repo, { rebase: true });
    assert.equal(conflict.ok, false);
    assert.equal((conflict as any).reason, "conflict");
    assert.deepEqual((conflict as any).files, ["README.md"]);
    run(repo, "rebase", "--abort");
  });

  test("branch: list, create, switch, delete", async () => {
    const repo = temp(newRepo());
    assert.equal((await git.switchBranch(repo, "feature/x", { create: true })).ok, true);
    const list = await git.branches(repo);
    assert.deepEqual(list.map((b) => b.name).sort(), ["feature/x", "main"]);
    assert.equal(list.find((b) => b.name === "feature/x")?.current, true);
    assert.equal((await git.switchBranch(repo, "main")).ok, true);
    assert.deepEqual(await git.mergedBranches(repo, "main"), ["feature/x"]);
    assert.equal((await git.deleteBranch(repo, "feature/x")).ok, true);
    assert.equal((await git.switchBranch(repo, "nope")).ok, false);
  });

  test("parseRemote: https, scp-like and ssh forms", () => {
    assert.deepEqual(git.parseRemote("https://github.com/o/r.git"), { host: "github.com", owner: "o", repo: "r", ssh: false });
    assert.deepEqual(git.parseRemote("git@github.com:o/r.git"), { host: "github.com", owner: "o", repo: "r", ssh: true });
    assert.deepEqual(git.parseRemote("ssh://git@github.com/o/r"), { host: "github.com", owner: "o", repo: "r", ssh: true });
    assert.equal(git.parseRemote("not a url"), undefined);
  });

  test("runGit: a non-zero exit is a result, and a missing repository is not an exception", async () => {
    const plain = temp(mkdtempSync(join(tmpdir(), "kernal-plain-")));
    const r = await git.runGit(["status"], { cwd: plain });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not a git repository/i);
  });
});

describe("the GitHub CLI helper", () => {
  test("assetFor and checksumFrom name and verify the right release file", () => {
    assert.deepEqual(ghlib.assetFor("v2.101.0", { os: "darwin", arch: "arm64" }), { name: "gh_2.101.0_macOS_arm64.zip", kind: "zip" });
    assert.deepEqual(ghlib.assetFor("2.101.0", { os: "linux", arch: "x64" }), { name: "gh_2.101.0_linux_amd64.tar.gz", kind: "tar" });
    assert.equal(ghlib.checksumsFor("v2.101.0"), "gh_2.101.0_checksums.txt");
    const body = `${"a".repeat(64)}  gh_2.101.0_linux_amd64.tar.gz\n${"b".repeat(64)}  gh_2.101.0_macOS_arm64.zip\n`;
    assert.equal(ghlib.checksumFrom(body, "gh_2.101.0_macOS_arm64.zip"), "b".repeat(64));
    assert.equal(ghlib.checksumFrom(body, "gh_2.101.0_windows_amd64.zip"), undefined);
  });

  test("findGh prefers PATH over kernal's own copy", async () => {
    const calls: string[] = [];
    const exec: ghlib.Exec = async (cmd) => {
      calls.push(cmd);
      return cmd === "gh" ? { stdout: "gh version 2.96.0 (2026-07-02)\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 127 };
    };
    const found = await ghlib.findGh(exec);
    assert.deepEqual([found?.path, found?.version, found?.managed], ["gh", "2.96.0", false]);
    assert.deepEqual(calls, ["gh"]);
  });

  test("authState reads the account, the scopes and whether git uses the login", async () => {
    const status = [
      "github.com",
      "  ✓ Logged in to github.com account octocat (keyring)",
      "  - Active account: true",
      "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
    ].join("\n");
    const exec: ghlib.Exec = async (cmd, args) => {
      if (cmd === "git") return { stdout: "credential.https://github.com.helper !/usr/bin/gh auth git-credential\n", stderr: "", code: 0 };
      if (args[0] === "auth") return { stdout: "", stderr: status, code: 0 };
      return { stdout: "", stderr: "", code: 1 };
    };
    const state = await ghlib.authState("gh", exec);
    assert.equal(state.signedIn, true);
    assert.equal(state.login, "octocat");
    assert.deepEqual(state.scopes, ["gist", "read:org", "repo", "workflow"]);
    assert.equal(state.gitConfigured, true);
    assert.deepEqual(ghlib.missingScopes(state.scopes), []);
    assert.deepEqual(ghlib.missingScopes(["repo"]), ["read:org", "workflow"]);

    const signedOut: ghlib.Exec = async () => ({ stdout: "", stderr: "You are not logged into any GitHub hosts.", code: 1 });
    assert.equal((await ghlib.authState("gh", signedOut)).signedIn, false);
  });

  test("installGh verifies the checksum before unpacking, and refuses a mismatch", async () => {
    const dir = temp(mkdtempSync(join(tmpdir(), "kernal-ghinstall-")));
    const stage = join(dir, "stage", "gh_9.9.9_linux_amd64", "bin");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "gh"), "#!/bin/sh\necho 'gh version 9.9.9 (2026-01-01)'\n");
    chmodSync(join(stage, "gh"), 0o755);
    execFileSync("tar", ["czf", join(dir, "gh.tgz"), "-C", join(dir, "stage"), "gh_9.9.9_linux_amd64"]);
    const archive = execFileSync("cat", [join(dir, "gh.tgz")], { maxBuffer: 1 << 26 });
    const sha = execFileSync("shasum", ["-a", "256", join(dir, "gh.tgz")], { encoding: "utf8" }).split(" ")[0];
    const binDir = join(dir, "bin");

    const deps = (sum: string): ghlib.InstallDeps => ({
      fetchJson: async () => ({ tag_name: "v9.9.9" }),
      fetchText: async () => `${sum}  ${ghlib.assetFor("9.9.9", ghlib.currentPlatform()!).name}\n`,
      fetchBinary: async () => Buffer.from(archive),
      binDir,
      exec: async (cmd, args, opts) => {
        if (cmd === "tar") { execFileSync("tar", ["xzf", args[1], "-C", args[3]]); return { stdout: "", stderr: "", code: 0 }; }
        return { stdout: "gh version 9.9.9 (2026-01-01)\n", stderr: "", code: 0 };
      },
    });

    const bad = await ghlib.installGh(deps("f".repeat(64)));
    assert.equal(bad.ok, false);
    assert.match((bad as any).detail, /does not match its published checksum/);

    // The archive above is a tar, so only exercise the unpack on a platform whose asset is a tar.
    if (ghlib.assetFor("9.9.9", ghlib.currentPlatform()!).kind === "tar") {
      const good = await ghlib.installGh(deps(sha));
      assert.equal(good.ok, true, JSON.stringify(good));
      assert.equal((good as any).path, join(binDir, "gh"));
    }
  });
});

describe("the git tool's actions", () => {
  const settings = { github: { attribution: { commit: "Co-Authored-By: Kernal <noreply@kernal.invalid>", pr: "Opened with Kernal" } } };
  const noGh = undefined;

  test("status: the model gets one JSON answer with everything in it", async () => {
    const repo = temp(newRepo());
    writeFileSync(join(repo, "new.txt"), "n\n");
    const res = await runAction("status", {}, { cwd: repo, settings, gh: noGh });
    const data = JSON.parse(res.text);
    assert.equal(data.branch, "main");
    assert.equal(data.clean, false);
    assert.deepEqual(data.untracked, ["new.txt"]);
    assert.equal(data.repo, null);
    assert.equal(res.isError, undefined);
  });

  test("commit: refuses without paths, commits what it is given, and says what is left", async () => {
    const repo = temp(newRepo());
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    const noPaths = await runAction("commit", { message: "x" }, { cwd: repo, settings, gh: noGh });
    assert.equal(noPaths.isError, true);
    assert.match(noPaths.text, /Name the paths/);

    const res = await runAction("commit", { message: "Add a", paths: ["a.txt"] }, { cwd: repo, settings, gh: noGh });
    assert.equal(res.isError, undefined);
    assert.match(res.text, /Committed [0-9a-f]{12} Add a\./);
    assert.match(res.text, /1 file\(s\) still uncommitted/);
    assert.match(run(repo, "log", "-1", "--format=%B"), /Co-Authored-By: Kernal/);
  });

  test("push: a rejection explains the two ways out, and never forces by itself", async () => {
    const repo = temp(newRepo());
    const remote = temp(withRemote(repo));
    await runAction("push", {}, { cwd: repo, settings, gh: noGh });
    const other = temp(mkdtempSync(join(tmpdir(), "kernal-clone-")));
    run(other, "clone", "--quiet", remote, "c");
    const clone = join(other, "c");
    run(clone, "config", "user.email", "t@e.invalid"); run(clone, "config", "user.name", "T");
    run(clone, "commit", "--quiet", "--allow-empty", "-m", "theirs");
    run(clone, "push", "--quiet");
    run(repo, "commit", "--quiet", "--allow-empty", "-m", "ours");

    const res = await runAction("push", {}, { cwd: repo, settings, gh: noGh });
    assert.equal(res.isError, true);
    assert.match(res.text, /rejected/);
    assert.match(res.text, /Pull first/);
    assert.equal(run(remote, "log", "-1", "--format=%s"), "theirs", "origin was not overwritten");
  });

  test("an unknown action, and a directory that is not a repository, are plain messages", async () => {
    const repo = temp(newRepo());
    assert.match((await runAction("teleport", {}, { cwd: repo, settings, gh: noGh })).text, /Unknown action/);
    const plain = temp(mkdtempSync(join(tmpdir(), "kernal-plain-")));
    const res = await runAction("commit", { message: "x", all: true }, { cwd: plain, settings, gh: noGh });
    assert.equal(res.isError, true);
    assert.match(res.text, /not inside a git repository/);
  });

  test("attribution: settings replace the default, an empty string turns it off, cloud trailers ride along", () => {
    assert.equal(attributionFrom({}).commit, "Co-Authored-By: Kernal <noreply@kernal.invalid>");
    assert.equal(attributionFrom({ github: { attribution: { commit: "" } } }).commit, "");
    assert.equal(attributionFrom({ github: { attribution: { commit: "X: y" } } }).commit, "X: y");
    assert.deepEqual(cloudTrailers({} as any), []);
    assert.deepEqual(cloudTrailers({ OUTFITTER_AUTHOR_NAME: "M M", OUTFITTER_AUTHOR_EMAIL: "1+m@users.noreply.github.com" } as any), [
      "Co-authored-by: M M <1+m@users.noreply.github.com>",
      "On-behalf-of: M M <1+m@users.noreply.github.com>",
    ]);
    assert.equal(commitTrailers({ github: { attribution: { commit: "" } } }, {} as any).length, 0);
  });
});

describe("what a person sees", () => {
  test("rollup and checksLine summarise checks the way a person reads them", () => {
    assert.equal(checksLine(rollup([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }])), "checks: all 2 passed");
    assert.equal(checksLine(rollup([{ conclusion: "FAILURE" }, { conclusion: "SUCCESS" }])), "checks: 1 failing, 1 passed");
    assert.equal(checksLine(rollup([{ status: "IN_PROGRESS" }, { conclusion: "SUCCESS" }])), "checks: 1 running, 1 passed");
    assert.equal(checksLine(rollup([])), undefined);
  });

  test("renderStatus: a branch with changes and a pull request", async () => {
    const repo = temp(newRepo());
    temp(withRemote(repo));
    run(repo, "push", "--quiet", "--set-upstream", "origin", "main");
    writeFileSync(join(repo, "x.txt"), "x\n");
    const st = (await repoStatus(repo, undefined, { pr: false }))!;
    st.repo = { owner: "mgmonteleone", repo: "mgm-pi", url: "https://github.com/mgmonteleone/mgm-pi", github: true };
    st.pr = { number: 7, title: "Add the git tool", url: "https://github.com/o/r/pull/7", state: "OPEN", reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, checks: { passed: 3, failed: 1, pending: 0, total: 4 } };
    const text = renderStatus(st);
    assert.match(text, /^main {2}· {2}mgmonteleone\/mgm-pi/m);
    assert.match(text, /1 file untracked/);
    assert.match(text, /PR #7 Add the git tool/);
    assert.match(text, /open, changes requested · 2 unresolved threads · checks: 1 failing, 3 passed/);

    const json = JSON.parse(statusForModel(st));
    assert.equal(json.pullRequest.number, 7);
    assert.equal(json.pullRequest.review, "CHANGES_REQUESTED");
  });

  test("renderStatus: an SSH remote says the GitHub tools need https", async () => {
    const repo = temp(newRepo());
    run(repo, "remote", "add", "origin", "git@github.com:o/r.git");
    const st = (await repoStatus(repo, undefined, { pr: false }))!;
    assert.equal(st.repo?.github, false);
    assert.match(renderStatus(st), /this remote is SSH/);
  });
});
