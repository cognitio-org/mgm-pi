// Sysop tools (#289): session_search and session_transcript on a laptop -- local keyword search over
// pi's JSONL files, the cloud through the op registry, both merged -- plus /sessions sync and the
// transcript renderer staying the same file as Outfitter's.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionSearch, runSessionTranscript } from "../.pi/extensions/outfitter-admin/search-tools.ts";
import { syncSessions } from "../.pi/extensions/outfitter-admin/sync.ts";
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
    assert.match(text, /^01a0f144 {2}gke auth {2}app {2}/);
    assert.match(text, /^ {2}\[a3\] bash ✗: error: 403 Forbidden$/m);
    assert.doesNotMatch(text, /hmm/);
  });

  test("cloud and local: two sections, a session the cloud listed is shown once", async () => {
    const { transport, calls } = cloud({ ok: true, text: "01a0f144  gke auth  tape=coder  2d ago\n  [a3] bash ✗: error: 403 Forbidden" });
    const res = await runSessionSearch({ query: "403", owner: "me", since: "7d" }, { transport, localDir: sessionsDir() });
    assert.deepEqual(calls[0], { op: "sessions.search", args: { query: "403", limit: 10, owner: "me", since: "7d" } });
    assert.equal(res.content[0].text, "cloud:\n01a0f144  gke auth  tape=coder  2d ago\n  [a3] bash ✗: error: 403 Forbidden\nlocal:\nno matches");
  });

  test("a cloud error still shows local results", async () => {
    const { transport } = cloud({ ok: false, error: "hybrid search is not set up" });
    const res = await runSessionSearch({ query: "token cache" }, { transport, localDir: sessionsDir() });
    assert.match(res.content[0].text, /^cloud: hybrid search is not set up\nlocal:\n01a0f144/);
  });
});

describe("session_transcript", () => {
  test("a local session by prefix: outline with a (local) header", async () => {
    const res = await runSessionTranscript({ id: "01a0f144" }, { localDir: sessionsDir() });
    const lines = res.content[0].text.split("\n");
    assert.match(lines[0], /^session 01a0f144 \(local\) {2}"gke auth" {2}app {2}.* {2}5 entries$/);
    assert.match(res.content[0].text, /^\[a3\] ✗ bash: error: 403 Forbidden$/m);
  });

  test("not local: asks the cloud with only the options given", async () => {
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
    assert.equal(await syncSessions(sessionsDir(), { since: "soon", store }), "--since takes 12h, 7d or 2w");
  });
});

test("the transcript renderer is Outfitter's file, unchanged", (t) => {
  const outfitter = new URL("../../outfitter/packages/api/src/search/transcript.ts", import.meta.url);
  if (!existsSync(outfitter)) return t.skip("outfitter's copy isn't on this branch yet (#289)");
  assert.equal(readFileSync(new URL("../.pi/extensions/_shared/transcript.ts", import.meta.url), "utf8"), readFileSync(outfitter, "utf8"));
});
