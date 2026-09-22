/**
 * GitOps against real repositories: a temporary bare "remote" reached over file://, and agentd's
 * own clone of it. These reproduce the sandbox's git bugs end to end rather than asserting argv.
 * The global/system git config is isolated below so a developer's own config (commit signing,
 * hooks, identity) can't change the outcome; node --test runs each file in its own process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitOps, OUTFITTER_BOT_IDENTITY } from "../src/git.js";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
delete process.env.GIT_AUTHOR_NAME;
delete process.env.GIT_AUTHOR_EMAIL;
delete process.env.GIT_COMMITTER_NAME;
delete process.env.GIT_COMMITTER_EMAIL;

const PERSON = { GIT_AUTHOR_NAME: "Agent", GIT_AUTHOR_EMAIL: "agent@example.com", GIT_COMMITTER_NAME: "Agent", GIT_COMMITTER_EMAIL: "agent@example.com" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...PERSON },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A bare remote with `main` (one commit) and, optionally, a session branch one commit ahead of it
 * -- i.e. a session that has already checkpointed. */
async function makeRemote(sessionBranch?: string): Promise<{ root: string; url: string; bare: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentd-git-repo-"));
  const bare = join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  const seed = join(root, "seed");
  git(root, "clone", "--quiet", bare, seed);
  await writeFile(join(seed, "README.md"), "hello\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  if (sessionBranch) {
    await writeFile(join(seed, "work.txt"), "checkpointed work\n");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "earlier checkpoint");
    git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${sessionBranch}`);
  }
  return { root, url: `file://${bare}`, bare };
}

function remoteSha(bare: string, branch: string): string | undefined {
  try {
    return git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
}

test("resume: clone with createBranch: false checks out the already-checkpointed session branch", async () => {
  // Before the explicit-refspec fix: `git fetch origin <branch>` on the single-branch clone only
  // wrote FETCH_HEAD, so `checkout -B <branch> origin/<branch>` failed with
  // "'origin/<branch>' is not a commit" for every session that had ever checkpointed.
  const { root, url, bare } = await makeRemote("outfitter/s1");
  const dest = join(root, "ws");
  await createGitOps().clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s1", createBranch: false }, dest);
  assert.equal(git(dest, "rev-parse", "--abbrev-ref", "HEAD"), "outfitter/s1");
  assert.equal(git(dest, "rev-parse", "HEAD"), remoteSha(bare, "outfitter/s1"));
  assert.equal(git(dest, "rev-parse", "refs/remotes/origin/outfitter/s1"), remoteSha(bare, "outfitter/s1"));
});

test("checkpoint push: the agent's own commits are pushed even when agentd has nothing to commit, and pushed is accurate", async () => {
  const { root, url, bare } = await makeRemote();
  const dest = join(root, "ws");
  const gitOps = createGitOps(undefined, { pushRoot: root });
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s2", createBranch: true }, dest);
  const push = () => gitOps.push(dest, { remoteUrl: url, branch: "outfitter/s2" });

  // first checkpoint: the remote branch doesn't exist yet, so HEAD (== main) is pushed to create it
  assert.deepEqual(await gitOps.commitAll(dest, "cp"), { committed: false });
  const first = await push();
  assert.equal(first.pushed, true);
  assert.equal(remoteSha(bare, "outfitter/s2"), first.head);

  // nothing new: no push
  assert.equal((await push()).pushed, false);

  // the agent commits by itself; agentd finds a clean tree, but the commit still goes up
  await writeFile(join(dest, "agent.txt"), "by the agent\n");
  git(dest, "add", "agent.txt");
  git(dest, "commit", "--quiet", "-m", "agent's own commit");
  assert.deepEqual(await gitOps.commitAll(dest, "cp"), { committed: false });
  const second = await push();
  assert.equal(second.pushed, true);
  assert.equal(remoteSha(bare, "outfitter/s2"), git(dest, "rev-parse", "HEAD"));
  // and the agent's own git sees an upstream that's up to date
  assert.equal(git(dest, "status", "-sb").split("\n")[0], "## outfitter/s2...origin/outfitter/s2");

  // then resuming from that branch works (the resume refspec fix, end to end)
  const resumed = join(root, "ws-resumed");
  await createGitOps().clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s2", createBranch: false }, resumed);
  assert.equal(git(resumed, "rev-parse", "HEAD"), second.head);
});

test("checkpoint commit: authored and committed by the Outfitter bot, trailers appended exactly once", async () => {
  const { root, url } = await makeRemote();
  const dest = join(root, "ws");
  const gitOps = createGitOps();
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s3", createBranch: true }, dest);
  const trailers = ["Co-authored-by: Ada <ada@users.noreply.github.com>", "On-behalf-of: Ada <ada@users.noreply.github.com>"];

  await writeFile(join(dest, "a.txt"), "a\n");
  assert.deepEqual(await gitOps.commitAll(dest, "cp one", trailers), { committed: true });
  const fmt = "%an <%ae>|%cn <%ce>";
  const bot = `${OUTFITTER_BOT_IDENTITY.name} <${OUTFITTER_BOT_IDENTITY.email}>`;
  assert.equal(git(dest, "log", "-1", `--format=${fmt}`), `${bot}|${bot}`);
  assert.equal(git(dest, "log", "-1", "--format=%(trailers:only)"), trailers.join("\n"));

  // a checkpoint message that already carries a trailer doesn't get it twice
  await writeFile(join(dest, "b.txt"), "b\n");
  await gitOps.commitAll(dest, `cp two\n\n${trailers[0]}`, trailers);
  assert.equal(git(dest, "log", "-1", "--format=%(trailers:only)"), trailers.join("\n"));

  // ...but someone else's Co-authored-by doesn't suppress the person's
  await writeFile(join(dest, "c.txt"), "c\n");
  const other = "Co-authored-by: Bob <bob@example.com>";
  await gitOps.commitAll(dest, `cp three\n\n${other}`, trailers);
  assert.equal(git(dest, "log", "-1", "--format=%(trailers:only)"), [other, ...trailers].join("\n"));
});

test("checkpoint commit: the agent's hooks and signing config can't block (or run during) it", async () => {
  const { root, url } = await makeRemote();
  const dest = join(root, "ws");
  const gitOps = createGitOps();
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s5", createBranch: true }, dest);
  const marker = join(root, "hook-ran");
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
    const hook = join(dest, ".git", "hooks", name);
    await writeFile(hook, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    await chmod(hook, 0o755);
  }
  git(dest, "config", "commit.gpgsign", "true");
  git(dest, "config", "gpg.program", "/nonexistent");
  await writeFile(join(dest, "d.txt"), "d\n");
  assert.deepEqual(await gitOps.commitAll(dest, "cp"), { committed: true });
  await assert.rejects(access(marker));
});

test("an agent amend or rebase of its own branch still pushes (lease), and anyone else's push wins", async () => {
  const { root, url, bare } = await makeRemote();
  const dest = join(root, "ws");
  const gitOps = createGitOps(undefined, { pushRoot: root });
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s6", createBranch: true }, dest);
  await writeFile(join(dest, "e.txt"), "e\n");
  await gitOps.commitAll(dest, "cp");
  await gitOps.push(dest, { remoteUrl: url, branch: "outfitter/s6" });

  git(dest, "commit", "--quiet", "--amend", "-m", "reworded by the agent");
  const amended = await gitOps.push(dest, { remoteUrl: url, branch: "outfitter/s6" });
  assert.equal(amended.pushed, true);
  assert.equal(remoteSha(bare, "outfitter/s6"), amended.head);

  // someone else pushes to the session branch: the lease refuses to clobber it
  const other = join(root, "other");
  git(root, "clone", "--quiet", "--branch", "outfitter/s6", url, other);
  git(other, "commit", "--quiet", "--allow-empty", "-m", "a human's commit");
  git(other, "push", "--quiet", "origin", "HEAD:refs/heads/outfitter/s6");
  const humanHead = git(other, "rev-parse", "HEAD");
  git(dest, "commit", "--quiet", "--allow-empty", "-m", "agent again");
  await assert.rejects(gitOps.push(dest, { remoteUrl: url, branch: "outfitter/s6" }), /stale info|rejected/);
  assert.equal(remoteSha(bare, "outfitter/s6"), humanHead);
});

test("clone with createBranch: true picks up a session branch that's already on origin", async () => {
  // The api infers createBranch from "no checkpoint recorded"; a push whose checkpoint frame never
  // arrived leaves the branch on origin anyway. Starting over from main would diverge from it.
  const { root, url, bare } = await makeRemote("outfitter/s7");
  const dest = join(root, "ws");
  const gitOps = createGitOps(undefined, { pushRoot: root });
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s7", createBranch: true }, dest);
  assert.equal(git(dest, "rev-parse", "HEAD"), remoteSha(bare, "outfitter/s7"));
  assert.equal((await gitOps.push(dest, { remoteUrl: url, branch: "outfitter/s7" })).pushed, false);
});

test("push never runs the workspace's hooks and never follows the workspace's origin URL", async () => {
  const { root, url, bare } = await makeRemote();
  const decoy = await makeRemote();
  const dest = join(root, "ws");
  const gitOps = createGitOps(undefined, { pushRoot: root });
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s4", createBranch: true }, dest);

  // everything the agent could plant in its own .git
  const marker = join(root, "hook-ran");
  const hook = join(dest, ".git", "hooks", "pre-push");
  await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`);
  await chmod(hook, 0o755);
  git(dest, "remote", "set-url", "origin", decoy.url);
  git(dest, "config", "url.file:///nonexistent/.insteadOf", url);

  await writeFile(join(dest, "c.txt"), "c\n");
  await gitOps.commitAll(dest, "cp");
  const res = await gitOps.push(dest, { remoteUrl: url, branch: "outfitter/s4" });
  assert.equal(res.pushed, true);
  assert.equal(remoteSha(bare, "outfitter/s4"), res.head);
  assert.equal(remoteSha(decoy.bare, "outfitter/s4"), undefined);
  await assert.rejects(access(marker), "the workspace's pre-push hook must not run");
});

test("clone hands the repo over before the checkout: root never checks out the tree", async () => {
  const { root, url } = await makeRemote("outfitter/s8");
  const dest = join(root, "ws");
  const seen: { handedOver: boolean; worktreeFiles: string[] }[] = [];
  const gitOps = createGitOps(undefined, {
    handOver: async (dir) => {
      seen.push({ handedOver: true, worktreeFiles: (await readdir(dir)).filter((f) => f !== ".git") });
    },
  });
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s8", createBranch: false }, dest);
  assert.deepEqual(seen, [{ handedOver: true, worktreeFiles: [] }], "nothing checked out before the handover");
  assert.ok((await readdir(dest)).includes("work.txt"), "checked out afterwards");
});

test("diff: an untracked file named like an option stays a path", async () => {
  const { root, url } = await makeRemote();
  const dest = join(root, "ws");
  const gitOps = createGitOps();
  await gitOps.clone({ cloneUrl: url, baseBranch: "main", branch: "outfitter/s9", createBranch: true }, dest);
  await writeFile(join(dest, "--output=pwned.txt"), "x\n");
  await writeFile(join(dest, "with space.txt"), "y\n");
  const patch = await gitOps.diff(dest, "main");
  await assert.rejects(access(join(dest, "pwned.txt")), "git must not have parsed the name as --output");
  assert.match(patch, /--output=pwned\.txt/);
  assert.match(patch, /with space\.txt/);
});
