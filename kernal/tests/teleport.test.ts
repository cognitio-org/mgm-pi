import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GitStore, parseOwnerRepo, rewriteHeaderCwd, pickModelForHost, manifestFromGit, describeRef,
  isWorkingTreeDirty, needsPush, needsOriginBranch, verifyOwnerRepo, findSessionFileForId, FALLBACK_MODEL,
  type ExecFn, type Manifest,
  defaultStoreDir,
} from "../.pi/extensions/teleport/lib.ts";

describe("parseOwnerRepo", () => {
  test("https, with and without .git", () => {
    assert.equal(parseOwnerRepo("https://github.com/o/r"), "o/r");
    assert.equal(parseOwnerRepo("https://github.com/o/r.git"), "o/r");
    assert.equal(parseOwnerRepo("https://github.com/o/r/"), "o/r");
  });
  test("scp-like git@host:owner/repo.git", () => {
    assert.equal(parseOwnerRepo("git@github.com:o/r.git"), "o/r");
    assert.equal(parseOwnerRepo("git@github.com:o/r"), "o/r");
  });
  test("ssh:// URL", () => {
    assert.equal(parseOwnerRepo("ssh://git@host/o/r"), "o/r");
    assert.equal(parseOwnerRepo("ssh://git@host/o/r.git"), "o/r");
  });
  test("unrecognized input returns undefined", () => {
    assert.equal(parseOwnerRepo("not a remote"), undefined);
  });
});

describe("rewriteHeaderCwd", () => {
  test("replaces only the header line's cwd, byte-identical rest", () => {
    const jsonl = `{"type":"session","version":3,"id":"abc","cwd":"/old"}\n{"type":"message","id":"1"}\n{"type":"message","id":"2"}\n`;
    const out = rewriteHeaderCwd(jsonl, "/new");
    const lines = out.split("\n");
    assert.deepEqual(JSON.parse(lines[0]), { type: "session", version: 3, id: "abc", cwd: "/new" });
    assert.equal(lines[1], `{"type":"message","id":"1"}`);
    assert.equal(lines[2], `{"type":"message","id":"2"}`);
    assert.equal(out.slice(out.indexOf("\n")), jsonl.slice(jsonl.indexOf("\n")));
  });
  test("handles a header-only file with no trailing newline", () => {
    const jsonl = `{"type":"session","cwd":"/old"}`;
    assert.equal(rewriteHeaderCwd(jsonl, "/new"), `{"type":"session","cwd":"/new"}`);
  });
});

describe("pickModelForHost", () => {
  test("uses the last model_change when its provider is available", () => {
    const entries = [
      { type: "model_change", provider: "lmstudio", modelId: "qwen" },
      { type: "message" },
      { type: "model_change", provider: "litellm", modelId: "claude-sonnet-5" },
    ];
    assert.deepEqual(pickModelForHost(entries, ["litellm", "openrouter"]), { provider: "litellm", modelId: "claude-sonnet-5" });
  });
  test("falls back to the cloud default when the last model's provider is unavailable", () => {
    const entries = [{ type: "model_change", provider: "lmstudio", modelId: "qwen/qwen3.6-35b-a3b" }];
    assert.deepEqual(pickModelForHost(entries, ["litellm"]), FALLBACK_MODEL);
  });
  test("falls back when there is no model_change at all", () => {
    assert.deepEqual(pickModelForHost([{ type: "message" }], ["litellm"]), FALLBACK_MODEL);
  });
});

describe("manifestFromGit", () => {
  test("builds a repo section from full git info", () => {
    const m = manifestFromGit({ id: "abc", host: "mac", cwd: "/repo", git: { remote: "git@github.com:o/r.git", branch: "main", head: "deadbeef" }, pushedAt: "2026-09-20T00:00:00.000Z" });
    assert.deepEqual(m, { id: "abc", name: undefined, host: "mac", cwd: "/repo", pushedAt: "2026-09-20T00:00:00.000Z", repo: { remote: "git@github.com:o/r.git", ownerRepo: "o/r", branch: "main", head: "deadbeef" } });
  });
  test("omits repo when there is no git info", () => {
    const m = manifestFromGit({ id: "abc", host: "mac", cwd: "/tmp", pushedAt: "now" });
    assert.equal(m.repo, undefined);
  });
});

describe("describeRef", () => {
  test("prefers name and repo@branch, falls back to id and cwd", () => {
    const recent = new Date().toISOString();
    assert.equal(
      describeRef({ id: "12345678", name: "fix auth", repo: "o/r", branch: "main", cwd: "/x", updatedAt: recent, host: "mac" }),
      "fix auth  —  o/r@main  ·  mac  ·  just now",
    );
    assert.match(
      describeRef({ id: "12345678abcd", cwd: "/somewhere", updatedAt: recent, host: "mac" }),
      /^12345678  —  \/somewhere  ·  mac  ·  just now$/,
    );
  });
});

describe("isWorkingTreeDirty", () => {
  test("empty output is clean", () => assert.equal(isWorkingTreeDirty(""), false));
  test("any output is dirty", () => assert.equal(isWorkingTreeDirty(" M file.ts\n"), true));
});

describe("needsPush", () => {
  test("no upstream line means push needed", () => {
    assert.equal(needsPush("# branch.oid abc\n# branch.head main\n"), true);
  });
  test("upstream with ahead commits means push needed", () => {
    assert.equal(needsPush("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0\n"), true);
  });
  test("upstream with nothing ahead means no push needed", () => {
    assert.equal(needsPush("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n"), false);
    const trackingMain = "# branch.oid abc\n# branch.head feature\n# branch.upstream origin/main\n# branch.ab +0 -0\n";
    assert.equal(needsOriginBranch(trackingMain, "feature"), true, "upstream is origin/main, not origin/feature");
    assert.equal(needsOriginBranch("# branch.oid abc\n# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +0 -0\n", "feature"), false);
  });
});

describe("verifyOwnerRepo", () => {
  test("matching repo is fine", () => assert.equal(verifyOwnerRepo("o/r", "o/r"), undefined));
  test("mismatched repo names both", () => {
    const msg = verifyOwnerRepo("o/other", "o/r");
    assert.match(msg!, /o\/r/);
    assert.match(msg!, /o\/other/);
  });
  test("no local repo still names the expected one", () => {
    assert.match(verifyOwnerRepo(undefined, "o/r")!, /o\/r/);
  });
});

describe("findSessionFileForId", () => {
  test("matches the trailing _<id>.jsonl", () => {
    const files = ["2024-01-01T00-00-00_abc123.jsonl", "2024-01-02T00-00-00_def456.jsonl"];
    assert.equal(findSessionFileForId(files, "abc123"), files[0]);
    assert.equal(findSessionFileForId(files, "nope"), undefined);
  });
});

// ---------- GitStore ----------

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "teleport-store-"));
}

/** Records every exec call and answers just enough to drive GitStore through its git calls
 * without touching the network or a real git binary. */
function fakeExec(opts: { hasRemote?: boolean; pullFails?: boolean; pushFails?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== "git") return { stdout: "", stderr: "", code: 0 };
    const [sub] = args;
    if (sub === "remote") return { stdout: opts.hasRemote ? "origin\n" : "", stderr: "", code: 0 };
    if (sub === "pull") return opts.pullFails ? { stdout: "", stderr: "offline", code: 1 } : { stdout: "", stderr: "", code: 0 };
    if (sub === "push") return opts.pushFails ? { stdout: "", stderr: "offline", code: 1 } : { stdout: "", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  return { exec, calls };
}

const manifest: Manifest = { id: "sess1", host: "mac", cwd: "/proj", pushedAt: "2026-09-20T00:00:00.000Z", repo: { remote: "git@github.com:o/r.git", ownerRepo: "o/r", branch: "main", head: "abc" } };

describe("GitStore", () => {
  test("list() on an empty store returns []", async () => {
    const dir = await tmpDir();
    const { exec } = fakeExec({ hasRemote: false });
    const store = new GitStore({ dir, exec, host: "mac" });
    assert.deepEqual(await store.list(), []);
  });

  test("put() writes session + manifest + index and commits", async () => {
    const dir = await tmpDir();
    const { exec, calls } = fakeExec({ hasRemote: false });
    const store = new GitStore({ dir, exec, host: "mac" });
    await store.put("sess1", '{"type":"session","cwd":"/proj"}\n', manifest);

    assert.equal(await readFile(join(dir, "sessions", "sess1.jsonl"), "utf8"), '{"type":"session","cwd":"/proj"}\n');
    const savedManifest = JSON.parse(await readFile(join(dir, "sessions", "sess1.json"), "utf8"));
    assert.equal(savedManifest.id, "sess1");
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    assert.equal(index.length, 1);
    assert.equal(index[0].repo, "o/r");
    assert.equal(index[0].branch, "main");

    const subcommands = calls.filter((c) => c[0] === "git").map((c) => c[1]);
    assert.ok(subcommands.includes("add"));
    assert.ok(subcommands.includes("commit"));
    assert.ok(!subcommands.includes("push"), "no remote configured, so no push attempted");
  });

  test("put() pushes when a remote is configured", async () => {
    const dir = await tmpDir();
    const { exec, calls } = fakeExec({ hasRemote: true });
    const store = new GitStore({ dir, exec, host: "mac" });
    await store.put("sess1", "{}\n", manifest);
    assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
  });

  test("put() replaces an existing id's index entry instead of duplicating it", async () => {
    const dir = await tmpDir();
    const { exec } = fakeExec({ hasRemote: false });
    const store = new GitStore({ dir, exec, host: "mac" });
    await store.put("sess1", "{}\n", manifest);
    await store.put("sess1", "{}\n", { ...manifest, pushedAt: "2026-09-21T00:00:00.000Z" });
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    assert.equal(index.length, 1);
    assert.equal(index[0].updatedAt, "2026-09-21T00:00:00.000Z");
  });

  test("get() returns the jsonl text and parsed manifest written by put()", async () => {
    const dir = await tmpDir();
    const { exec } = fakeExec({ hasRemote: false });
    const store = new GitStore({ dir, exec, host: "mac" });
    await store.put("sess1", '{"type":"session"}\n', manifest);
    const { file, manifest: got } = await store.get("sess1");
    assert.equal(file, '{"type":"session"}\n');
    assert.equal(got.id, "sess1");
    assert.equal(got.repo?.ownerRepo, "o/r");
  });

  test("list()/get() pull first when a remote exists, and warn instead of throwing when pull fails offline", async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "index.json"), JSON.stringify([{ id: "sess1", cwd: "/proj", updatedAt: "2026-09-20T00:00:00.000Z", host: "mac" }]), "utf8");
    await writeFile(join(dir, ".git"), "", "utf8"); // presence check only; exec is stubbed so git never really runs
    const { exec, calls } = fakeExec({ hasRemote: true, pullFails: true });
    const warnings: string[] = [];
    const store = new GitStore({ dir, exec, host: "mac", warn: (m) => warnings.push(m) });

    const refs = await store.list();
    assert.equal(refs.length, 1, "falls back to the local index");
    assert.ok(calls.some((c) => c[0] === "git" && c[1] === "pull"));
    assert.ok(warnings.some((w) => /offline/.test(w)));
  });

  test("list() sorts by updatedAt descending", async () => {
    const dir = await tmpDir();
    const { exec } = fakeExec({ hasRemote: false });
    const store = new GitStore({ dir, exec, host: "mac" });
    await store.put("older", "{}\n", { ...manifest, id: "older", pushedAt: "2026-09-01T00:00:00.000Z" });
    await store.put("newer", "{}\n", { ...manifest, id: "newer", pushedAt: "2026-09-19T00:00:00.000Z" });
    const refs = await store.list();
    assert.deepEqual(refs.map((r) => r.id), ["newer", "older"]);
  });

  test("put() pulls --ff-only before writing, and merges into the index that pull brought in", async () => {
    const dir = await tmpDir();
    // A stale local index, as if this clone hasn't synced since another machine pushed.
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "index.json"), JSON.stringify([{ id: "stale", cwd: "/x", updatedAt: "2020-01-01T00:00:00.000Z", host: "other" }]), "utf8");
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "git") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "remote") return { stdout: "origin\n", stderr: "", code: 0 };
      if (args[0] === "pull" && args.includes("--ff-only")) {
        // Simulate the pull fast-forwarding in a session another machine pushed meanwhile.
        await writeFile(join(dir, "index.json"), JSON.stringify([
          { id: "stale", cwd: "/x", updatedAt: "2020-01-01T00:00:00.000Z", host: "other" },
          { id: "fromRemote", cwd: "/y", updatedAt: "2026-09-19T00:00:00.000Z", host: "other" },
        ]), "utf8");
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const store = new GitStore({ dir, exec, host: "mac" });
    await store.put("sess1", "{}\n", manifest);

    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    const ids = index.map((r: any) => r.id);
    assert.ok(ids.includes("fromRemote"), "the ref that arrived via pull survives into the merged index");
    assert.ok(ids.includes("stale"));
    assert.ok(ids.includes("sess1"));

    const subcommands = calls.filter((c) => c[0] === "git").map((c) => c[1]);
    assert.ok(subcommands.indexOf("pull") !== -1 && subcommands.indexOf("pull") < subcommands.indexOf("add"), "pull happens before add/commit");
  });

  test("put() rebases and retries once when push is rejected, and succeeds", async () => {
    const dir = await tmpDir();
    let pushCalls = 0;
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "git") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "remote") return { stdout: "origin\n", stderr: "", code: 0 };
      if (args[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return { stdout: "", stderr: "! [rejected] main -> main (non-fast-forward)", code: 1 };
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const store = new GitStore({ dir, exec, host: "mac" });
    await assert.doesNotReject(store.put("sess1", "{}\n", manifest));
    assert.equal(pushCalls, 2, "rejected once, then retried after rebasing");
    assert.ok(calls.some((c) => c[0] === "git" && c[1] === "pull" && c.includes("--rebase")));
  });

  test("put() throws when push still fails after the rebase retry, instead of reporting success", async () => {
    const dir = await tmpDir();
    const exec: ExecFn = async (cmd, args) => {
      if (cmd !== "git") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "remote") return { stdout: "origin\n", stderr: "", code: 0 };
      if (args[0] === "push") return { stdout: "", stderr: "offline", code: 1 };
      if (args[0] === "pull" && args.includes("--rebase")) return { stdout: "", stderr: "offline", code: 1 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const store = new GitStore({ dir, exec, host: "mac" });
    await assert.rejects(store.put("sess1", "{}\n", manifest), /pushed locally only/i);
    // The commit still happened locally; it's the push that must be reported as failed.
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    assert.equal(index[0].id, "sess1");
  });
});

describe("defaultStoreDir (pre-rename store folder)", () => {
  test("uses ~/.kernal-sessions on a fresh machine", () => {
    const home = mkdtempSync(join(tmpdir(), "tp-home-"));
    assert.equal(defaultStoreDir(home), join(home, ".kernal-sessions"));
  });
  test("keeps using an existing ~/.mgm-sessions when there is no ~/.kernal-sessions", () => {
    const home = mkdtempSync(join(tmpdir(), "tp-home-"));
    mkdirSync(join(home, ".mgm-sessions"));
    assert.equal(defaultStoreDir(home), join(home, ".mgm-sessions"));
  });
  test("prefers ~/.kernal-sessions once it exists", () => {
    const home = mkdtempSync(join(tmpdir(), "tp-home-"));
    mkdirSync(join(home, ".mgm-sessions"));
    mkdirSync(join(home, ".kernal-sessions"));
    assert.equal(defaultStoreDir(home), join(home, ".kernal-sessions"));
  });
});

describe("teleport extension start-up", () => {
  const load = async (sandbox: boolean) => {
    const store = join(mkdtempSync(join(tmpdir(), "tp-start-")), "store");
    process.env.KERNAL_TELEPORT_STORE = store;
    if (sandbox) process.env.KERNAL_SANDBOX = "1"; else delete process.env.KERNAL_SANDBOX;
    try {
      const { default: teleport } = await import("../.pi/extensions/teleport/index.ts");
      const { makePi } = await import("./harness.ts");
      teleport(makePi() as any);
      await new Promise((r) => setTimeout(r, 1500));   // let a background git init finish if one started
      return existsSync(join(store, ".git"));
    } finally { delete process.env.KERNAL_TELEPORT_STORE; delete process.env.KERNAL_SANDBOX; }
  };
  test("on a laptop the session list is prefetched at load (the store repo gets initialised)", async () => {
    assert.equal(await load(false), true);
  });
  test("in a cloud sandbox (KERNAL_SANDBOX=1) nothing touches git at load", async () => {
    assert.equal(await load(true), false);
  });
});

describe("teleport push offers to commit a dirty tree", () => {
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (cwd: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", env: gitEnv }, (err: any, stdout: string, stderr: string) => {
      resolve({ code: typeof err?.code === "number" ? err.code : err ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
  const piExec = (_cmd: string, args: string[], opts: { cwd: string }) => git(opts.cwd, args);

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), "tp-offer-"));
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    const store = join(root, "store");
    const session = join(root, "session.jsonl");
    await git(root, ["init", "--bare", "-q", origin]);
    await git(root, ["init", "-q", "-b", "main", repo]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README"), "hi\n");
    await git(repo, ["add", "README"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    writeFileSync(session, '{"type":"session"}\n');
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    return { root, origin, repo, store, session, head };
  }

  async function drive(opts: { dirty: boolean; mode: string; accept?: boolean; quiet?: boolean; dropOrigin?: boolean; detach?: boolean }) {
    const env = setup();
    const laid = await env;
    if (opts.dropOrigin) await git(laid.repo, ["remote", "remove", "origin"]);
    if (opts.detach) await git(laid.repo, ["checkout", "--detach", "HEAD"]);
    if (opts.dirty) writeFileSync(join(laid.repo, "notes.txt"), "wip\n");
    const prevStore = process.env.KERNAL_TELEPORT_STORE;
    const prevSandbox = process.env.KERNAL_SANDBOX;
    const prevSession = process.env.OUTFITTER_SESSION_ID;
    const prevAuthor = process.env.GIT_AUTHOR_NAME;
    const prevAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    const prevCommitter = process.env.GIT_COMMITTER_NAME;
    const prevCommitterEmail = process.env.GIT_COMMITTER_EMAIL;
    const prevConfig = process.env.GIT_CONFIG_GLOBAL;
    const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.KERNAL_TELEPORT_STORE = laid.store;
    process.env.KERNAL_SANDBOX = "1";
    delete process.env.OUTFITTER_SESSION_ID;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_AUTHOR_NAME = "Test";
    process.env.GIT_AUTHOR_EMAIL = "test@example.com";
    process.env.GIT_COMMITTER_NAME = "Test";
    process.env.GIT_COMMITTER_EMAIL = "test@example.com";
    const notices: { msg: string; type: string }[] = [];
    let asks = 0;
    try {
      const { default: teleport } = await import("../.pi/extensions/teleport/index.ts");
      const { makePi } = await import("./harness.ts");
      const pi = makePi() as any;
      pi.exec = piExec;
      teleport(pi);
      const ctx = {
        cwd: laid.repo,
        mode: opts.mode,
        settings: { teleport: { autoPush: opts.quiet === true } },
        ui: {
          notify: (msg: string, type = "info") => notices.push({ msg, type }),
          confirm: async () => { asks += 1; return opts.accept === true; },
        },
        sessionManager: {
          getSessionFile: () => laid.session,
          getSessionId: () => "sess94",
          getSessionName: () => "phase4",
        },
      };
      if (opts.quiet) await pi.emit("agent_end", {}, ctx);
      else await pi.commands.get("teleport").handler("push", ctx);
      const head = (await git(laid.repo, ["rev-parse", "HEAD"])).stdout.trim();
      const originRes = await git(laid.repo, ["rev-parse", "origin/main"]);
      const originHead = originRes.code === 0 ? originRes.stdout.trim() : "";
      const subject = (await git(laid.repo, ["log", "-1", "--format=%s"])).stdout.trim();
      return { asks, notices, head, originHead, subject, start: laid.head, stored: existsSync(join(laid.store, "sessions", "sess94.jsonl")) };
    } finally {
      if (prevStore === undefined) delete process.env.KERNAL_TELEPORT_STORE; else process.env.KERNAL_TELEPORT_STORE = prevStore;
      if (prevSandbox === undefined) delete process.env.KERNAL_SANDBOX; else process.env.KERNAL_SANDBOX = prevSandbox;
      if (prevSession === undefined) delete process.env.OUTFITTER_SESSION_ID; else process.env.OUTFITTER_SESSION_ID = prevSession;
      if (prevAuthor === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = prevAuthor;
      if (prevAuthorEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = prevAuthorEmail;
      if (prevCommitter === undefined) delete process.env.GIT_COMMITTER_NAME; else process.env.GIT_COMMITTER_NAME = prevCommitter;
      if (prevCommitterEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL; else process.env.GIT_COMMITTER_EMAIL = prevCommitterEmail;
      if (prevConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevConfig;
      if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
    }
  }

  test("a clean branch teleports without asking", async () => {
    const got = await drive({ dirty: false, mode: "tui" });
    assert.equal(got.asks, 0);
    assert.equal(got.head, got.start);
    assert.equal(got.stored, true);
    assert.equal(got.notices.some((n) => n.msg.includes("Teleported")), true);
  });

  test("accepting the offer commits, pushes, and teleports", async () => {
    const got = await drive({ dirty: true, mode: "tui", accept: true });
    assert.equal(got.asks, 1);
    assert.notEqual(got.head, got.start);
    assert.equal(got.originHead, got.head);
    assert.equal(got.stored, true);
    assert.equal(got.subject, "Commit local changes before teleporting this session.");
  });

  test("declining leaves the tree and does not teleport", async () => {
    const got = await drive({ dirty: true, mode: "tui", accept: false });
    assert.equal(got.asks, 1);
    assert.equal(got.head, got.start);
    assert.equal(got.stored, false);
    assert.equal(got.notices.some((n) => n.msg.includes("still uncommitted")), true);
  });

  test("a headless push refuses a dirty tree without asking", async () => {
    const got = await drive({ dirty: true, mode: "rpc" });
    assert.equal(got.asks, 0);
    assert.equal(got.head, got.start);
    assert.equal(got.stored, false);
    assert.equal(got.notices.some((n) => n.msg.includes("Commit or stash")), true);
  });

  test("autoPush refuses a dirty tree without asking", async () => {
    const got = await drive({ dirty: true, mode: "tui", quiet: true });
    assert.equal(got.asks, 0);
    assert.equal(got.head, got.start);
    assert.equal(got.stored, false);
  });

  test("a checkout with no origin is not committed", async () => {
    const got = await drive({ dirty: true, mode: "tui", accept: true, dropOrigin: true });
    assert.equal(got.asks, 0);
    assert.equal(got.head, got.start);
    assert.equal(got.stored, false);
    assert.equal(got.notices.some((n) => n.msg.includes("no origin")), true);
  });

  test("a detached HEAD is not committed", async () => {
    const got = await drive({ dirty: true, mode: "tui", accept: true, detach: true });
    assert.equal(got.asks, 0);
    assert.equal(got.head, got.start);
    assert.equal(got.stored, false);
    assert.equal(got.notices.some((n) => n.msg.includes("detached")), true);
  });
});

