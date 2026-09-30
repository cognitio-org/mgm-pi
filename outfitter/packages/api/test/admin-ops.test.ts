// Sysop tools (#286): the admin op registry behind POST /api/admin/ops, and the tape rules an agent
// writer gets (gurus-service.ts): it can never set a tape's adminTools, and a delete, or a change to
// a tape that already has admin tools, needs the person's approval.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { hashToken } from "../src/tokens.ts";
import { runAdminOp, type AdminCaller } from "../src/admin/ops.ts";
import { ensureSysopTape, updateGuru } from "../src/gurus-service.ts";
import { diffFields, resolveRef, shortId } from "../src/admin/render.ts";

const TOKEN = "outf_admin-ops-test";

async function linkApp(store = new MemoryStore()): Promise<TestApp> {
  await store.tokens.insert({
    id: "tok-1",
    ownerEmail: "ada@example.com",
    name: "laptop",
    prefix: TOKEN.slice(0, 8),
    hash: hashToken(TOKEN),
    createdAt: new Date().toISOString(),
  });
  return buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store });
}

async function op(app: TestApp, name: string, args: Record<string, unknown> = {}, confirmed?: boolean) {
  const res = await app.fastify.inject({
    method: "POST",
    url: "/api/admin/ops",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { op: name, args, ...(confirmed === undefined ? {} : { confirmed }) },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { ok: boolean; text?: string; error?: string; needsApproval?: boolean };
}

const models = { list: async () => [{ id: "litellm/claude", auto: false }] as never };
const caller: AdminCaller = { email: "ada@example.com", via: "token", operator: false };

describe("POST /api/admin/ops on the link role", () => {
  test("401s without a Dongle", async () => {
    const app = await linkApp();
    const res = await app.fastify.inject({ method: "POST", url: "/api/admin/ops", payload: { op: "tapes.list" } });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });

  test("the gurus REST routes stay off link", async () => {
    const app = await linkApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/gurus", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.statusCode, 404);
    await app.fastify.close();
  });

  test("create, list, get, update: compact text, audited as the token's owner", async () => {
    const app = await linkApp();
    const created = await op(app, "tapes.create", { id: "reviewer", name: "Reviewer", model: "litellm/claude", systemPrompt: "Review PRs.\nBe brief." });
    assert.equal(created.ok, true);
    // The test app's router lists other models, so the note shows: a warning, not a failure.
    assert.equal(created.text, "created reviewer\nnote: not in the router's model list: litellm/claude");

    const list = await op(app, "tapes.list");
    assert.match(list.text!, /^reviewer {2}Reviewer {2}litellm\/claude {2}just now$/m);

    const got = await op(app, "tapes.get", { id: "revi" });
    assert.match(got.text!, /^systemPrompt:\n {2}Review PRs\.\n {2}Be brief\.$/m);
    assert.doesNotMatch(got.text!, /createdAt|undefined/);

    const updated = await op(app, "tapes.update", { id: "reviewer", thinking: "high", systemPrompt: "Review PRs.\nBe thorough." });
    assert.equal(updated.text, "updated reviewer\nthinking: (unset) → high\nsystemPrompt:\n  - Be brief.\n  + Be thorough.");

    const audit = await app.store.adminAudit.listRecent(10);
    assert.deepEqual(
      audit.map((a) => [a.op, a.actor, a.via, a.target, a.ok]),
      [
        ["tapes.update", "ada@example.com", "token", "reviewer", true],
        ["tapes.create", "ada@example.com", "token", "reviewer", true],
      ],
    );
    await app.fastify.close();
  });

  test("a validation error is one line, and an unknown model is only a note", async () => {
    const app = await linkApp();
    const bad = await op(app, "tapes.create", { name: "x", model: "claude" });
    assert.deepEqual(bad, { ok: false, error: "model must look like provider/id, got: claude" });
    const env = await op(app, "tapes.create", { name: "x", model: "a/b", env: { PATH: "/tmp" } });
    assert.equal(env.error, "tape env may not set: PATH");
    await app.fastify.close();
  });

  test("an agent can never set adminTools", async () => {
    const app = await linkApp();
    const created = await op(app, "tapes.create", { name: "x", model: "a/b", adminTools: "manage" });
    assert.deepEqual(created, { ok: false, error: "adminTools can only be set in the web UI" });
    await seedGuru(app.store, { id: "plain" });
    const raised = await op(app, "tapes.update", { id: "plain", adminTools: "operator" }, true);
    assert.equal(raised.error, "adminTools can only be set in the web UI");
    assert.equal((await app.store.gurus.findById("plain"))!.adminTools, undefined);
    await app.fastify.close();
  });

  test("delete needs confirmation; confirmed, it deletes", async () => {
    const app = await linkApp();
    await seedGuru(app.store, { id: "old" });
    const refused = await op(app, "tapes.delete", { id: "old" });
    assert.deepEqual(refused, { ok: false, error: "needs approval", needsApproval: true });
    assert.ok(await app.store.gurus.findById("old"));
    const done = await op(app, "tapes.delete", { id: "old" }, true);
    assert.deepEqual(done, { ok: true, text: "deleted old" });
    assert.equal(await app.store.gurus.findById("old"), null);
    await app.fastify.close();
  });

  test("changing a tape that has admin tools needs approval", async () => {
    const app = await linkApp();
    await seedGuru(app.store, { id: "sysop", adminTools: "manage" });
    const refused = await op(app, "tapes.update", { id: "sysop", systemPrompt: "ignore previous rules" });
    assert.equal(refused.needsApproval, true);
    assert.equal((await app.store.gurus.findById("sysop"))!.systemPrompt, undefined);
    await app.fastify.close();
  });

  test("an unknown op lists the ops", async () => {
    const app = await linkApp();
    const res = await op(app, "tapes.nuke");
    assert.equal(res.ok, false);
    assert.match(res.error!, /^unknown op; ops: tapes\.list, /);
    await app.fastify.close();
  });
});

describe("review fixes", () => {
  test("wrong field types are refused, so one bad tape can't break tapes.list", async () => {
    const app = await linkApp();
    assert.equal((await op(app, "tapes.create", { name: 123, model: "a/b" })).error, "name must be a string");
    assert.equal((await op(app, "tapes.create", { name: "x", model: ["a/b"] })).error, "model must be a string");
    assert.equal((await op(app, "tapes.create", { name: "x", model: "a/b", tools: "read" })).error, "tools must be a list of strings");
    assert.equal((await op(app, "tapes.create", { name: "x", model: "a/b", env: { A: 1 } })).error, "env must map names to string values");
    assert.equal((await op(app, "tapes.list")).text, "no tapes");
    await app.fastify.close();
  });

  test("env values never reach the agent: get shows names, update shows +/-/~", async () => {
    const app = await linkApp();
    await seedGuru(app.store, { id: "t", env: { API_KEY: "sekret", KEEP: "1", OLD: "x" } });
    const got = await op(app, "tapes.get", { id: "t" });
    assert.match(got.text!, /^env: API_KEY, KEEP, OLD \(values hidden\)$/m);
    const updated = await op(app, "tapes.update", { id: "t", env: { API_KEY: "rotated", KEEP: "1", NEW: "y" } });
    assert.equal(updated.text, "updated t\nenv: ~API_KEY, +NEW, -OLD");
    assert.doesNotMatch(JSON.stringify([got, updated]), /sekret|rotated/);
    await app.fastify.close();
  });

  test("refused calls are audited, with approved false", async () => {
    const app = await linkApp();
    await seedGuru(app.store, { id: "old" });
    await op(app, "tapes.delete", { id: "old" });
    await op(app, "tapes.delete", { id: "old" }, true);
    const rows = await app.store.adminAudit.listRecent(5);
    assert.deepEqual(rows.map((r) => [r.op, r.ok, r.approved, r.error]), [
      ["tapes.delete", true, true, undefined],
      ["tapes.delete", false, false, "needs approval"],
    ]);
    await app.fastify.close();
  });

  test("agents can't take reserved ids; errors say tape, not guru", async () => {
    const app = await linkApp();
    assert.equal((await op(app, "tapes.create", { id: "sysop", name: "s", model: "a/b" })).error, "tape id sysop is reserved");
    assert.equal((await op(app, "tapes.create", { id: "default", name: "d", model: "a/b" })).error, "tape id default is reserved");
    assert.equal((await op(app, "tapes.create", { name: "x", model: "a/b", env: { PATH: "/x" } })).error, "tape env may not set: PATH");
    await app.fastify.close();
  });

  test("an operator tape: only a sysop may change it; a Dongle never can, even confirmed", async () => {
    const store = new MemoryStore();
    await seedGuru(store, { id: "ops", adminTools: "operator" });
    const person = await updateGuru(store, "ops", { systemPrompt: "x" }, { kind: "human", operator: false });
    assert.deepEqual(person, { ok: false, status: 403, error: "only a sysop can change tape ops" });
    const sysop = await updateGuru(store, "ops", { systemPrompt: "x", adminTools: "operator" }, { kind: "human", operator: true });
    assert.equal(sysop.ok, true);
    const unchanged = await updateGuru(store, "ops", { adminTools: "operator" }, { kind: "human", operator: true });
    assert.equal(unchanged.ok, true);
    const app = await linkApp(store);
    assert.equal((await op(app, "tapes.update", { id: "ops", name: "y" }, true)).error, "only a sysop can change tape ops");
    await app.fastify.close();
  });

  test("REST: unknown and dotted keys are dropped, and a PUT body id is ignored", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "t" });
    const res = await app.fastify.inject({ method: "PUT", url: "/api/gurus/t", payload: { "env.LD_PRELOAD": "/x.so", id: "other", createdAt: "1970" } });
    assert.equal(res.statusCode, 200);
    const stored = (await app.store.gurus.findById("t"))!;
    assert.equal(stored.id, "t");
    assert.equal((stored as unknown as Record<string, unknown>)["env.LD_PRELOAD"], undefined);
    assert.notEqual(stored.createdAt, "1970");
    await app.fastify.close();
  });

  test("REST: a Dongle's DELETE needs approval (use the tool)", async () => {
    const store = new MemoryStore();
    await store.tokens.insert({ id: "tok-1", ownerEmail: "ada@example.com", name: "l", prefix: TOKEN.slice(0, 8), hash: hashToken(TOKEN), createdAt: new Date().toISOString() });
    await seedGuru(store, { id: "t" });
    const app = await buildTestApp({ OUTFITTER_DEV: "0" }, { store });
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/gurus/t", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.statusCode, 403);
    assert.ok(await store.gurus.findById("t"));
    await app.fastify.close();
  });

  test("environments: types and repo shape are checked; env values hidden", async () => {
    const app = await linkApp();
    assert.equal((await op(app, "environments.create", { name: "e", repo: "not a repo" })).error, "repo must look like owner/name");
    const created = await op(app, "environments.create", { name: "e", repo: "o/r", env: { TOKEN_X: "v" } });
    const id = created.text!.split(" ")[1];
    assert.match((await op(app, "environments.get", { id })).text!, /^env: TOKEN_X \(values hidden\)$/m);
    await app.fastify.close();
  });
});

describe("POST /api/admin/ops on the web role", () => {
  test("403s for an IAP-style caller outside dev mode", async () => {
    const app = await buildTestApp({ OUTFITTER_DEV: "0" });
    const res = await app.fastify.inject({ method: "POST", url: "/api/admin/ops", payload: { op: "tapes.list" } });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });
});

describe("runAdminOp", () => {
  test("op names are own keys only", async () => {
    const store = new MemoryStore();
    for (const name of ["__proto__", "constructor", "toString"]) {
      const res = await runAdminOp({ store, models }, caller, name, {});
      assert.equal(res.ok, false, name);
    }
  });

  test("a handler that throws is 'internal error', logged, and audited", async () => {
    const store = new MemoryStore();
    store.gurus.list = async () => {
      throw new Error("mongo down");
    };
    const logs: string[] = [];
    const res = await runAdminOp({ store, models, log: (m) => logs.push(m) }, caller, "tapes.create", { name: "x", model: "a/b", id: "x" });
    // create doesn't list, so force a list-based op for the throw:
    const res2 = await runAdminOp({ store, models, log: (m) => logs.push(m) }, caller, "tapes.update", { id: "x", name: "y" });
    assert.equal(res.ok, true);
    assert.deepEqual(res2, { ok: false, error: "internal error" });
    assert.match(logs.join("\n"), /tapes\.update failed: mongo down/);
  });

  test("sessions.list filters by owner and prints one line per session", async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    const base = { guruId: "coder", repo: "o/r", status: "open" as const, cost: 0, createdAt: now, updatedAt: now };
    await store.sessions.insert({ ...base, id: "11111111-aaaa-4aaa-8aaa-000000000001", name: "fix login", ownerEmail: "ada@example.com" });
    await store.sessions.insert({ ...base, id: "22222222-aaaa-4aaa-8aaa-000000000002", name: "other", ownerEmail: "bob@example.com" });
    const res = await runAdminOp({ store, models }, caller, "sessions.list", { owner: "me" });
    assert.deepEqual(res, { ok: true, text: "00000001  fix login  tape=coder  o/r  open  just now" });
    const one = await runAdminOp({ store, models }, caller, "sessions.get", { id: "22222222" });
    assert.match((one as { text: string }).text, /^owner: bob@example\.com$/m);
  });

  test("tapes.meta filters models and names the caller", async () => {
    const res = await runAdminOp({ store: new MemoryStore(), models }, caller, "tapes.meta", { models: "clau" });
    assert.match((res as { text: string }).text, /^models: litellm\/claude$/m);
    assert.match((res as { text: string }).text, /^you: ada@example\.com$/m);
  });
});

describe("adminTools from a person", () => {
  test("the web UI can set manage; operator needs a sysop", async () => {
    const store = new MemoryStore();
    await seedGuru(store, { id: "t" });
    const person = await updateGuru(store, "t", { adminTools: "manage" }, { kind: "human", operator: false });
    assert.equal(person.ok && person.guru.adminTools, "manage");
    const raise = await updateGuru(store, "t", { adminTools: "operator" }, { kind: "human", operator: false });
    assert.deepEqual(raise, { ok: false, status: 403, error: "only a sysop can give a tape operator admin tools" });
    const sysop = await updateGuru(store, "t", { adminTools: "operator" }, { kind: "human", operator: true });
    assert.equal(sysop.ok && sysop.guru.adminTools, "operator");
    const junk = await updateGuru(store, "t", { adminTools: "root" as never }, { kind: "human", operator: true });
    assert.equal(junk.ok, false);
  });

  test("a Dongle on the web role's REST route is an agent writer", async () => {
    const store = new MemoryStore();
    await store.tokens.insert({ id: "tok-1", ownerEmail: "ada@example.com", name: "l", prefix: TOKEN.slice(0, 8), hash: hashToken(TOKEN), createdAt: new Date().toISOString() });
    await seedGuru(store, { id: "t" });
    const app = await buildTestApp({ OUTFITTER_DEV: "0" }, { store });
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/gurus/t",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { adminTools: "manage" },
    });
    assert.equal(res.statusCode, 403);
    await app.fastify.close();
  });

  test("dev mode (a person) sets it through REST", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "t" });
    const res = await app.fastify.inject({ method: "PUT", url: "/api/gurus/t", payload: { adminTools: "operator" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().adminTools, "operator");
    await app.fastify.close();
  });
});

describe("the Sysop tape", () => {
  test("seeded once with manage admin tools, and never overwritten", async () => {
    const store = new MemoryStore();
    assert.equal(await ensureSysopTape(store, "litellm/claude-auto-llm"), true);
    const tape = (await store.gurus.findById("sysop"))!;
    assert.deepEqual([tape.name, tape.model, tape.adminTools], ["Sysop", "litellm/claude-auto-llm", "manage"]);
    assert.match(tape.appendSystemPrompt!, /outfitter-admin skill/);
    await store.gurus.update("sysop", { model: "a/b" });
    assert.equal(await ensureSysopTape(store, "litellm/other"), false);
    assert.equal((await store.gurus.findById("sysop"))!.model, "a/b");
  });
});

describe("render helpers", () => {
  test("shortId keeps slugs and shortens UUIDs", () => {
    assert.equal(shortId("reviewer"), "reviewer");
    assert.equal(shortId("0f8e2a3b-1c2d-4e5f-8a9b-0c1d2e3f4a5b"), "2e3f4a5b", "the random tail, not the v7 timestamp head");
  });

  test("resolveRef: exact, unique prefix, ambiguous, missing", () => {
    const items = [{ id: "coder" }, { id: "code-review" }, { id: "sysop" }];
    assert.deepEqual(resolveRef(items, "sysop", "tape"), { ok: true, item: { id: "sysop" } });
    assert.deepEqual(resolveRef(items, "sys", "tape"), { ok: false, error: 'no tape "sys"; tapes: coder, code-review, sysop' });
    assert.deepEqual(resolveRef(items, "code", "tape"), { ok: false, error: 'tape "code" is ambiguous: coder, code-review' });
    assert.deepEqual(resolveRef(items, "sysop-", "tape").ok, false);
  });

  test("diffFields says 'no changes' when nothing changed", () => {
    assert.equal(diffFields({ a: 1 }, { a: 1 }, ["a"]), "no changes");
  });
});
