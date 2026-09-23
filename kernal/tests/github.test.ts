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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
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

  });

  test("commit: git's own failures are not blamed on a hook, even in a repo that has hooks", async () => {
    const repo = temp(newRepo());
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    writeFileSync(join(repo, "a.txt"), "a\n");
    run(repo, "add", "a.txt");
    // A locked index is git's own fatal, not a hook saying no: the model must not be sent hunting
    // for a lint error that does not exist.
    writeFileSync(join(repo, ".git", "index.lock"), "");
    const res = await git.commit(repo, { message: "try" });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "error", (res as any).detail);
    rmSync(join(repo, ".git", "index.lock"));

    // And an ordinary commit does not report git's own "[main abc] subject" summary as hook output.
    const good = await git.commit(repo, { message: "real commit" });
    assert.equal(good.ok, true);
    assert.equal((good as any).hookOutput, undefined);
  });

  test("commit: a hook that rewrites files is reported, and tracked staging leaves untracked files alone", async () => {
    const repo = temp(newRepo());
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "post-commit"), "#!/bin/sh\nprintf 'formatted\\n' >> tracked.txt\n");
    chmodSync(join(hooks, "post-commit"), 0o755);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    run(repo, "add", "tracked.txt"); run(repo, "commit", "--quiet", "-m", "add tracked");
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    writeFileSync(join(repo, "scratch.txt"), "junk\n");
    const res = await git.commit(repo, { message: "change tracked", tracked: true });
    assert.equal(res.ok, true);
    assert.deepEqual((res as any).hookChanged, ["tracked.txt"], "the hook's own rewrite is named");
    const after = (await git.status(repo))!;
    assert.deepEqual(after.untracked, ["scratch.txt"], "tracked staging never sweeps an untracked file in");
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

  test("runGit: a command that never reads stdin does not fail with EPIPE", async () => {
    const repo = temp(newRepo());
    // `git status` exits without reading stdin; on Linux the write loses that race and the socket
    // raises EPIPE. Run it enough times to catch the race rather than one lucky ordering.
    for (let i = 0; i < 25; i++) {
      const r = await git.runGit(["status", "--porcelain"], { cwd: repo, stdin: "x".repeat(4096) });
      assert.equal(r.code, 0);
    }
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
    const enterprise: ghlib.Exec = async (cmd, args) => {
      if (cmd === "git") return { stdout: "credential.https://ghe.example.com.helper !/usr/bin/gh auth git-credential\n", stderr: "", code: 0 };
      if (args[0] === "auth") return { stdout: "", stderr: status, code: 0 };
      return { stdout: "", stderr: "", code: 1 };
    };
    assert.equal((await ghlib.authState("gh", enterprise)).gitConfigured, false, "a helper for another host is not github.com");
    assert.equal(ghlib.githubComUsesGh("credential.helper !gh auth git-credential\n"), true);
    assert.equal(ghlib.loginCommand("/Users/me/My Tools/gh"), "'/Users/me/My Tools/gh' auth login --web --git-protocol https --hostname github.com --scopes workflow");
    assert.equal(ghlib.setupGitCommand("gh"), "gh auth setup-git --hostname github.com");
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

  test("log: a range can never become an option, however it is spelled", async () => {
    const repo = temp(newRepo());
    const target = join(repo, "not-written-by-git.txt");
    writeFileSync(target, "original\n");
    const res = await runAction("log", { range: `--output=${target}` }, { cwd: repo, settings, gh: noGh });
    assert.equal(readFileSync(target, "utf8"), "original\n", "git must not have written this file");
    assert.match(res.text, /No commits\.|must come before/);

    for (const name of ["--discard-changes", "-D", "--force"]) {
      const branch = await runAction("branch", { op: "create", name }, { cwd: repo, settings, gh: noGh });
      assert.equal(branch.isError, true, `${name} was refused`);
      assert.match(branch.text, /cannot start with/);
    }
    const from = await runAction("branch", { op: "create", name: "ok", from: "--discard-changes" }, { cwd: repo, settings, gh: noGh });
    assert.equal(from.isError, true);
  });

  test("the pull request lookup: a real gh invocation, no PR, and a lookup that failed", async () => {
    const repo = temp(newRepo());
    run(repo, "remote", "add", "origin", "https://github.com/o/r.git");
    const calls: string[][] = [];
    const fake = (reply: { code: number; stdout?: string; stderr?: string }, graph = "{}"): any => ({
      path: "gh",
      exec: async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "api") return { stdout: graph, stderr: "", code: 0 };
        return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", code: reply.code };
      },
    });

    const pr = { number: 48, title: "Phase 1", url: "https://github.com/o/r/pull/48", state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] };
    const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } } } } });
    const found = await repoStatus(repo, fake({ code: 0, stdout: JSON.stringify(pr) }, threads));
    assert.equal(found?.pr?.number, 48);
    assert.equal(found?.pr?.unresolvedThreads, 1);
    assert.equal(found?.prUnavailable, undefined);
    // The fields really are gh's: reviewThreads is not one, and asking for it fails the whole call.
    const fields = calls[0][calls[0].indexOf("--json") + 1];
    assert.doesNotMatch(fields, /reviewThreads/);
    assert.match(fields, /^number,title,url,state,isDraft,reviewDecision,statusCheckRollup$/);

    const none = await repoStatus(repo, fake({ code: 1, stderr: "no pull requests found for branch \"main\"" }));
    assert.equal(none?.pr, undefined);
    assert.equal(none?.prUnavailable, undefined, "gh saying there is none is not a failure");

    const broken = await repoStatus(repo, fake({ code: 4, stderr: "gh: To get started with GitHub CLI, please run: gh auth login" }));
    assert.equal(broken?.pr, undefined);
    assert.match(String(broken?.prUnavailable), /could not be looked up: gh: To get started/);
    assert.match(statusForModel(broken!), /pullRequestLookup/);
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

describe("the tool definition itself", () => {
  /** Registers the extension against a fake pi and hands back what it registered. */
  async function register() {
    const tools: any[] = [];
    const commands = new Map<string, any>();
    const mod = await import("../.pi/extensions/kernal-github/index.ts");
    mod.default({
      registerTool: (t: any) => { tools.push(t); },
      registerCommand: (name: string, c: any) => { commands.set(name, c); },
      on: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    } as any);
    return { tools, commands };
  }

  test("the git tool stays inside the prompt budget, and says what it is for", async () => {
    const { tools } = await register();
    assert.equal(tools.length, 1);
    const git = tools[0];
    assert.equal(git.name, "git");
    // Every request carries this, so it is measured rather than trusted. The spec's budget is 2,500
    // tokens for all of phase 2's four tools; one tool gets a quarter of it.
    const size = JSON.stringify({ name: git.name, description: git.description, parameters: git.parameters }).length;
    const tokens = Math.ceil(size / 4);
    assert.ok(tokens < 625, `the git tool's definition is ~${tokens} tokens, over its share of the budget`);
    assert.ok(git.promptSnippet.length < 200);
    // Guidelines are appended to a shared section, so each one has to name the tool it is about.
    for (const line of git.promptGuidelines) assert.match(line, /\bgit\b/i, line);
  });

  test("the commands are registered with handlers", async () => {
    const { commands } = await register();
    assert.deepEqual([...commands.keys()].sort(), ["commit", "git", "github"]);
    for (const [name, c] of commands) {
      assert.equal(typeof c.handler, "function", name);
      assert.ok(c.description.length > 10, name);
    }
  });

  test("a read agent cannot push, and a child with no agent file is not unrestricted", async () => {
    const repo = temp(newRepo());
    const agentRoot = temp(mkdtempSync(join(tmpdir(), "kernal-agents-")));
    mkdirSync(join(agentRoot, "agents"), { recursive: true });
    const agent = join(agentRoot, "agents", "helper.md");
    writeFileSync(agent, "---\nname: helper\ndescription: Helps\ngithubTools: read\n---\n\nHelp.\n");
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    const prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_CODING_AGENT_DIR = agentRoot;
    const { tools } = await register();
    const gitTool = tools[0];
    const text = (res: any) => res.content[0].text as string;
    const ctx = { cwd: repo, getSystemPrompt: () => `<active_agent name="helper"/>\n\nHelp.` };
    try {
      const pushed = await gitTool.execute("1", { action: "push" }, undefined, undefined, ctx);
      assert.equal(pushed.isError, true);
      assert.match(text(pushed), /GitHub access is read/);

      const status = await gitTool.execute("2", { action: "status" }, undefined, undefined, ctx);
      assert.ok(!status.isError, text(status));
      assert.doesNotMatch(text(status), /GitHub access/);
      assert.match(text(status), /"branch": "main"/);

      writeFileSync(agent, "---\nname: helper\ngithubTools: full\n---\n\nHelp.\n");
      const full = await gitTool.execute("3", { action: "push" }, undefined, undefined, ctx);
      assert.doesNotMatch(text(full), /GitHub access is/);

      delete process.env.PI_SUBAGENT_CHILD;
      const parent = await gitTool.execute("4", { action: "push" }, undefined, undefined, { cwd: repo });
      assert.doesNotMatch(text(parent), /GitHub access is/);

      process.env.PI_SUBAGENT_CHILD = "1";
      const missing = await gitTool.execute("5", { action: "status" }, undefined, undefined, {
        cwd: repo,
        getSystemPrompt: () => `<active_agent name="nobody"/>\n`,
      });
      assert.equal(missing.isError, true);
      assert.match(text(missing), /GitHub access is off/);

      mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
      writeFileSync(join(repo, ".pi", "agents", "helper.md"), "---\nname: helper\ngithubTools: off\n---\n\nNo.\n");
      const project = await gitTool.execute("6", { action: "status" }, undefined, undefined, ctx);
      assert.match(text(project), /GitHub access is off/);

      delete process.env.PI_SUBAGENT_CHILD;
      const explicit = await gitTool.execute("7", { action: "push" }, undefined, undefined, { cwd: repo, githubTools: "read" });
      assert.match(text(explicit), /GitHub access is read/);
    } finally {
      if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = prevChild;
      if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevDir;
    }
  });

  test("/commit in a clean tree says so, and never starts a turn", async () => {
    const repo = temp(newRepo());
    const { commands } = await register();
    const notices: string[] = [];
    let turns = 0;
    await commands.get("commit").handler("", {
      cwd: repo,
      ui: { notify: (m: string) => notices.push(m) },
      sendUserMessage: async () => { turns++; },
    });
    assert.equal(turns, 0);
    assert.match(notices.join(" "), /working tree is clean/);

    writeFileSync(join(repo, "x.txt"), "x\n");
    await commands.get("commit").handler("", {
      cwd: repo,
      ui: { notify: (m: string) => notices.push(m) },
      sendUserMessage: async () => { turns++; },
    });
    assert.equal(turns, 1, "with changes and no message, the agent is asked to do it");
  });
});
