// Sysop tools (#289): session_search and session_transcript on a laptop -- local keyword search over
// pi's JSONL files, the cloud through the op registry, both merged -- plus /sessions sync and the
// transcript renderer staying the same file as Outfitter's.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionSearch, runSessionTranscript } from "../.pi/extensions/outfitter-admin/search-tools.ts";
import { autoSyncer, syncSessions } from "../.pi/extensions/outfitter-admin/sync.ts";
import type { AdminTransport } from "../.pi/extensions/outfitter-admin/transport.ts";

const SID = "01a0f144-ccb5-7373-8cb5-031506872117";

function sessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ksess-"));
  const slug = join(dir, "--Users-ada-code-app--");
  mkdirSync(slug);
  const lines = [
    { type: "session", version: "3", id: SID, timestamp: "2026-09-30T07:43:33.046Z", cwd: "/Users/ada/code/app" },
    { type: "session_info", id: "i1", name: "gke auth" },
    { type: "message", id: "a1", parentId: null, message: { role: "user", content: [{ type: "text", text: "kubectl says 403 from the GKE auth plugin" }] } },
    { type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "bash", arguments: { command: "kubectl get pods" } }] } },
    { type: "message", id: "a3", parentId: "a2", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "error: 403 Forbidden" }] } },
    { type: "message", id: "a4", parentId: "a3", message: { role: "assistant", content: [{ type: "text", text: "Deleting the token cache fixes it." }] } },
  ];
  writeFileSync(join(slug, `2026-09-30T07-43-33-046Z_${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

function cloud(reply: Record<string, unknown>) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const transport: AdminTransport = { kind: "laptop", async call(op, args) { calls.push({ op, args }); return reply as any; } };
  return { transport, calls };
}

describe("session_search", () => {
  test("local only: keyword hits grouped under the session, thinking never", async () => {
    const res = await runSessionSearch({ query: "403 forbidden", scope: "local" }, { localDir: sessionsDir() });
    const text = res.content[0].text;
    assert.match(text, /^06872117 {2}gke auth {2}app {2}/);
    assert.match(text, /^ {2}\[a3\] bash ✗: error: 403 Forbidden$/m);
    assert.doesNotMatch(text, /hmm/);
  });

  test("cloud and local: two sections, a session the cloud listed is shown once", async () => {
    const { transport, calls } = cloud({ ok: true, text: "06872117  gke auth  tape=coder  2d ago\n  [a3] bash ✗: error: 403 Forbidden" });
    const res = await runSessionSearch({ query: "403", owner: "me", since: "7d" }, { transport, localDir: sessionsDir() });
    assert.deepEqual(calls[0], { op: "sessions.search", args: { query: "403", limit: 10, owner: "me", since: "7d" } });
    assert.equal(res.content[0].text, "cloud:\n06872117  gke auth  tape=coder  2d ago\n  [a3] bash ✗: error: 403 Forbidden\nlocal:\nno matches");
  });

  test("a cloud error still shows local results", async () => {
    const { transport } = cloud({ ok: false, error: "hybrid search is not set up" });
    const res = await runSessionSearch({ query: "token cache" }, { transport, localDir: sessionsDir() });
    assert.match(res.content[0].text, /^cloud: hybrid search is not set up\nlocal:\n06872117/);
  });
});

describe("session_transcript", () => {
  test("a local session by prefix: outline with a (local) header", async () => {
    const res = await runSessionTranscript({ id: "01a0f144" }, { localDir: sessionsDir() });
    const lines = res.content[0].text.split("\n");
    assert.match(lines[0], /^session 06872117 \(local\) {2}"gke auth" {2}app {2}.* {2}5 entries$/);
    assert.match(res.content[0].text, /^\[a3\] ✗ bash: error: 403 Forbidden$/m);
  });

  test("not local: asks the cloud with the options given (and the trimmed default)", async () => {
    const { transport, calls } = cloud({ ok: true, text: "session 99999999 ..." });
    await runSessionTranscript({ id: "99999999", around: "e1", view: "text" }, { transport, localDir: sessionsDir() });
    assert.deepEqual(calls[0], { op: "sessions.transcript", args: { id: "99999999", view: "text", around: "e1", toolOutput: "trimmed" } });
  });
});

describe("/sessions sync", () => {
  test("uploads the named session through teleport's import", async () => {
    const puts: Array<{ id: string; name?: string; lines: number }> = [];
    const store = { async put(id: string, jsonl: string, m: { name?: string }) { puts.push({ id, name: m.name, lines: jsonl.trim().split("\n").length }); } };
    const report = await syncSessions(sessionsDir(), { id: "01a0f144", store });
    assert.equal(report, "synced 1 of 1 session");
    assert.deepEqual(puts, [{ id: SID, name: "gke auth", lines: 6 }]);
    assert.equal(await syncSessions(sessionsDir(), { store }), "name a session id or --since 7d");
    assert.equal(await syncSessions(sessionsDir(), { since: "soon", store }), "--since takes 12h, 7d, 2w or an ISO date");
  });
});

for (const name of ["transcript.ts", "redact.ts"]) {
  test(`${name} is Outfitter's file, unchanged`, (t) => {
    const dir = new URL("../../outfitter/packages/api/src/search/", import.meta.url);
    // Skips only while Outfitter's search code isn't on this branch at all; a moved file fails.
    if (!existsSync(dir)) return t.skip("outfitter's search code isn't on this branch yet (#289)");
    assert.equal(readFileSync(new URL(`../.pi/extensions/_shared/${name}`, import.meta.url), "utf8"), readFileSync(new URL(name, dir), "utf8"));
  });
}

describe("review fixes", () => {
  function twoSessions(): string {
    const dir = mkdtempSync(join(tmpdir(), "ksess-"));
    const slug = join(dir, "--w--");
    mkdirSync(slug);
    for (const [id, word] of [["01a0f23e-5392-7000-8000-00000000aaaa", "alpha"], ["01a0f23e-5b68-7000-8000-00000000bbbb", "bravo"]]) {
      const lines = [{ type: "session", id, cwd: "/w" }, { type: "message", id: `${word}1`, message: { role: "user", content: [{ type: "text", text: `${word} rollout decide special` }] } }];
      writeFileSync(join(slug, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    return dir;
  }

  test("UUIDv7 sessions started together: distinct tails, a tail reads the right one, a shared head is ambiguous", async () => {
    const dir = twoSessions();
    const res = await runSessionSearch({ query: "rollout", scope: "local" }, { localDir: dir });
    assert.match(res.content[0].text, /^0000aaaa /m);
    assert.match(res.content[0].text, /^0000bbbb /m);
    assert.match((await runSessionTranscript({ id: "0000bbbb" }, { localDir: dir })).content[0].text, /bravo rollout/);
    assert.match((await runSessionTranscript({ id: "01a0f23e" }, { localDir: dir })).content[0].text, /ambiguous/);
    const store = { async put() {} };
    assert.match(await syncSessions(dir, { id: "01a0f23e", store }), /matches 2 sessions/);
  });

  test("whole words only: 'ci' doesn't match 'decide' or 'special'", async () => {
    const res = await runSessionSearch({ query: "ci", scope: "local" }, { localDir: twoSessions() });
    assert.equal(res.content[0].text, "no matches");
  });

  test("a bad since is an error locally too", async () => {
    const res = await runSessionSearch({ query: "rollout", scope: "local", since: "last week" }, { localDir: twoSessions() });
    assert.deepEqual(res, { content: [{ type: "text", text: "since: use 7d, 12h or an ISO date" }], isError: true });
  });

  test("sync sends only complete lines of a session still being written", async () => {
    const dir = sessionsDir();
    const file = join(dir, "--Users-ada-code-app--", `2026-09-30T07-43-33-046Z_${SID}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8") + '{"type":"message","id":"torn');
    let body = "";
    await syncSessions(dir, { id: SID, store: { async put(_id: string, jsonl: string) { body = jsonl; } } });
    assert.ok(body.endsWith("\n"));
    assert.doesNotMatch(body, /torn/);
  });

  test("--since is this directory's sessions unless --all", async () => {
    const dir = sessionsDir();
    const store = { async put() {} };
    assert.match(await syncSessions(dir, { since: "3650d", cwd: "/elsewhere", store }), /in this directory/);
    assert.equal(await syncSessions(dir, { since: "3650d", cwd: "/elsewhere", all: true, store }), "synced 1 of 1 session");
  });

  test("auto-sync uploads in the background, skips an unchanged file, and reports one failure", async () => {
    const dir = sessionsDir();
    const file = join(dir, "--Users-ada-code-app--", `2026-09-30T07-43-33-046Z_${SID}.jsonl`);
    let puts = 0;
    const notes: string[] = [];
    const sync = autoSyncer({ async put() { puts++; } }, (m) => notes.push(m));
    sync(file, { id: SID, cwd: "/w" });
    await new Promise((r) => setTimeout(r, 20));
    sync(file, { id: SID, cwd: "/w" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(puts, 1);
    const failing = autoSyncer({ async put() { throw new Error("teleport: Outfitter API returned 401"); } }, (m) => notes.push(m));
    failing(file, { id: SID, cwd: "/w" });
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ type: "message", id: "z" }) + "\n");
    failing(file, { id: SID, cwd: "/w" });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(notes, ["sessions sync: Outfitter API returned 401"]);
  });

  test("local results are redacted", async () => {
    const dir = sessionsDir();
    const file = join(dir, "--Users-ada-code-app--", `2026-09-30T07-43-33-046Z_${SID}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ type: "message", id: "s1", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "export KEY=ghp_0123456789abcdefghijABCDEFGHIJ done" }] } }) + "\n");
    const res = await runSessionSearch({ query: "export done", scope: "local" }, { localDir: dir });
    assert.doesNotMatch(res.content[0].text, /ghp_0123/);
    assert.doesNotMatch((await runSessionTranscript({ id: SID, view: "text" }, { localDir: dir })).content[0].text, /ghp_0123/);
  });
});
