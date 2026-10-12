// E4.1b personal API tokens: creation/list/revoke on the "web" role, and the "link" role's
// bearer-token-only auth preHandler (server.ts) that resolves an `outf_...` token the same way.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedDongle, seedGuru } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { hashToken } from "../src/tokens.ts";

describe("POST /api/me/tokens", () => {
  test("#219: a service account (the live-test identity through IAP) can't create one", async () => {
    const store = new MemoryStore();
    const dev = await buildTestApp({}, { store });
    const minted = await seedDongle(store, "dev@localhost", "seed");
    // Re-own the dev token as a service account, then use it on a non-dev app.
    const record = await store.tokens.findById(minted.record.id);
    await store.tokens.insert({ ...record!, id: "sa-token", hash: hashToken("outf_sa"), ownerEmail: "outfitter-e2e@outfitter-509211.iam.gserviceaccount.com" });
    const prod = await buildTestApp({ OUTFITTER_DEV: "0" }, { store });
    const res = await prod.fastify.inject({
      method: "POST",
      url: "/api/me/tokens",
      headers: { authorization: "Bearer outf_sa" },
      payload: { name: "laptop" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(await store.tokens.countActiveForOwner("outfitter-e2e@outfitter-509211.iam.gserviceaccount.com"), 1);
    await dev.fastify.close();
    await prod.fastify.close();
  });

  test("#399: Dongles are retired -- kind \"dongle\" (or no kind) is refused with 410, nothing stored", async () => {
    const app = await buildTestApp();
    for (const payload of [{ name: "laptop" }, { name: "laptop", kind: "dongle" }]) {
      const res = await app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload });
      assert.equal(res.statusCode, 410, JSON.stringify(payload));
      assert.match(res.json().error, /Dongles are retired.*kernal login/);
    }
    assert.equal(await app.store.tokens.countActiveForOwner("dev@localhost"), 0);
    await app.fastify.close();
  });

  test("creates an A2A key, returns the plaintext once, never returns the hash", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "coder", name: "Coder", tools: ["read", "bash", "edit", "write"] });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/me/tokens",
      payload: { name: "ae", kind: "a2a", a2a: { tapes: ["coder"] } },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.match(body.token, /^outf_/);
    assert.equal(body.record.name, "ae");
    assert.equal(body.record.kind, "a2a");
    assert.equal(body.record.ownerEmail, "dev@localhost");
    assert.equal(body.record.prefix, body.token.slice(0, 8));
    assert.equal(body.record.hash, undefined);
    assert.equal(body.record.revokedAt, undefined);
    await app.fastify.close();
  });

  test("400s with no name", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: {} });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("caps active tokens per owner at 10 (existing Dongles count)", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "coder", name: "Coder", tools: ["read", "bash", "edit", "write"] });
    for (let i = 0; i < 9; i++) await seedDongle(app.store, "dev@localhost", `t${i}`);
    const create = () => app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "ae", kind: "a2a", a2a: { tapes: ["coder"] } } });
    assert.equal((await create()).statusCode, 201);
    const eleventh = await create();
    assert.equal(eleventh.statusCode, 400);
    await app.fastify.close();
  });
});

describe("GET /api/me/tokens", () => {
  test("lists only the caller's non-revoked tokens", async () => {
    const app = await buildTestApp();
    await seedDongle(app.store, "dev@localhost", "a");
    const created = await seedDongle(app.store, "dev@localhost", "b");
    const id = created.record.id;
    await app.fastify.inject({ method: "DELETE", url: `/api/me/tokens/${id}` });

    const res = await app.fastify.inject({ method: "GET", url: "/api/me/tokens" });
    const list = res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "a");
    await app.fastify.close();
  });
});

describe("DELETE /api/me/tokens/:id", () => {
  test("revokes the caller's own token", async () => {
    const app = await buildTestApp();
    const created = await seedDongle(app.store, "dev@localhost", "a");
    const id = created.record.id;

    const res = await app.fastify.inject({ method: "DELETE", url: `/api/me/tokens/${id}` });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().record.revokedAt);
    await app.fastify.close();
  });

  test("404s for an unknown id", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/me/tokens/nope" });
    assert.equal(res.statusCode, 404);
    await app.fastify.close();
  });

  test("404s (not 403) for another owner's token -- doesn't confirm it exists", async () => {
    const store = new MemoryStore();
    const other = await buildTestApp({}, { store });
    const created = await seedDongle(other.store, "dev@localhost", "a");
    const id = created.record.id;
    await store.tokens.update(id, { ownerEmail: "someone-else@example.com" });

    const res = await other.fastify.inject({ method: "DELETE", url: `/api/me/tokens/${id}` });
    assert.equal(res.statusCode, 404);
    await other.fastify.close();
  });
});

describe("link role: bearer-token-only auth", () => {
  test("a valid outf_ token resolves the token owner's identity and reaches a teleport route", async () => {
    const store = new MemoryStore();
    const web = await buildTestApp({}, { store }); // default role "all"; used just to mint a token
    const created = await seedDongle(web.store, "dev@localhost", "laptop");
    const token = created.token;

    const link = await buildTestApp({ OUTFITTER_ROLE: "link" }, { store });
    const res = await link.fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    await web.fastify.close();
    await link.fastify.close();
  });

  test("missing bearer token: 401", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link" });
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });

  test("malformed bearer token: 401", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link" });
    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });

  test("a revoked token is rejected the same way an unknown one is (401, generic message)", async () => {
    const store = new MemoryStore();
    const web = await buildTestApp({}, { store });
    const created = await seedDongle(web.store, "dev@localhost", "laptop");
    const { token, record } = created;
    await web.fastify.inject({ method: "DELETE", url: `/api/me/tokens/${record.id}` });

    const link = await buildTestApp({ OUTFITTER_ROLE: "link" }, { store });
    const res = await link.fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    await web.fastify.close();
    await link.fastify.close();
  });

  test("dev mode gives no free pass on the link role -- OUTFITTER_TOKEN is meant to behave identically everywhere", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "1" });
    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: "Bearer dev-agent-token" },
    });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });

  test("updates lastUsedAt, throttled to at most once per minute", async () => {
    const store = new MemoryStore();
    const web = await buildTestApp({}, { store });
    const created = await seedDongle(web.store, "dev@localhost", "laptop");
    const { token, record } = created;
    assert.equal(record.lastUsedAt, undefined);

    const link = await buildTestApp({ OUTFITTER_ROLE: "link" }, { store });
    await link.fastify.inject({ method: "GET", url: "/api/sessions", headers: { authorization: `Bearer ${token}` } });
    const afterFirst = await store.tokens.findById(record.id);
    assert.ok(afterFirst?.lastUsedAt);

    await link.fastify.inject({ method: "GET", url: "/api/sessions", headers: { authorization: `Bearer ${token}` } });
    const afterSecond = await store.tokens.findById(record.id);
    assert.equal(afterSecond?.lastUsedAt, afterFirst?.lastUsedAt); // throttled: unchanged within a minute

    await web.fastify.close();
    await link.fastify.close();
  });

  test("teleport routes are all reachable on the link role with a valid token", async () => {
    const store = new MemoryStore();
    const web = await buildTestApp({}, { store });
    await seedGuru(web.store);
    const created = await seedDongle(web.store, "dev@localhost", "laptop");
    const token = created.token;
    const auth = { authorization: `Bearer ${token}` };

    const createSession = await web.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", prompt: "hi" },
    });
    const sessionId = createSession.json().session.id;

    const link = await buildTestApp({ OUTFITTER_ROLE: "link" }, { store });

    assert.equal((await link.fastify.inject({ method: "GET", url: "/api/sessions", headers: auth })).statusCode, 200);
    assert.equal(
      (await link.fastify.inject({ method: "GET", url: `/api/sessions/${sessionId}`, headers: auth })).statusCode,
      200,
    );
    assert.equal(
      (await link.fastify.inject({ method: "GET", url: `/api/sessions/${sessionId}/export.jsonl`, headers: auth }))
        .statusCode,
      200,
    );
    assert.equal((await link.fastify.inject({ method: "GET", url: "/api/me", headers: auth })).statusCode, 200);

    await web.fastify.close();
    await link.fastify.close();
  });
});

describe("web/all role: outf_ token accepted alongside IAP, dev mode keeps its fixed identity", () => {
  test("an outf_ token resolves its owner's identity when dev mode is off", async () => {
    const store = new MemoryStore();
    const dev = await buildTestApp({}, { store }); // dev mode on, used only to mint a token
    const created = await seedDongle(dev.store, "dev@localhost", "laptop");
    const token = created.token;

    const prod = await buildTestApp({ OUTFITTER_DEV: "0" }, { store });
    const res = await prod.fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    await dev.fastify.close();
    await prod.fastify.close();
  });

  test("dev mode still identifies every caller as dev@localhost, even with a bogus bearer present", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer outf_not-a-real-token" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().email, "dev@localhost");
    await app.fastify.close();
  });
});
