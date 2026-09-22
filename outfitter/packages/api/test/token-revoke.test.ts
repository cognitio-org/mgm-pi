// Offboarding a user's outf_ tokens (deploy/README.md Rollback): the store's revokeAllForOwners on
// MemoryStore, its Mongo filter's parity with the memory matcher, POST /api/operator/tokens/revoke
// end to end (a revoked token 401s on the link role), and token expiry in identityFromApiToken.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { ownerEmailFilter } from "../src/store/mongo.ts";
import type { ApiToken } from "../src/store/types.ts";
import { hashToken, normalizeOwnerMatch, ownerMatches, TOKEN_TTL_MS } from "../src/tokens.ts";
import { identityFromApiToken } from "../src/auth.ts";

const OPERATOR_ENV = { OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "operator@mgms.eu" };

let seq = 0;
function tokenRow(ownerEmail: string, overrides: Partial<ApiToken> = {}): ApiToken {
  seq += 1;
  return {
    id: `t${seq}`,
    ownerEmail,
    name: `token ${seq}`,
    prefix: "outf_abc",
    hash: hashToken(`outf_plain_${seq}`),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Mints a real outf_ token for `ownerEmail` through a throwaway dev-mode app sharing `store` (same
 * trick as operator.test.ts's bearerFor), returning the plaintext. */
async function mintToken(store: MemoryStore, ownerEmail: string): Promise<string> {
  const dev = await buildTestApp({}, { store });
  const created = await dev.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "laptop" } });
  const { token, record } = created.json();
  await store.tokens.update(record.id, { ownerEmail });
  await dev.fastify.close();
  return token;
}

async function linkStatus(store: MemoryStore, token: string): Promise<number> {
  const link = await buildTestApp({ OUTFITTER_ROLE: "link" }, { store });
  const res = await link.fastify.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { authorization: `Bearer ${token}` },
  });
  await link.fastify.close();
  return res.statusCode;
}

describe("normalizeOwnerMatch", () => {
  test("lowercases and trims an email", () => {
    assert.deepEqual(normalizeOwnerMatch({ email: "  Alice@MGMS.eu " }), { email: "alice@mgms.eu" });
  });

  test("adds the leading @ to a bare domain", () => {
    assert.deepEqual(normalizeOwnerMatch({ domain: "Serviam-IT.hr" }), { domain: "@serviam-it.hr" });
    assert.deepEqual(normalizeOwnerMatch({ domain: "@serviam-it.hr" }), { domain: "@serviam-it.hr" });
  });

  test("rejects missing, both, and malformed inputs", () => {
    for (const input of [
      {},
      { email: "" },
      { email: "a@b.c", domain: "@b.c" },
      { email: "no-at-sign" },
      { email: "a@b@c" },
      { domain: "@" },
      { domain: "localhost" },
      { domain: "a@b.c" },
      { email: 42 },
      { domain: "@gmail.com" },
      { domain: "serviam-іt.hr" }, // Cyrillic і
      { email: "a\u200b@b.c" },
    ]) {
      assert.ok("error" in normalizeOwnerMatch(input), JSON.stringify(input));
    }
  });
});

describe("TokensCollection.revokeAllForOwners (MemoryStore)", () => {
  test("by email: revokes only that owner's active tokens, case-insensitively", async () => {
    const store = new MemoryStore();
    const a1 = tokenRow("Alice@mgms.eu");
    const a2 = tokenRow("alice@mgms.eu");
    const aOld = tokenRow("alice@mgms.eu", { revokedAt: "2026-01-01T00:00:00.000Z" });
    const b = tokenRow("bob@mgms.eu");
    for (const t of [a1, a2, aOld, b]) await store.tokens.insert(t);

    const at = "2026-09-22T12:00:00.000Z";
    const revoked = await store.tokens.revokeAllForOwners({ email: "alice@mgms.eu" }, at);
    assert.deepEqual(revoked.map((t) => t.id).sort(), [a1.id, a2.id].sort());
    assert.ok(revoked.every((t) => t.revokedAt === at));

    assert.equal((await store.tokens.findById(aOld.id))!.revokedAt, "2026-01-01T00:00:00.000Z");
    assert.equal((await store.tokens.findById(b.id))!.revokedAt, undefined);
  });

  test("by domain: only owners whose email ends in @domain, not look-alike domains", async () => {
    const store = new MemoryStore();
    const hit1 = tokenRow("a@serviam-it.hr");
    const hit2 = tokenRow("B@Serviam-IT.hr");
    const lookalike = tokenRow("c@notserviam-it.hr");
    const sub = tokenRow("d@mail.serviam-it.hr");
    const other = tokenRow("e@mgms.eu");
    for (const t of [hit1, hit2, lookalike, sub, other]) await store.tokens.insert(t);

    const revoked = await store.tokens.revokeAllForOwners({ domain: "@serviam-it.hr" }, new Date().toISOString());
    assert.deepEqual(revoked.map((t) => t.id).sort(), [hit1.id, hit2.id].sort());
    for (const t of [lookalike, sub, other]) {
      assert.equal((await store.tokens.findById(t.id))!.revokedAt, undefined, t.ownerEmail);
    }
  });

  test("a repeat call revokes nothing and leaves the first timestamp in place", async () => {
    const store = new MemoryStore();
    const t = tokenRow("alice@mgms.eu");
    await store.tokens.insert(t);
    await store.tokens.revokeAllForOwners({ email: "alice@mgms.eu" }, "2026-09-22T12:00:00.000Z");
    const second = await store.tokens.revokeAllForOwners({ email: "alice@mgms.eu" }, "2026-09-22T13:00:00.000Z");
    assert.deepEqual(second, []);
    assert.equal((await store.tokens.findById(t.id))!.revokedAt, "2026-09-22T12:00:00.000Z");
  });
});

describe("MongoTokens owner filter matches the memory store's", () => {
  const owners = [
    "alice@mgms.eu",
    "ALICE@MGMS.EU",
    "alice@mgms.eux",
    "xalice@mgms.eu",
    "a.b@mgms.eu",
    "aXb@mgms.eu",
    "c@serviam-it.hr",
    "c@notserviam-it.hr",
    "c@serviam-itXhr",
    "c@mail.serviam-it.hr",
    " alice@mgms.eu ",
    "alice@mgms.eu\n",
    "c@serviam-it.hr\n",
  ];
  const matches = [
    { email: "alice@mgms.eu" },
    { email: "a.b@mgms.eu" },
    { domain: "@serviam-it.hr" },
    { domain: "@mgms.eu" },
  ];
  for (const match of matches) {
    test(JSON.stringify(match), () => {
      const re = ownerEmailFilter(match);
      for (const owner of owners) {
        assert.equal(re.test(owner), ownerMatches(owner, match), owner);
      }
    });
  }
});

describe("POST /api/operator/tokens/revoke", () => {
  test("403 for a non-operator", async () => {
    const store = new MemoryStore();
    const own = await mintToken(store, "someone@mgms.eu");
    const app = await buildTestApp(OPERATOR_ENV, { store });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/operator/tokens/revoke",
      headers: { authorization: `Bearer ${own}` },
      payload: { email: "someone@mgms.eu" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(await linkStatus(store, own), 200);
    await app.fastify.close();
  });

  test("400 on a malformed body", async () => {
    const app = await buildTestApp();
    for (const payload of [{}, { email: "nope" }, { email: "a@b.c", domain: "@b.c" }]) {
      const res = await app.fastify.inject({ method: "POST", url: "/api/operator/tokens/revoke", payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.ok(res.json().error);
    }
    await app.fastify.close();
  });

  test("by email: the removed user's token stops working on the link role; others keep working", async () => {
    const store = new MemoryStore();
    const gone = await mintToken(store, "matej@serviam-it.hr");
    const stays = await mintToken(store, "alice@mgms.eu");
    assert.equal(await linkStatus(store, gone), 200);

    const app = await buildTestApp({}, { store });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/operator/tokens/revoke",
      payload: { email: "Matej@Serviam-IT.hr" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.match, { email: "matej@serviam-it.hr" });
    assert.deepEqual(body.owners, ["matej@serviam-it.hr"]);
    assert.equal(body.revoked.length, 1);
    assert.equal(body.revoked[0].hash, undefined);
    assert.ok(body.revoked[0].revokedAt);
    await app.fastify.close();

    assert.equal(await linkStatus(store, gone), 401);
    assert.equal(await linkStatus(store, stays), 200);
  });

  test("by domain: revokes every owner under it and lists them", async () => {
    const store = new MemoryStore();
    const a = await mintToken(store, "a@serviam-it.hr");
    const b = await mintToken(store, "b@serviam-it.hr");
    const c = await mintToken(store, "c@mgms.eu");

    const app = await buildTestApp({}, { store });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/operator/tokens/revoke",
      payload: { domain: "serviam-it.hr" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().owners, ["a@serviam-it.hr", "b@serviam-it.hr"]);
    assert.equal(res.json().revoked.length, 2);

    const again = await app.fastify.inject({
      method: "POST",
      url: "/api/operator/tokens/revoke",
      payload: { domain: "@serviam-it.hr" },
    });
    assert.deepEqual(again.json().revoked, []);
    await app.fastify.close();

    assert.equal(await linkStatus(store, a), 401);
    assert.equal(await linkStatus(store, b), 401);
    assert.equal(await linkStatus(store, c), 200);
  });
});

describe("token expiry", () => {
  test("a new token carries expiresAt = createdAt + 90 days", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "laptop" } });
    const { record } = res.json();
    assert.equal(Date.parse(record.expiresAt) - Date.parse(record.createdAt), TOKEN_TTL_MS);
    await app.fastify.close();
  });

  test("an expired token is rejected with the same generic error as a revoked one", async () => {
    const store = new MemoryStore();
    const plaintext = "outf_expired";
    await store.tokens.insert(
      tokenRow("alice@mgms.eu", { hash: hashToken(plaintext), expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    await assert.rejects(identityFromApiToken(plaintext, store), /invalid or revoked API token/);
    assert.equal(await linkStatus(store, plaintext), 401);
  });

  test("a token minted before expiresAt existed expires TOKEN_TTL_MS after createdAt", async () => {
    const store = new MemoryStore();
    const old = "outf_legacy_old";
    const recent = "outf_legacy_recent";
    await store.tokens.insert(
      tokenRow("alice@mgms.eu", { hash: hashToken(old), createdAt: new Date(Date.now() - TOKEN_TTL_MS - 1000).toISOString() }),
    );
    await store.tokens.insert(
      tokenRow("alice@mgms.eu", { hash: hashToken(recent), createdAt: new Date(Date.now() - 1000).toISOString() }),
    );
    await assert.rejects(identityFromApiToken(old, store), /invalid or revoked API token/);
    assert.equal((await identityFromApiToken(recent, store)).email, "alice@mgms.eu");
  });

  test("an unparsable expiry fails closed", async () => {
    const store = new MemoryStore();
    const plaintext = "outf_bad_date";
    await store.tokens.insert(tokenRow("alice@mgms.eu", { hash: hashToken(plaintext), expiresAt: "not a date" }));
    await assert.rejects(identityFromApiToken(plaintext, store), /invalid or revoked API token/);
  });

  test("expired tokens neither list, count toward the cap, nor show up in a revoke", async () => {
    const store = new MemoryStore();
    const past = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 10; i++) {
      await store.tokens.insert(tokenRow("dev@localhost", { expiresAt: past }));
    }
    assert.deepEqual(await store.tokens.listActiveForOwner("dev@localhost"), []);
    assert.equal(await store.tokens.countActiveForOwner("dev@localhost"), 0);

    const app = await buildTestApp({}, { store });
    const created = await app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "fresh" } });
    assert.equal(created.statusCode, 201);
    const revoked = await store.tokens.revokeAllForOwners({ email: "dev@localhost" }, new Date().toISOString());
    assert.deepEqual(revoked.map((t) => t.name), ["fresh"]);
    await app.fastify.close();
  });

  test("publicToken leaves out expiresAt when the stored dates don't parse", async () => {
    const { publicToken } = await import("../src/routes/tokens.ts");
    const out = publicToken(tokenRow("a@b.c", { createdAt: "garbage" }));
    assert.equal(out.expiresAt, undefined);
    assert.equal((out as { hash?: string }).hash, undefined);
  });
});
