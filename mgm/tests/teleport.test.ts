import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitStore, parseOwnerRepo, rewriteHeaderCwd, pickModelForHost, manifestFromGit, describeRef,
  isWorkingTreeDirty, needsPush, verifyOwnerRepo, findSessionFileForId, FALLBACK_MODEL,
  type ExecFn, type Manifest,
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
  test("falls back to local-qwen-mlx when the last model's provider is unavailable", () => {
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
});
