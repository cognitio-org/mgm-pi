// Session search and transcripts (Sysop tools, #289): the chunker and its redaction, the transcript
// renderer's views and caps, the search and transcript ops on the memory store (keyword only), and
// the index staying in step with entries, imports and formats.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { PiEntry, Session } from "../src/store/types.ts";
import { chunkEntry, chunkSession, TOOL_OUTPUT_CHARS } from "../src/search/chunker.ts";
import { redact } from "../src/search/redact.ts";
import { renderTranscript } from "../src/search/transcript.ts";
import { parseSince, snippet, SessionIndexer } from "../src/search/service.ts";
import { runAdminOp, type AdminCaller } from "../src/admin/ops.ts";

const now = "2026-09-30T10:00:00.000Z";
const session: Session = { id: "11111111-aaaa-4aaa-8aaa-000000000001", name: "fix login", prompt: "The login page 500s", guruId: "coder", repo: "o/r", ownerEmail: "Ada@Example.com", status: "open", cost: 0, createdAt: now, updatedAt: now };

let n = 0;
const id = () => `e${String(++n).padStart(7, "0")}`;
const user = (text: string, parentId?: string): PiEntry => ({ id: id(), parentId, type: "message", timestamp: now, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string, calls: Array<[string, unknown]> = [], parentId?: string): PiEntry => ({
  id: id(),
  parentId,
  type: "message",
  message: { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, ...(text ? [{ type: "text", text }] : []), ...calls.map(([name, args]) => ({ type: "toolCall", id: "c", name, arguments: args }))] },
});
const tool = (name: string, text: string, isError = false, parentId?: string): PiEntry => ({ id: id(), parentId, type: "message", message: { role: "toolResult", toolName: name, isError, content: [{ type: "text", text }] } });

describe("redact", () => {
  test("tokens, keys, JWTs, passwords in URIs and key=value secrets", () => {
    const text = [
      "token outf_abcdefghijklmnop and ghp_0123456789abcdefghijABCDEFGHIJ",
      "OPENAI sk-proj-abcdefghijklmnopqrstuv, google AIzaSyA-0123456789abcdefghijklmnopqrstu",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "mongodb+srv://user:hunter2hunter2@cluster0.x.mongodb.net/db",
      "Authorization: Bearer abc.def.ghi",
      'password="correct horse battery"',
      "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redact(text);
    for (const secret of ["outf_abc", "ghp_0123", "sk-proj-abc", "AIzaSyA", "eyJhbGci", "hunter2", "abc.def.ghi", "correct horse", "MIIE"]) {
      assert.ok(!out.includes(secret), `${secret} survived: ${out}`);
    }
    assert.match(out, /Authorization: Bearer \[redacted\]/);
    assert.match(out, /mongodb\+srv:\/\/\[redacted\]cluster0/);
  });
});

describe("chunker", () => {
  test("user and assistant words, tool calls, no thinking; owner lowercased", () => {
    const c = chunkEntry(session, assistant("Looking at the handler.", [["read", { path: "src/login.ts" }]]))!;
    assert.equal(c.role, "assistant");
    assert.equal(c.text, 'Looking at the handler.\n→ read(path="src/login.ts")');
    assert.equal(c.ownerEmail, "ada@example.com");
    assert.doesNotMatch(c.text, /secret plan/);
  });

  test("tool output is cut to the first part, marked when it failed, and redacted", () => {
    const long = `Error: ECONNREFUSED token=outf_abcdefghijklmnop ${"x".repeat(5000)}`;
    const c = chunkEntry(session, tool("bash", long, true))!;
    assert.equal(c.role, "tool");
    assert.equal(c.tool, "bash");
    assert.equal(c.isError, true);
    assert.ok(c.text.length <= TOOL_OUTPUT_CHARS + 20);
    assert.match(c.text, /^bash \(error\): Error: ECONNREFUSED/);
    assert.doesNotMatch(c.text, /outf_abc/);
  });

  test("entries without words are skipped; compaction summaries are kept; a session chunk", () => {
    assert.equal(chunkEntry(session, { id: "m1", type: "model_change", provider: "p", modelId: "m" }), undefined);
    assert.equal(chunkEntry(session, { id: "c1", type: "compaction", summary: "Fixed the login redirect." })!.role, "summary");
    const s = chunkSession(session);
    assert.equal(s.id, `${session.id}:session`);
    assert.match(s.text, /fix login\nThe login page 500s\ntape coder\nrepo o\/r/);
  });
});

describe("renderTranscript", () => {
  const entries = [user("Why does login 500?"), assistant("", [["bash", { command: "npm test" }]]), tool("bash", "1 failing: login.test.ts", true), assistant("The redirect is wrong.", [["edit", { path: "src/login.ts" }]]), tool("edit", "ok"), tool("edit", "ok")];

  test("outline: one line per turn, failed tools shown, ok tools counted, thinking never", () => {
    const out = renderTranscript(entries) as { text: string };
    const lines = out.text.split("\n");
    assert.match(lines[0], /^\[e\d+\] user: Why does login 500\?$/);
    assert.match(lines[1], /^\[e\d+\] 1 tool step: bash$/);
    assert.match(lines[2], /^\[e\d+\] ✗ bash: 1 failing: login\.test\.ts$/);
    assert.match(lines[3], /^\[e\d+\] assistant: The redirect is wrong\. → edit$/);
    assert.equal(lines[4], "(2 ok tool results not shown; view text for them)");
    assert.doesNotMatch(out.text, /secret plan/);
  });

  test("text: calls with args, trimmed output, identical results folded", () => {
    const out = renderTranscript(entries, { view: "text" }) as { text: string };
    assert.match(out.text, /→ bash\(command="npm test"\)/);
    assert.match(out.text, /✗ bash ⇒ 1 failing/);
    assert.match(out.text, /edit ⇒ ok \(×2\)$/m);
  });

  test("around a hit, roles, and paging with a cursor under a cap", () => {
    const hit = entries[2].id;
    const around = renderTranscript(entries, { view: "text", around: hit, window: 1 }) as { text: string };
    assert.equal(around.text.split("\n").filter((l) => l.startsWith("[")).length, 3);
    const users = renderTranscript(entries, { view: "text", roles: ["user"] }) as { text: string };
    assert.equal(users.text.split("\n").length, 1);

    const many = Array.from({ length: 80 }, (_, i) => user(`question number ${i} ${"words ".repeat(20)}`));
    const page1 = renderTranscript(many, { view: "text", maxChars: 1000 }) as { text: string; next?: string };
    assert.ok(page1.text.length <= 1100);
    assert.ok(page1.next);
    assert.match(page1.text, /\nmore: from=e\d+$/);
    const page2 = renderTranscript(many, { view: "text", maxChars: 1000, from: page1.next }) as { text: string };
    assert.notEqual(page2.text.split("\n")[0], page1.text.split("\n")[0]);
  });

  test("follows the active branch from the leaf", () => {
    const root = user("start");
    const abandoned = assistant("old path", [], root.id);
    const kept = assistant("new path", [], root.id);
    const out = renderTranscript([root, abandoned, kept], { view: "text", leafId: kept.id }) as { text: string };
    assert.doesNotMatch(out.text, /old path/);
    assert.match(out.text, /new path/);
  });

  test("a 200-entry session's outline stays small", () => {
    const big: PiEntry[] = [];
    for (let i = 0; i < 50; i++) big.push(user(`step ${i}`), assistant("", [["read", { path: `f${i}.ts` }]]), tool("read", "x".repeat(3000)), assistant(`done ${i}`));
    const out = renderTranscript(big) as { text: string };
    // 150 turns of words; tool steps fold. Real sessions have far more tool steps per turn.
    assert.ok(out.text.length < 5_000, `${out.text.length} chars`);
  });

  test("outline folds a run of tool-only steps into one line", () => {
    const run = [user("go"), assistant("", [["bash", {}]]), tool("bash", "ok"), assistant("", [["bash", {}]]), tool("bash", "ok"), assistant("", [["read", {}], ["read", {}]]), tool("read", "ok"), assistant("done")];
    const lines = (renderTranscript(run) as { text: string }).text.split("\n");
    assert.match(lines[1], /^\[e\d+\.\.e\d+\] 3 tool steps: bash×2, read×2$/);
    assert.match(lines[2], /^\[e\d+\] assistant: done$/);
  });

  test("an unknown entry reference is a one-line error", () => {
    assert.deepEqual(renderTranscript(entries, { around: "zzzz" }), { error: 'no entry "zzzz" in this session\'s transcript' });
  });
});

describe("helpers", () => {
  test("parseSince", () => {
    const t = Date.parse(now);
    assert.equal(parseSince("7d", t), "2026-09-23T10:00:00.000Z");
    assert.equal(parseSince("2026-09-01", t), "2026-09-01T00:00:00.000Z");
    assert.equal(parseSince("soon", t), undefined);
  });
  test("snippet centres on the match", () => {
    const text = `${"a ".repeat(200)}the GKE auth plugin returned 403 ${"b ".repeat(200)}`;
    const s = snippet(text, "gke 403");
    assert.match(s, /GKE auth plugin returned 403/);
    assert.ok(s.length <= 205);
  });
});

describe("sessions.search and sessions.transcript ops (memory store)", () => {
  const caller: AdminCaller = { email: "ada@example.com", via: "token", operator: false };
  const models = { list: async () => [] };

  async function seeded() {
    const store = new MemoryStore();
    await store.sessions.insert(session);
    await store.sessions.insert({ ...session, id: "22222222-bbbb-4bbb-8bbb-000000000002", name: "other", ownerEmail: "bob@example.com" });
    const es = [user("The GKE auth plugin gives a 403"), assistant("Checking the kubeconfig", [["bash", { command: "kubectl get pods" }]]), tool("bash", "error: 403 Forbidden", true)];
    for (const [i, e] of es.entries()) await store.entries.insertIfNew(session.id, i + 1, e);
    await store.entries.insertIfNew("22222222-bbbb-4bbb-8bbb-000000000002", 1, user("403 from somewhere else"));
    const indexer = new SessionIndexer(store);
    await indexer.reindexSession(session.id);
    await indexer.reindexSession("22222222-bbbb-4bbb-8bbb-000000000002");
    return store;
  }

  test("text search groups by session, with snippets; owner:me filters", async () => {
    const store = await seeded();
    const all = (await runAdminOp({ store, models }, caller, "sessions.search", { query: "403", mode: "text" })) as { ok: boolean; text: string };
    assert.equal(all.ok, true);
    assert.match(all.text, /^11111111 {2}fix login {2}tape=coder {2}o\/r {2}/m);
    assert.match(all.text, /^ {2}\[e\d+\] bash ✗: bash \(error\): error: 403 Forbidden$/m);
    assert.match(all.text, /^22222222 /m);
    const mine = (await runAdminOp({ store, models }, caller, "sessions.search", { query: "403", mode: "text", owner: "me" })) as { text: string };
    assert.doesNotMatch(mine.text, /22222222/);
  });

  test("semantic and hybrid say they need Atlas, and suggest text", async () => {
    const store = await seeded();
    const res = await runAdminOp({ store, models }, caller, "sessions.search", { query: "403" });
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /hybrid search needs Atlas.*; mode:text may work$/);
  });

  test("transcript by 8-char prefix, with a header line", async () => {
    const store = await seeded();
    const res = (await runAdminOp({ store, models }, caller, "sessions.transcript", { id: "11111111" })) as { ok: boolean; text: string };
    assert.equal(res.ok, true);
    assert.match(res.text.split("\n")[0], /^session 11111111 {2}"fix login" {2}tape=coder {2}o\/r {2}.* {2}3 entries$/);
    assert.match(res.text, /✗ bash: error: 403 Forbidden/);
    const missing = await runAdminOp({ store, models }, caller, "sessions.transcript", { id: "99999999" });
    assert.deepEqual(missing, { ok: false, error: 'no session "99999999"' });
  });
});

describe("the index follows entries, imports and formats", () => {
  test("an entry frame from agentd is indexed without holding up its ack", async () => {
    const app = await buildTestApp();
    const { session: s, runId, runToken } = await makeRunningSession(app, { ownerEmail: "dev@localhost", name: "indexed" });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, s.id, runToken);
    await agent.nextMessage(); // run.spec
    agent.send({ t: "entry", seq: 1, entry: user("the flaky websocket reconnect") });
    await agent.nextMessage(); // ack
    let hits: unknown[] = [];
    for (let i = 0; i < 100 && !hits.length; i++) {
      hits = await app.store.sessionChunks.search({ text: "websocket", mode: "text", filter: {}, limit: 5 });
      if (!hits.length) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(hits.length, 1);
    agent.close();
    await app.fastify.close();
  });

  test("format removes a session's chunks", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    await app.store.sessions.insert({ ...session, id: "s-fmt", guruId: "test-guru", ownerEmail: "dev@localhost", archivedAt: now });
    await app.store.entries.insertIfNew("s-fmt", 1, user("remove me please"));
    await new SessionIndexer(app.store).reindexSession("s-fmt");
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/sessions/s-fmt" });
    assert.equal(res.statusCode, 204);
    assert.deepEqual(await app.store.sessionChunks.search({ text: "remove", mode: "text", filter: {}, limit: 5 }), []);
    await app.fastify.close();
  });
});
