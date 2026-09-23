/**
 * github.confirm: the setting, which calls are reads / writes / merges / pushes, and when the
 * gate asks. Nobody present means refuse without calling ask, so a headless run cannot hang on a dialog.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGithub, excludeToolsFor, gateGithub, githubConfirmFrom, githubToolsAllows, type GithubClass, type GithubConfirm } from "../.pi/extensions/kernal-github/confirm.ts";
import { readAgent, saveAgent, snapshot } from "../.pi/extensions/kernal-admin/subagents.ts";

describe("githubConfirmFrom", () => {
  test("missing or unknown is none", () => {
    for (const s of [undefined, null, {}, { github: {} }, { github: { confirm: "" } }, { github: { confirm: "ask" } }, { github: { confirm: 1 } }, { github: { confirm: "NONE" } }]) {
      assert.equal(githubConfirmFrom(s), "none");
    }
  });

  test("none, merge, and writes pass through", () => {
    assert.equal(githubConfirmFrom({ github: { confirm: "none" } }), "none");
    assert.equal(githubConfirmFrom({ github: { confirm: "merge" } }), "merge");
    assert.equal(githubConfirmFrom({ github: { confirm: "  writes  " } }), "writes");
  });
});

describe("classifyGithub", () => {
  const read: [string, string][] = [
    ["github_pr", "view"], ["github_pr", "list"], ["github_pr", "checks"], ["github_pr", "wait_ci"],
    ["github_issue", "list"], ["github_issue", "view"],
    ["github_repo", "view"], ["github_repo", "search"], ["github_repo", "releases"],
    ["git", "status"], ["git", "diff"], ["git", "log"],
  ];
  const write: [string, string][] = [
    ["github_pr", "create"], ["github_pr", "edit"], ["github_pr", "comment"], ["github_pr", "reply"], ["github_pr", "resolve"], ["github_pr", "checkout"],
    ["github_issue", "create"], ["github_issue", "comment"], ["github_issue", "edit"], ["github_issue", "close"], ["github_issue", "reopen"], ["github_issue", "start"],
    ["git", "commit"], ["git", "pull"], ["git", "branch"], ["git", "stash"],
  ];

  test("reads, writes, merge, and push", () => {
    for (const [tool, action] of read) assert.equal(classifyGithub(tool, action), "read", `${tool} ${action}`);
    for (const [tool, action] of write) assert.equal(classifyGithub(tool, action), "write", `${tool} ${action}`);
    assert.equal(classifyGithub("github_pr", "merge"), "merge");
    assert.equal(classifyGithub("git", "push"), "push");
  });

  test("a review is a write unless it approves or requests changes", () => {
    assert.equal(classifyGithub("github_pr", "review"), "write");
    assert.equal(classifyGithub("github_pr", "review", {}), "write");
    assert.equal(classifyGithub("github_pr", "review", { decision: "comment" }), "write");
    assert.equal(classifyGithub("github_pr", "review", { decision: "approve" }), "merge");
    assert.equal(classifyGithub("github_pr", "review", { decision: "request-changes" }), "merge");
    assert.equal(classifyGithub("github_pr", "review", { decision: "Request Changes" }), "merge");
  });

  test("an action the table does not name is a write, and merge still allows it", async () => {
    assert.equal(classifyGithub("github_pr", "delete"), "write");
    const unnamed = await gateGithub({ confirm: "merge", cls: classifyGithub("github_pr", "delete"), personPresent: false });
    assert.deepEqual(unnamed, { ok: true });
  });

  test("wait_ci is a read, and per-agent access follows off, read, and full", () => {
    assert.equal(classifyGithub("github_pr", "wait_ci"), "read");
    assert.equal(githubToolsAllows("off", "git", "status"), false);
    assert.equal(githubToolsAllows("read", "git", "status"), true);
    assert.equal(githubToolsAllows("read", "git", "push"), false);
    assert.equal(githubToolsAllows("read", "github_pr", "wait_ci"), true);
    assert.equal(githubToolsAllows("full", "git", "push"), true);
    assert.deepEqual(excludeToolsFor("off", ["bash"]), ["bash", "git", "github_pr", "github_issue", "github_repo"]);
    assert.deepEqual(excludeToolsFor("read", ["bash", "git"]), ["bash"]);
    assert.deepEqual(excludeToolsFor("full", ["git", "bash"]), ["bash"]);
  });
});

describe("gateGithub", () => {
  const asked = async (confirm: GithubConfirm, cls: GithubClass, personPresent: boolean, answer = true) => {
    let calls = 0;
    const result = await gateGithub({
      confirm, cls, personPresent,
      ask: async () => { calls++; return answer; },
    });
    return { result, calls };
  };

  test("none and every read proceed without asking", async () => {
    for (const cls of ["read", "write", "merge", "push"] as const) {
      const r = await asked("none", cls, true);
      assert.deepEqual(r.result, { ok: true });
      assert.equal(r.calls, 0);
    }
    for (const confirm of ["none", "merge", "writes"] as const) {
      const r = await asked(confirm, "read", false);
      assert.deepEqual(r.result, { ok: true });
      assert.equal(r.calls, 0);
    }
  });

  test("merge asks only for a merge, and writes asks for a write, a merge, and a push", async () => {
    for (const cls of ["write", "push"] as const) {
      const r = await asked("merge", cls, true);
      assert.deepEqual(r.result, { ok: true });
      assert.equal(r.calls, 0, cls);
    }
    const merge = await asked("merge", "merge", true);
    assert.deepEqual(merge.result, { ok: true });
    assert.equal(merge.calls, 1);

    for (const cls of ["write", "merge", "push"] as const) {
      const r = await asked("writes", cls, true, true);
      assert.deepEqual(r.result, { ok: true });
      assert.equal(r.calls, 1, cls);
    }
  });

  test("nobody present is a refusal that names github.confirm, and ask is not called", async () => {
    let calls = 0;
    const result = await gateGithub({
      confirm: "writes", cls: "push", personPresent: false,
      ask: async () => { calls++; return true; },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /github\.confirm/);
    assert.equal(calls, 0);
  });

  test("a person saying no refuses, and a missing ask does not throw", async () => {
    const no = await asked("merge", "merge", true, false);
    assert.equal(no.result.ok, false);
    assert.equal(no.calls, 1);
    const missing = await gateGithub({ confirm: "writes", cls: "write", personPresent: true });
    assert.equal(missing.ok, false);
  });
});

describe("per-agent githubTools", () => {
  const pkg = join(import.meta.dirname, "..", ".pi", "npm", "node_modules", "pi-subagents");
  const noPkg = !existsSync(join(pkg, "src", "agents", "agents.js")) && "pi-subagents is not installed";
  const edit = (over: Record<string, unknown> = {}) => ({
    mode: "create" as const, scope: "user" as const, name: "helper", description: "Finds things",
    tools: ["read"], model: "", thinking: "", prompt: "Find things.\n", ...over,
  });

  test("frontmatter githubTools round-trips, and a missing key is off", { skip: noPkg }, async () => {
    const root = mkdtempSync(join(tmpdir(), "kernal-gh-tools-"));
    const prevPkg = process.env.KERNAL_SUBAGENTS_PKG;
    const prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.KERNAL_SUBAGENTS_PKG = pkg;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    mkdirSync(join(root, "agent", "agents"), { recursive: true });
    const ctx = { cwd: root, modelRegistry: { getAvailable: () => [] } };
    try {
      await saveAgent(ctx, edit({ name: "quiet", githubTools: "off" }), []);
      const quiet = readFileSync(join(root, "agent", "agents", "quiet.md"), "utf8");
      assert.match(quiet, /^githubTools: off$/m);
      assert.match(quiet, /^excludeTools:.*\bgit\b/m);
      await saveAgent(ctx, edit({ githubTools: "read" }), []);
      const file = join(root, "agent", "agents", "helper.md");
      const helper = readFileSync(file, "utf8");
      assert.match(helper, /^githubTools: read$/m);
      assert.equal(/^excludeTools:.*\bgit\b/m.test(helper), false);
      const snap = await snapshot(root, undefined, []);
      const read = await readAgent(snap, "helper", "user", []);
      assert.equal(read && !read.withheld && read.fields.githubTools, "read");
      assert.equal(read && !read.withheld && read.extra.githubTools, undefined, "not a second copy under other fields");

      await saveAgent(ctx, edit({ mode: "update", original: "helper", githubTools: "full" }), []);
      assert.match(readFileSync(file, "utf8"), /^githubTools: full$/m);
      assert.equal((readFileSync(file, "utf8").match(/^githubTools:/gm) ?? []).length, 1);

      await saveAgent(ctx, edit({ mode: "update", original: "helper", description: "Finds more" }), []);
      assert.match(readFileSync(file, "utf8"), /^githubTools: full$/m, "a save that does not mention it keeps the choice");

      const plain = join(root, "agent", "agents", "plain.md");
      writeFileSync(plain, "---\nname: plain\ndescription: No GitHub line\ntools: read\n---\n\nFind things.\n");
      const omitted = await readAgent(await snapshot(root, undefined, []), "plain", "user", []);
      assert.equal(omitted && !omitted.withheld && omitted.fields.githubTools, "off");
      assert.equal(readFileSync(plain, "utf8").includes("githubTools"), false, "reading does not write the shipped default onto the file");
    } finally {
      if (prevPkg === undefined) delete process.env.KERNAL_SUBAGENTS_PKG; else process.env.KERNAL_SUBAGENTS_PKG = prevPkg;
      if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
