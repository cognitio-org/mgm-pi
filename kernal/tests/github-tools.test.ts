/**
 * Phase 2 GitHub tools. A fake `gh` records every argument array and replays canned JSON, including
 * `gh api` for review threads and linked branches. Nothing here touches the network.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGh, type Exec } from "../.pi/extensions/kernal-github/gh.ts";
import {
  GITHUB_ACTION_CLASS, clearSeenHeads, composePrBody, executeGithub, githubToolClass, issuesNamed,
  type GithubDeps,
} from "../.pi/extensions/kernal-github/github-tools.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.invalid" };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const trash: string[] = [];
after(() => { for (const d of trash) rmSync(d, { recursive: true, force: true }); });
const temp = (d: string) => { trash.push(d); return d; };

function repo(): string {
  const dir = temp(mkdtempSync(join(tmpdir(), "kernal-gh-")));
  run(dir, "init", "--quiet", "--initial-branch=main");
  run(dir, "config", "user.name", "T");
  run(dir, "config", "user.email", "t@e.invalid");
  run(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  run(dir, "add", "README.md");
  run(dir, "commit", "--quiet", "-m", "first");
  run(dir, "remote", "add", "origin", "https://github.com/o/r.git");
  return dir;
}

type Hit = { stdout?: string; stderr?: string; code?: number };
type Call = { cmd: string; args: string[]; stdin?: string };

function fake(respond: (args: string[], stdin: string | undefined) => Hit) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], stdin: opts.stdin });
    const hit = respond(args, opts.stdin);
    return { stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", code: hit.code ?? 0 };
  };
  return { calls, gh: { path: "gh", exec } };
}

const deps = (cwd: string, gh: { path: string; exec: Exec }, extra: Partial<GithubDeps> = {}): GithubDeps =>
  ({ cwd, settings: {}, gh, ...extra });

const pr = (over: Record<string, unknown> = {}) => JSON.stringify({
  number: 7, title: "Add tools", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false,
  headRefOid: SHA_A, baseRefName: "main", reviewDecision: "REVIEW_REQUIRED", author: { login: "ada" },
  statusCheckRollup: [{ name: "test", conclusion: "SUCCESS", status: "COMPLETED" }],
  ...over,
});

describe("phase 2 github tools", { concurrency: 1 }, () => {
  test("classification matches the gate lists, and review depends on the decision", () => {
    for (const key of GITHUB_ACTION_CLASS.read) {
      const [tool, action] = key.split(":");
      assert.equal(githubToolClass(tool, action), "read", key);
    }
    for (const key of GITHUB_ACTION_CLASS.write) {
      const [tool, action] = key.split(":");
      assert.equal(githubToolClass(tool, action), "write", key);
    }
    for (const key of GITHUB_ACTION_CLASS.merge) {
      const [tool, action] = key.split(":");
      assert.equal(githubToolClass(tool, action), "merge", key);
    }
    assert.equal(githubToolClass("github_pr", "review"), "write");
    assert.equal(githubToolClass("github_pr", "review", { decision: "comment" }), "write");
    assert.equal(githubToolClass("github_pr", "review", { decision: "approve" }), "merge");
    assert.equal(githubToolClass("github_pr", "review", { decision: "request changes" }), "merge");
    assert.equal(githubToolClass("github_pr", "review", { decision: "REQUEST_CHANGES" }), "merge");
    assert.equal(githubToolClass("github_pr", "review", { decision: "lgtm" }), undefined);
    // Named by neither list: polling is not a write, and push belongs to the git tool.
    assert.equal(githubToolClass("github_pr", "wait_ci"), undefined);
    assert.equal(githubToolClass("git", "push"), undefined);
    assert.equal(GITHUB_ACTION_CLASS.read.includes("github_pr:wait_ci"), false);
    assert.ok(!JSON.stringify(GITHUB_ACTION_CLASS).includes("push"));
  });

  test("issues named by a branch or a commit, and a body keeps a template's other lines", () => {
    assert.deepEqual(issuesNamed("issue-87-tools", "Fix the parser\n\nFixes #12\n"), [12, 87]);
    assert.deepEqual(issuesNamed("feat/87-tools", ""), [87]);
    assert.deepEqual(issuesNamed("phase2", "nothing numeric"), []);

    const body = composePrBody({
      template: "## Summary\n\n## Test plan\n\n- [ ]\n",
      summary: "Adds the tools",
      testPlan: "node --test",
      closes: [12, 87],
      footer: "Opened with Kernal",
    });
    assert.match(body, /## Summary\n\nAdds the tools/);
    assert.match(body, /## Test plan\n\nnode --test\n\n- \[ \]/);
    assert.match(body, /Closes #12\nCloses #87\n\nOpened with Kernal\n$/);

    const again = composePrBody({ body: "Already\n\nFixes #12\n", closes: [12, 87], footer: "Opened with Kernal" });
    assert.equal(again.match(/Closes #12/g), null);
    assert.match(again, /Closes #87/);
    assert.equal(again.match(/Opened with Kernal/g)?.length, 1);
  });

  test("refuses a missing gh, an SSH remote, and a non-GitHub remote before calling gh", async () => {
    const dir = repo();
    const noGh = await executeGithub("github_pr", { action: "view" }, { cwd: dir, settings: {} });
    assert.equal(noGh.isError, true);
    assert.match(noGh.text, /GitHub CLI is not installed/);

    const ssh = repo();
    run(ssh, "remote", "set-url", "origin", "git@github.com:o/r.git");
    const { calls, gh } = fake(() => ({ stdout: "{}" }));
    const denied = await executeGithub("github_repo", { action: "view" }, deps(ssh, gh));
    assert.equal(denied.isError, true);
    assert.match(denied.text, /SSH/);
    assert.equal(calls.length, 0);

    const lab = repo();
    run(lab, "remote", "set-url", "origin", "https://gitlab.com/o/r.git");
    const other = await executeGithub("github_issue", { action: "list" }, deps(lab, gh));
    assert.match(other.text, /not a github.com https repository/);
    assert.equal(calls.length, 0);
  });

  test("pr view and list record an argument array and remember the head", async () => {
    clearSeenHeads();
    const dir = repo();
    const { calls, gh } = fake((args) => {
      assert.equal(Array.isArray(args), true);
      if (args[1] === "list") return { stdout: `[${pr({ number: 3, title: "One" })}]` };
      return { stdout: pr() };
    });
    const view = await executeGithub("github_pr", { action: "view" }, deps(dir, gh));
    assert.equal(view.isError, undefined);
    assert.equal(view.data.number, 7);
    assert.equal(view.data.sha, SHA_A);
    assert.equal(calls[0].cmd, "gh");
    assert.equal(calls[0].stdin, "", "a read does not leave stdin open");
    const fields = calls[0].args[calls[0].args.indexOf("--json") + 1];
    assert.doesNotMatch(fields, /reviewThreads/);
    assert.ok(calls[0].args.includes("main"), "view without a number uses the current branch");

    const list = await executeGithub("github_pr", { action: "list", state: "all", limit: 5 }, deps(dir, gh));
    assert.equal(list.data[0].number, 3);
    assert.deepEqual(calls[1].args.slice(0, 4), ["pr", "list", "--state", "all"]);
    assert.ok(calls[1].args.includes("5"));
  });

  test("create fills one template, links issues, and keeps a hostile title as one argument", async () => {
    const dir = repo();
    run(dir, "switch", "--create", "issue-87-tools");
    writeFileSync(join(dir, "a.txt"), "a\n");
    run(dir, "add", "a.txt");
    run(dir, "commit", "--quiet", "-m", "Fix the parser\n\nFixes #12\n");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "pull_request_template.md"), "## Summary\n\n## Test plan\n\n- [ ]\n");
    const title = 'Fix "quotes" and $(rm -rf /)';
    const { calls, gh } = fake(() => ({ stdout: "https://github.com/o/r/pull/9\n" }));
    const res = await executeGithub("github_pr", {
      action: "create", title, summary: "Adds the tools", testPlan: "node --test", draft: true,
    }, deps(dir, gh, { env: { OUTFITTER_AUTHOR_LOGIN: "ada" } as any }));
    assert.equal(res.isError, undefined, res.text);
    assert.equal(res.data.url, "https://github.com/o/r/pull/9");
    assert.equal(res.data.template, ".github/pull_request_template.md");
    assert.deepEqual(res.data.closes, [12, 87]);
    const call = calls[0];
    assert.equal(call.cmd, "gh");
    assert.ok(call.args.includes(title), "the title is one argument, not a shell string");
    assert.ok(call.args.includes("--draft"));
    assert.ok(call.args.includes("--body-file") && call.args.includes("-"));
    assert.match(call.stdin ?? "", /Adds the tools/);
    assert.match(call.stdin ?? "", /node --test/);
    assert.match(call.stdin ?? "", /- \[ \]/);
    assert.match(call.stdin ?? "", /Closes #12\nCloses #87/);
    assert.match(call.stdin ?? "", /Opened with Kernal/);
    assert.match(call.stdin ?? "", /Outfitter, on behalf of @ada/);
    assert.equal(call.args.filter((a) => a === title).length, 1);
  });

  test("create without a template writes a summary and a test plan", async () => {
    const dir = repo();
    const { calls, gh } = fake(() => ({ stdout: "https://github.com/o/r/pull/2\n" }));
    const res = await executeGithub("github_pr", { action: "create", title: "T", summary: "S", testPlan: "P" }, deps(dir, gh, { settings: { github: { attribution: { pr: "" } } } }));
    assert.equal(res.data.template, null);
    assert.match(calls[0].stdin ?? "", /## Summary\n\nS/);
    assert.match(calls[0].stdin ?? "", /## Test plan\n\nP/);
    assert.doesNotMatch(calls[0].stdin ?? "", /Opened with Kernal/);
  });

  test("several templates are listed, and the named one is the body", async () => {
    const dir = repo();
    const root = join(dir, ".github", "PULL_REQUEST_TEMPLATE");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "bug.md"), "BUG TEMPLATE\n");
    writeFileSync(join(root, "feature.md"), "FEATURE TEMPLATE\n");
    const { calls, gh } = fake(() => ({ stdout: "https://github.com/o/r/pull/4\n" }));
    const missing = await executeGithub("github_pr", { action: "create", title: "T" }, deps(dir, gh));
    assert.equal(missing.isError, true);
    assert.match(missing.text, /bug\.md/);
    assert.match(missing.text, /feature\.md/);
    assert.equal(calls.length, 0);

    const created = await executeGithub("github_pr", { action: "create", title: "T", template: "bug.md", summary: "S" }, deps(dir, gh));
    assert.equal(created.isError, undefined, created.text);
    assert.match(calls[0].stdin ?? "", /BUG TEMPLATE/);
    assert.match(calls[0].stdin ?? "", /S/);
    assert.equal(created.data.template, ".github/PULL_REQUEST_TEMPLATE/bug.md");
  });

  test("merge fails when the head moved, and pins the SHA it last saw", async () => {
    clearSeenHeads();
    const dir = repo();
    const heads = [SHA_A, SHA_B];
    const moved = fake((args) => {
      if (args[1] === "view") return { stdout: JSON.stringify({ number: 31, headRefOid: heads.shift(), url: "u", title: "t", state: "OPEN" }) };
      return { code: 2, stderr: "should not merge" };
    });
    await executeGithub("github_pr", { action: "view", number: 31 }, deps(dir, moved.gh));
    const denied = await executeGithub("github_pr", { action: "merge", number: 31, method: "squash" }, deps(dir, moved.gh));
    assert.equal(denied.isError, true);
    assert.match(denied.text, new RegExp(`moved from ${SHA_A} to ${SHA_B}`));
    assert.equal(moved.calls.some((c) => c.args[1] === "merge"), false);

    const okMerge = fake((args) => {
      if (args[1] === "view") return { stdout: JSON.stringify({ number: 32, headRefOid: SHA_A, url: "u", title: "t", state: "OPEN" }) };
      if (args[1] === "merge") return { stdout: "merged\n" };
      return { code: 2, stderr: JSON.stringify(args) };
    });
    await executeGithub("github_pr", { action: "view", number: 32 }, deps(dir, okMerge.gh));
    const merged = await executeGithub("github_pr", { action: "merge", number: 32, method: "squash" }, deps(dir, okMerge.gh));
    assert.equal(merged.isError, undefined, merged.text);
    const merge = okMerge.calls.find((c) => c.args[1] === "merge")!;
    assert.ok(merge.args.includes("--squash"));
    assert.ok(merge.args.includes("--match-head-commit"));
    assert.ok(merge.args.includes(SHA_A));

    const unpinned = await executeGithub("github_pr", { action: "merge", number: 99, method: "merge" }, deps(dir, okMerge.gh));
    assert.match(unpinned.text, /View the pull request first/);
  });

  test("review, reply and resolve go through gh, and inline comments go through gh api", async () => {
    const dir = repo();
    const { calls, gh } = fake((args) => {
      if (args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: "https://github.com/o/r/pull/7#discussion_r1" } }, resolveReviewThread: { thread: { isResolved: true } } } }) };
      if (args[0] === "api" && args.includes("--method")) return { stdout: JSON.stringify({ html_url: "https://github.com/o/r/pull/7#pullrequestreview-1" }) };
      if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: SHA_A }) };
      return { stdout: "https://github.com/o/r/pull/7#issuecomment-1\n" };
    });
    const comment = await executeGithub("github_pr", { action: "review", number: 7, decision: "comment", body: "Looks fine" }, deps(dir, gh));
    assert.equal(comment.data.decision, "comment");
    assert.ok(calls[0].args.includes("--comment"));
    assert.match(calls[0].stdin ?? "", /Looks fine/);

    const approved = await executeGithub("github_pr", {
      action: "review", number: 7, decision: "approve", body: "Ship",
      comments: [{ path: "a.ts", line: 10, body: "nit", side: "RIGHT" }],
    }, deps(dir, gh));
    assert.equal(approved.isError, undefined, approved.text);
    const api = calls.find((c) => c.args[0] === "api" && c.args.includes("--method"))!;
    assert.deepEqual(api.args.slice(0, 4), ["api", "--method", "POST", "repos/o/r/pulls/7/reviews"]);
    const payload = JSON.parse(api.stdin ?? "{}");
    assert.equal(payload.event, "APPROVE");
    assert.equal(payload.commit_id, SHA_A);
    assert.deepEqual(payload.comments, [{ path: "a.ts", line: 10, side: "RIGHT", body: "nit" }]);

    const reply = await executeGithub("github_pr", { action: "reply", thread: "PRRT_1", body: "done" }, deps(dir, gh));
    assert.match(reply.data.url, /discussion_r1/);
    const gql = calls.find((c) => c.args.includes("graphql") && c.args.some((a) => a.includes("addPullRequestReviewThreadReply")))!;
    assert.ok(gql.args.includes("id=PRRT_1"));
    assert.ok(gql.args.some((a) => a.includes("done")));

    const resolved = await executeGithub("github_pr", { action: "resolve", thread: "PRRT_1" }, deps(dir, gh));
    assert.equal(resolved.data.resolved, true);
    assert.ok(calls.some((c) => c.args.some((a) => a.includes("resolveReviewThread"))));
  });

  test("checks, then wait_ci reports pass, fail with a log tail, or timeout", async () => {
    const dir = repo();
    const checked = fake(() => ({ stdout: pr({ statusCheckRollup: [{ name: "lint", conclusion: "FAILURE", status: "COMPLETED" }, { name: "test", conclusion: "SUCCESS", status: "COMPLETED" }] }) }));
    const checks = await executeGithub("github_pr", { action: "checks", number: 7 }, deps(dir, checked.gh));
    assert.equal(checks.data.checks.failed, 1);
    assert.equal(checks.data.jobs[0].name, "lint");

    let polls = 0;
    const passing = fake(() => {
      polls++;
      const rollup = polls === 1
        ? [{ name: "test", conclusion: null, status: "IN_PROGRESS" }]
        : [{ name: "test", conclusion: "SUCCESS", status: "COMPLETED" }];
      return { stdout: pr({ statusCheckRollup: rollup }) };
    });
    let t = 0;
    const sleeps: number[] = [];
    const updates: string[] = [];
    const clock = { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, intervalMs: 1000 };
    const passed = await executeGithub("github_pr", { action: "wait_ci", number: 7, timeout: 30 }, deps(dir, passing.gh, {
      ...clock, update: (p) => updates.push(p.content[0].text),
    }));
    assert.equal(passed.data.result, "pass");
    assert.equal(passed.isError, undefined);
    assert.equal(sleeps.length, 1);
    assert.ok(updates.length >= 1);
    assert.match(updates[0], /running/);

    const lines = Array.from({ length: 100 }, (_, i) => i === 0 ? "SHOULD_NOT_SEE" : i === 99 ? "FAIL_TAIL_MARKER" : `line ${i}`).join("\n");
    const failing = fake((args) => {
      if (args[0] === "run" && args[1] === "list") return { stdout: JSON.stringify([{ databaseId: 55, conclusion: "failure", name: "test" }]) };
      if (args[0] === "run" && args[1] === "view") return { stdout: lines };
      if (args[0] === "pr" && args[1] === "view") return { stdout: pr({ headRefOid: SHA_B, statusCheckRollup: [{ name: "test", conclusion: "FAILURE", status: "COMPLETED" }] }) };
      return { code: 2, stderr: JSON.stringify(args) };
    });
    const failed = await executeGithub("github_pr", { action: "wait_ci", number: 8, timeout: 30 }, deps(dir, failing.gh, clock));
    assert.equal(failed.data.result, "fail");
    assert.equal(failed.isError, undefined);
    assert.deepEqual(failed.data.failed, ["test"]);
    assert.match(failed.data.log, /FAIL_TAIL_MARKER/);
    assert.doesNotMatch(failed.data.log, /SHOULD_NOT_SEE/);
    assert.ok(failing.calls.some((c) => c.args[0] === "run" && c.args[1] === "view" && c.args.includes("55") && c.args.includes("--log-failed")));

    let spins = 0;
    t = 0;
    const spinning = fake(() => {
      spins++;
      return { stdout: pr({ number: 9, statusCheckRollup: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }] }) };
    });
    const timed = await executeGithub("github_pr", { action: "wait_ci", number: 9, timeout: 1 }, deps(dir, spinning.gh, clock));
    assert.equal(timed.data.result, "timeout");
    assert.equal(timed.isError, undefined);
    assert.ok(spins <= 3, `polled ${spins} times`);
  });

  test("wait_ci stops when the head moves off the commit it started on", async () => {
    const dir = repo();
    let n = 0;
    const { gh } = fake(() => {
      n++;
      return { stdout: pr({ number: 11, headRefOid: n === 1 ? SHA_A : SHA_B, statusCheckRollup: [{ name: "test", conclusion: null, status: "IN_PROGRESS" }] }) };
    });
    let t = 0;
    const res = await executeGithub("github_pr", { action: "wait_ci", number: 11, timeout: 30 }, deps(dir, gh, {
      intervalMs: 1000, now: () => t, sleep: async (ms: number) => { t += ms; },
    }));
    assert.equal(res.data.result, "fail");
    assert.equal(res.data.reason, "head-moved");
    assert.equal(res.data.from, SHA_A);
    assert.equal(res.data.to, SHA_B);
  });

  test("issues: list, create, edit, close, reopen, and start switches to the linked branch", async () => {
    const dir = repo();
    run(dir, "branch", "issue-4-start");
    const { calls, gh } = fake((args) => {
      if (args[1] === "list") return { stdout: JSON.stringify([{ number: 4, title: "Tools", url: "https://github.com/o/r/issues/4", state: "OPEN", labels: [{ name: "bug" }], assignees: [{ login: "ada" }] }]) };
      if (args[1] === "view") return { stdout: JSON.stringify({ number: 4, title: "Tools", body: "Body", url: "https://github.com/o/r/issues/4", state: "OPEN", labels: [], assignees: [] }) };
      if (args[1] === "create") return { stdout: "https://github.com/o/r/issues/8\n" };
      if (args[1] === "develop") return { stdout: "https://github.com/o/r/tree/issue-4-start\n" };
      if (args[0] === "api") return { stdout: JSON.stringify({ data: { repository: { issue: { linkedBranches: { nodes: [{ ref: { name: "issue-4-start" } }] } } } } }) };
      return { stdout: "" };
    });
    const list = await executeGithub("github_issue", { action: "list", assignee: "@me" }, deps(dir, gh));
    assert.equal(list.data[0].labels[0], "bug");
    assert.ok(calls[0].args.includes("--assignee") && calls[0].args.includes("@me"));

    const title = "A title with `backticks`";
    const created = await executeGithub("github_issue", { action: "create", title, body: "Please", labels: ["bug"] }, deps(dir, gh));
    assert.equal(created.data.url, "https://github.com/o/r/issues/8");
    const create = calls.find((c) => c.args[1] === "create")!;
    assert.ok(create.args.includes(title));
    assert.ok(create.args.includes("--label") && create.args.includes("bug"));
    assert.match(create.stdin ?? "", /Please/);

    const edited = await executeGithub("github_issue", { action: "edit", number: 4, title: "Renamed", removeLabels: ["bug"], assignees: ["ada"] }, deps(dir, gh));
    assert.equal(edited.isError, undefined, edited.text);
    const edit = calls.find((c) => c.args[1] === "edit")!;
    assert.ok(edit.args.includes("--remove-label") && edit.args.includes("bug"));
    assert.ok(edit.args.includes("--add-assignee") && edit.args.includes("ada"));

    await executeGithub("github_issue", { action: "close", number: 4, reason: "not planned" }, deps(dir, gh));
    assert.ok(calls.some((c) => c.args.includes("close") && c.args.includes("not planned")));
    await executeGithub("github_issue", { action: "reopen", number: 4 }, deps(dir, gh));
    assert.ok(calls.some((c) => c.args[0] === "issue" && c.args[1] === "reopen"));

    const started = await executeGithub("github_issue", { action: "start", number: 4 }, deps(dir, gh));
    assert.equal(started.isError, undefined, started.text);
    assert.equal(started.data.branch, "issue-4-start");
    assert.equal(run(dir, "branch", "--show-current"), "issue-4-start");
    assert.ok(calls.some((c) => c.args[0] === "api" && c.args.some((a) => a.includes("linkedBranches"))));
  });

  test("repo view reports the default branch, permission and template; search and releases record argv", async () => {
    const dir = repo();
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "pull_request_template.md"), "TEMPLATE\n");
    const { calls, gh } = fake((args) => {
      if (args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "o/r", url: "https://github.com/o/r", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }) };
      if (args[1] === "issues") return { stdout: JSON.stringify([{ number: 1, title: "I", state: "open", url: "u" }]) };
      if (args[1] === "prs") return { stdout: JSON.stringify([{ number: 2, title: "P", state: "open", url: "u" }]) };
      if (args[0] === "release") return { stdout: JSON.stringify([{ tagName: "v1", name: "v1", isDraft: false, isPrerelease: false, url: "u" }]) };
      return { code: 2, stderr: JSON.stringify(args) };
    });
    const view = await executeGithub("github_repo", { action: "view" }, deps(dir, gh));
    assert.equal(view.data.defaultBranch, "main");
    assert.equal(view.data.permission, "WRITE");
    assert.equal(view.data.templates[0].path, ".github/pull_request_template.md");
    assert.match(view.data.templates[0].body, /TEMPLATE/);

    const found = await executeGithub("github_repo", { action: "search", query: "tools" }, deps(dir, gh));
    assert.equal(found.data.issues[0].number, 1);
    assert.equal(found.data.pullRequests[0].number, 2);
    assert.ok(calls.some((c) => c.args[0] === "search" && c.args[1] === "issues" && c.args.includes("tools")));
    assert.ok(calls.some((c) => c.args[0] === "search" && c.args[1] === "prs"));

    const releases = await executeGithub("github_repo", { action: "releases" }, deps(dir, gh));
    assert.equal(releases.data[0].tagName, "v1");
  });

  test("checkout, comment and edit are argument arrays", async () => {
    const dir = repo();
    const { calls, gh } = fake((args) => args[1] === "view" ? { stdout: pr() } : { stdout: "ok\n" });
    await executeGithub("github_pr", { action: "checkout", number: 7 }, deps(dir, gh));
    assert.deepEqual(calls[0].args, ["pr", "checkout", "7"]);
    await executeGithub("github_pr", { action: "comment", number: 7, body: "hello" }, deps(dir, gh));
    assert.ok(calls[1].args.includes("comment") && calls[1].stdin === "hello\n" || (calls[1].stdin ?? "").startsWith("hello"));
    await executeGithub("github_pr", { action: "edit", number: 7, title: "New", base: "dev" }, deps(dir, gh));
    const edit = calls.find((c) => c.args[1] === "edit")!;
    assert.ok(edit.args.includes("--title") && edit.args.includes("New"));
    assert.ok(edit.args.includes("--base") && edit.args.includes("dev"));
  });

  test("/pr and /issues render data or hand the agent a precise instruction", async () => {
    const dir = repo();
    const { calls, gh } = fake((args) => {
      if (args[1] === "list") return { stdout: JSON.stringify([{ number: 4, title: "Tools", url: "u", state: "OPEN", labels: [], assignees: [] }]) };
      if (args[1] === "view" && args[0] === "issue") return { stdout: JSON.stringify({ number: 9, title: "Nine", body: "b", url: "https://github.com/o/r/issues/9", state: "OPEN", labels: [{ name: "bug" }], assignees: [] }) };
      if (args[1] === "develop") return { stdout: "https://github.com/o/r/tree/issue-9-start\n" };
      if (args[0] === "api") return { stdout: JSON.stringify({ data: { repository: { issue: { linkedBranches: { nodes: [{ ref: { name: "issue-9-start" } }] } } } } }) };
      return { stdout: pr() };
    });
    run(dir, "branch", "issue-9-start");
    const mod = await import("../.pi/extensions/kernal-github/index.ts");
    const commands = new Map<string, any>();
    mod.default({
      registerTool: () => {},
      registerCommand: (name: string, c: any) => { commands.set(name, c); },
      on: () => {},
    } as any);
    const notices: string[] = [];
    const turns: string[] = [];
    const ctx = {
      cwd: dir,
      ui: { notify: (m: string) => notices.push(m) },
      sendUserMessage: async (m: string) => { turns.push(m) },
    };
    assert.equal(typeof commands.get("pr").handler, "function");
    assert.equal(typeof commands.get("issues").handler, "function");

    // The registered handlers look gh up themselves. These are what they call, with the fake injected.
    const { handleIssuesCommand, handlePrCommand } = await import("../.pi/extensions/kernal-github/github-tools.ts");
    const d = deps(dir, gh);
    await handlePrCommand("new", ctx, d);
    await handlePrCommand("review 8", ctx, d);
    await handlePrCommand("review", ctx, d);
    assert.equal(calls.length, 0, "/pr new and /pr review do not call gh themselves");
    assert.match(turns[0], /action "create"/);
    assert.match(turns[0], /Do not merge/);
    assert.match(turns[1], /#8/);
    assert.match(turns[1], /decision "comment"/);
    assert.match(notices.at(-1)!, /Usage: \/pr review/);

    notices.length = 0;
    await handlePrCommand("", ctx, d);
    assert.match(notices.at(-1)!, /PR #7/);
    assert.match(notices.at(-1)!, /https:\/\/github.com\/o\/r\/pull\/7/);

    notices.length = 0;
    await handleIssuesCommand("", ctx, d);
    assert.match(notices.at(-1)!, /#4 {2}Tools/);
    assert.ok(calls.some((c) => c.args.includes("@me")));

    notices.length = 0;
    await handleIssuesCommand("9", ctx, d);
    assert.match(notices.at(-1)!, /#9 {2}Nine/);
    assert.match(notices.at(-1)!, /bug/);

    notices.length = 0;
    await handleIssuesCommand("9 start", ctx, d);
    assert.match(notices.at(-1)!, /On issue-9-start for issue #9/);
    assert.equal(run(dir, "branch", "--show-current"), "issue-9-start");
  });

  test("the four tool definitions stay under 2,500 tokens", async () => {
    const tools: any[] = [];
    const mod = await import("../.pi/extensions/kernal-github/index.ts");
    mod.default({
      registerTool: (t: any) => { tools.push(t); },
      registerCommand: () => {},
      on: () => {},
    } as any);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["git", "github_issue", "github_pr", "github_repo"]);
    const tokens = (t: any) => Math.ceil(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length / 4);
    const sum = tools.reduce((n, t) => n + tokens(t), 0);
    assert.ok(sum < 2500, `four tools are ~${sum} tokens`);
    for (const t of tools) {
      if (t.promptSnippet) assert.ok(t.promptSnippet.length < 200, t.name);
      for (const line of t.promptGuidelines ?? []) assert.match(line, new RegExp(t.name === "git" ? "\\bgit\\b" : t.name, "i"), line);
    }
  });

  test("a fake gh on PATH is enough: argv is recorded and stdin is closed", async () => {
    const bin = temp(mkdtempSync(join(tmpdir(), "kernal-fake-gh-")));
    const log = join(bin, "argv.log");
    const stdinLog = join(bin, "stdin.log");
    const canned = join(bin, "canned.json");
    // No extension: Node treats a shebang file named `gh` as CommonJS, which is what `gh` on PATH is.
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_ARGV_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  process.stdout.write("gh version 9.9.9 (test)\\n", () => process.exit(0));
  return;
}
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.GH_STDIN_LOG, JSON.stringify(stdin) + "\\n");
  const rows = JSON.parse(fs.readFileSync(process.env.GH_CANNED, "utf8"));
  const hit = rows.find((row) => row.match.every((part, i) => args[i] === part));
  if (!hit) { process.stderr.write("no canned response for " + JSON.stringify(args) + "\\n"); process.exit(2); }
  process.stdout.write(hit.stdout ?? "", () => process.exit(hit.code ?? 0));
});
`);
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(canned, JSON.stringify([{ match: ["release", "list"], stdout: JSON.stringify([{ tagName: "v9", name: "v9", url: "u" }]) }]));
    const prevPath = process.env.PATH;
    const prev = { argv: process.env.GH_ARGV_LOG, stdin: process.env.GH_STDIN_LOG, canned: process.env.GH_CANNED };
    process.env.PATH = `${bin}:${prevPath}`;
    process.env.GH_ARGV_LOG = log;
    process.env.GH_STDIN_LOG = stdinLog;
    process.env.GH_CANNED = canned;
    try {
      const found = await findGh();
      assert.equal(found?.path, "gh");
      const dir = repo();
      const res = await executeGithub("github_repo", { action: "releases" }, { cwd: dir, settings: {}, gh: found });
      assert.equal(res.isError, undefined, res.text);
      assert.equal(res.data[0].tagName, "v9");
      const argv = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(argv.some((a: string[]) => a[0] === "--version"));
      assert.ok(argv.some((a: string[]) => a[0] === "release" && a[1] === "list" && a.includes("--json")));
      const stdins = readFileSync(stdinLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(stdins.every((s: string) => s === ""), "stdin is closed, not left waiting");
    } finally {
      process.env.PATH = prevPath;
      if (prev.argv === undefined) delete process.env.GH_ARGV_LOG; else process.env.GH_ARGV_LOG = prev.argv;
      if (prev.stdin === undefined) delete process.env.GH_STDIN_LOG; else process.env.GH_STDIN_LOG = prev.stdin;
      if (prev.canned === undefined) delete process.env.GH_CANNED; else process.env.GH_CANNED = prev.canned;
    }
  });
});
