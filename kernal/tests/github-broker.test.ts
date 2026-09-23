/**
 * Cloud broker: GitHub tool actions go to OUTFITTER_GITHUB_SOCKET, not gh. A fake Unix socket
 * stands in for agentd. Nothing here touches the network.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Exec } from "../.pi/extensions/kernal-github/gh.ts";
import { executeGithub, type GithubDeps } from "../.pi/extensions/kernal-github/github-tools.ts";
import { runAction } from "../.pi/extensions/kernal-github/lib.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.invalid" };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

const SHA_A = "a".repeat(40);
const PR = {
  number: 7, title: "Add tools", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false,
  headRefOid: SHA_A, baseRefName: "main", reviewDecision: "REVIEW_REQUIRED", author: { login: "ada" },
  statusCheckRollup: [{ name: "test", conclusion: "SUCCESS", status: "COMPLETED" }],
};

const trash: string[] = [];
after(() => { for (const d of trash) rmSync(d, { recursive: true, force: true }); });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kernal-broker-"));
  trash.push(dir);
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

type Req = { t: string; reqId: string; op: string; args: Record<string, unknown>; idempotencyKey?: string };

function ghOf(respond: (args: string[], stdin: string | undefined) => { stdout?: string; stderr?: string; code?: number }) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const exec: Exec = async (_cmd, args, opts) => {
    calls.push({ args: [...args], stdin: opts.stdin });
    const hit = respond(args, opts.stdin);
    return { stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", code: hit.code ?? 0 };
  };
  return { calls, gh: { path: "gh", exec } };
}

/** Records a call if the broker path falls through to gh. */
function ghTrap() {
  return ghOf(() => ({ code: 1, stderr: "gh should not run" }));
}

let sockets = 0;
function serve(onReq: (req: Req, socket: Socket) => void): Promise<{ path: string; requests: Req[]; close: () => Promise<void> }> {
  const path = `/tmp/kernal-gh-${process.pid}-${sockets++}.sock`;
  const requests: Req[] = [];
  const server: Server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        const req = JSON.parse(line) as Req;
        requests.push(req);
        onReq(req, socket);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      resolve({
        path,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => { rmSync(path, { force: true }); done(); });
        }),
      });
    });
  });
}

function reply(socket: Socket, req: Req, body: { ok: true; data: unknown } | { ok: false; error: string }) {
  socket.write(`${JSON.stringify({ t: "github.result", reqId: req.reqId, ...body })}\n`);
}

const cloud = (dir: string, socketPath: string, extra: Partial<GithubDeps> = {}): GithubDeps => ({
  cwd: dir,
  settings: {},
  ...extra,
  env: { OUTFITTER_GITHUB_SOCKET: socketPath, ...(extra.env ?? {}) },
});

describe("github broker", { concurrency: 1 }, () => {
  test("a view goes to the socket and not gh, and the model sees the same text", async () => {
    const dir = repo();
    const localGh = ghOf(() => ({ stdout: JSON.stringify(PR) }));
    const local = await executeGithub("github_pr", { action: "view", number: 7 }, { cwd: dir, settings: {}, gh: localGh.gh, env: {} });
    assert.equal(local.isError, undefined, local.text);

    const trap = ghTrap();
    const server = await serve((req, socket) => reply(socket, req, { ok: true, data: { ...PR, rateLimit: { remaining: 4000 } } }));
    try {
      const res = await executeGithub("github_pr", { action: "view", number: 7 }, cloud(dir, server.path, { gh: trap.gh }));
      assert.equal(res.isError, undefined, res.text);
      assert.equal(res.text, local.text);
      assert.doesNotMatch(res.text, /rateLimit/);
      assert.equal(trap.calls.length, 0);
      assert.equal(server.requests.length, 1);
      const req = server.requests[0]!;
      assert.equal(req.t, "github.request");
      assert.equal(req.op, "github_pr.view");
      assert.equal(typeof req.reqId, "string");
      assert.deepEqual(req.args, { number: 7 });
      assert.equal("idempotencyKey" in req, false);
    } finally {
      await server.close();
    }
  });

  test("a write sends one idempotencyKey and the same body the local path would", async () => {
    const dir = repo();
    const localGh = ghOf(() => ({ stdout: "https://github.com/o/r/pull/9\n" }));
    const local = await executeGithub("github_pr", { action: "create", title: "T", body: "Already written" }, { cwd: dir, settings: {}, gh: localGh.gh, env: {} });
    assert.equal(local.isError, undefined, local.text);

    const trap = ghTrap();
    const server = await serve((req, socket) => reply(socket, req, { ok: true, data: { url: "https://github.com/o/r/pull/9" } }));
    try {
      const res = await executeGithub("github_pr", { action: "create", title: "T", body: "Already written" }, cloud(dir, server.path, { gh: trap.gh }));
      assert.equal(res.isError, undefined, res.text);
      assert.equal(res.text, local.text);
      assert.equal(trap.calls.length, 0);
      assert.equal(server.requests.length, 1);
      const req = server.requests[0]!;
      assert.equal(req.op, "github_pr.create");
      assert.equal(req.args.title, "T");
      assert.equal(req.args.body, localGh.calls[0]?.stdin);
      assert.equal(typeof req.idempotencyKey, "string");
      assert.ok((req.idempotencyKey ?? "").length >= 8);
    } finally {
      await server.close();
    }
  });

  test("merge pins with a read, then a write that carries the key", async () => {
    const dir = repo();
    const head = JSON.stringify({ headRefOid: SHA_A, url: "https://github.com/o/r/pull/7" });
    const localGh = ghOf((args) => args[1] === "merge" ? { stdout: "Merged.\n" } : { stdout: head });
    const params = { action: "merge", number: 7, method: "squash", sha: SHA_A };
    const local = await executeGithub("github_pr", params, { cwd: dir, settings: {}, gh: localGh.gh, env: {} });
    assert.equal(local.isError, undefined, local.text);

    const trap = ghTrap();
    const server = await serve((req, socket) => {
      if (req.op === "github_pr.merge") reply(socket, req, { ok: true, data: { detail: "Merged." } });
      else reply(socket, req, { ok: true, data: { headRefOid: SHA_A, url: "https://github.com/o/r/pull/7", number: 7 } });
    });
    try {
      const res = await executeGithub("github_pr", params, cloud(dir, server.path, { gh: trap.gh }));
      assert.equal(res.isError, undefined, res.text);
      assert.equal(res.text, local.text);
      assert.equal(trap.calls.length, 0);
      assert.deepEqual(server.requests.map((r) => r.op), ["github_pr.view", "github_pr.merge"]);
      assert.equal("idempotencyKey" in server.requests[0]!, false);
      assert.equal(typeof server.requests[1]?.idempotencyKey, "string");
      assert.equal(server.requests[1]?.args.method, "squash");
      assert.equal(server.requests[1]?.args.sha, SHA_A);
    } finally {
      await server.close();
    }
  });

  test("checkout, issue start, and branch create/switch are refused locally", async () => {
    const dir = repo();
    const trap = ghTrap();
    const server = await serve((req, socket) => reply(socket, req, { ok: false, error: "should not be called" }));
    const sentence = "this cloud session works on the session branch";
    try {
      const checkout = await executeGithub("github_pr", { action: "checkout", number: 7 }, cloud(dir, server.path, { gh: trap.gh }));
      assert.equal(checkout.isError, true);
      assert.equal(checkout.text, sentence);
      const started = await executeGithub("github_issue", { action: "start", number: 4 }, cloud(dir, server.path, { gh: trap.gh }));
      assert.equal(started.isError, true);
      assert.equal(started.text, sentence);
      const named = await executeGithub("github_pr", { action: "checkout", number: 7 }, cloud(dir, server.path, {
        gh: trap.gh,
        env: { OUTFITTER_SESSION_BRANCH: "outfitter/s1" },
      }));
      assert.equal(named.text, "this cloud session works on outfitter/s1");

      const env = { OUTFITTER_GITHUB_SOCKET: server.path };
      const created = await runAction("branch", { op: "create", name: "other" }, { cwd: dir, settings: {}, gh: undefined, env });
      assert.equal(created.isError, true);
      assert.equal(created.text, sentence);
      const switched = await runAction("branch", { op: "switch", name: "other" }, { cwd: dir, settings: {}, gh: undefined, env });
      assert.equal(switched.text, sentence);
      const listed = await runAction("branch", { op: "list" }, { cwd: dir, settings: {}, gh: undefined, env });
      assert.equal(listed.isError, undefined);
      assert.match(listed.text, /\* main/);

      assert.equal(run(dir, "branch", "--show-current"), "main");
      assert.equal(run(dir, "branch", "--list", "other"), "");
      assert.equal(server.requests.length, 0);
      assert.equal(trap.calls.length, 0);
    } finally {
      await server.close();
    }
  });

  test("an unset socket still uses gh", async () => {
    const dir = repo();
    const { calls, gh } = ghOf(() => ({ stdout: JSON.stringify(PR) }));
    const res = await executeGithub("github_pr", { action: "view", number: 7 }, { cwd: dir, settings: {}, gh, env: {} });
    assert.equal(res.isError, undefined, res.text);
    assert.equal(res.data.number, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.args[0], "pr");
    assert.equal(calls[0]?.args[1], "view");
  });

  test("a refused result is the tool error", async () => {
    const dir = repo();
    const trap = ghTrap();
    const server = await serve((req, socket) => reply(socket, req, { ok: false, error: "not permitted" }));
    try {
      const res = await executeGithub("github_pr", { action: "view", number: 7 }, cloud(dir, server.path, { gh: trap.gh }));
      assert.equal(res.isError, true);
      assert.equal(res.text, "not permitted");
      assert.equal(trap.calls.length, 0);
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]?.op, "github_pr.view");
    } finally {
      await server.close();
    }
  });

  test("a read is retried once when the socket closes, and a write is not", async () => {
    const dir = repo();
    let reads = 0;
    const readServer = await serve((req, socket) => {
      reads++;
      if (reads === 1) { socket.destroy(); return; }
      reply(socket, req, { ok: true, data: PR });
    });
    try {
      const trap = ghTrap();
      const res = await executeGithub("github_pr", { action: "view", number: 7 }, cloud(dir, readServer.path, { gh: trap.gh }));
      assert.equal(res.isError, undefined, res.text);
      assert.equal(res.data.number, 7);
      assert.equal(reads, 2);
      assert.equal(trap.calls.length, 0);
      assert.equal(readServer.requests.every((r) => r.op === "github_pr.view" && !("idempotencyKey" in r)), true);
      assert.notEqual(readServer.requests[0]?.reqId, readServer.requests[1]?.reqId);
    } finally {
      await readServer.close();
    }

    let writes = 0;
    const writeServer = await serve((req, socket) => {
      writes++;
      assert.equal(typeof req.idempotencyKey, "string");
      socket.destroy();
    });
    try {
      const res = await executeGithub("github_pr", { action: "comment", number: 7, body: "hello" }, cloud(dir, writeServer.path, { gh: ghTrap().gh }));
      assert.equal(res.isError, true);
      assert.equal(writes, 1);
      assert.equal(writeServer.requests[0]?.op, "github_pr.comment");
    } finally {
      await writeServer.close();
    }
  });

  test("wait_ci polls checks, not a held-open op, and slows when the budget is low", async () => {
    const dir = repo();
    const trap = ghTrap();
    const clock = () => {
      let t = 0;
      const sleeps: number[] = [];
      return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, intervalMs: 1000 };
    };

    const runWait = async (remaining: number) => {
      let n = 0;
      const server = await serve((req, socket) => {
        n++;
        const rollup = n === 1
          ? [{ name: "test", conclusion: null, status: "IN_PROGRESS" }]
          : [{ name: "test", conclusion: "SUCCESS", status: "COMPLETED" }];
        reply(socket, req, { ok: true, data: {
          number: 7, headRefOid: SHA_A, url: "https://github.com/o/r/pull/7", statusCheckRollup: rollup, rateLimit: { remaining },
        } });
      });
      const c = clock();
      try {
        const res = await executeGithub("github_pr", { action: "wait_ci", number: 7, timeout: 30 }, cloud(dir, server.path, { gh: trap.gh, ...c }));
        return { res, requests: server.requests, sleeps: c.sleeps };
      } finally {
        await server.close();
      }
    };

    const slow = await runWait(5);
    assert.equal(slow.res.data.result, "pass");
    assert.equal(slow.res.isError, undefined);
    assert.doesNotMatch(slow.res.text, /rateLimit/);
    assert.deepEqual(slow.sleeps, [6000]);
    assert.deepEqual(slow.requests.map((r) => r.op), ["github_pr.checks", "github_pr.checks"]);
    assert.equal(slow.requests.some((r) => "idempotencyKey" in r || r.op === "github_pr.wait_ci"), false);

    const normal = await runWait(500);
    assert.equal(normal.res.data.result, "pass");
    assert.deepEqual(normal.sleeps, [1000]);

    const lines = ["SHOULD_NOT_SEE", "FAIL_TAIL_MARKER"].join("\n");
    const failServer = await serve((req, socket) => reply(socket, req, { ok: true, data: {
      number: 8, headRefOid: SHA_A, url: "https://github.com/o/r/pull/8",
      statusCheckRollup: [{ name: "test", conclusion: "FAILURE", status: "COMPLETED", detailsUrl: "https://github.com/o/r/actions/runs/55/job/1" }],
      log: lines,
    } }));
    try {
      const failed = await executeGithub("github_pr", { action: "wait_ci", number: 8, timeout: 30 }, cloud(dir, failServer.path, {
        gh: trap.gh, intervalMs: 1000, now: () => 0, sleep: async () => {},
      }));
      assert.equal(failed.data.result, "fail");
      assert.deepEqual(failed.data.failed, ["test"]);
      assert.match(failed.data.log, /FAIL_TAIL_MARKER/);
      assert.equal(failServer.requests.every((r) => r.op === "github_pr.checks"), true);
    } finally {
      await failServer.close();
    }
    assert.equal(trap.calls.length, 0);
  });
});
