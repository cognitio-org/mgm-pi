// MongoTokens against a real MongoDB. Everything else in this suite runs on MemoryStore, so the
// Mongo filters -- the ones that decide whether a token still authenticates, and which tokens an
// operator's revoke actually revokes -- were only ever checked by reading them. This closes that
// gap for the part that matters most (docs/reports/api-tokens.md, deploy/README.md Rollback).
//
// Runs against a mongod this test starts itself (mongodb-memory-server; the binary is downloaded
// once and cached under ~/.cache/mongodb-binaries). To run it against a real deployment's cluster
// instead -- the same driver, the same server build -- point it at one:
//
//   OUTFITTER_TEST_MONGODB_URI="$(gcloud secrets versions access latest \
//     --secret=outfitter-mongodb-uri --project=outfitter-509211)" \
//     node --test test/mongo-tokens.test.ts
//
// Either way it creates its own `outfitter_tokentest_<random>` database and drops it afterwards,
// so pointing it at the production cluster touches nothing that is already there.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { ApiToken, TokensCollection, TokenOwnerMatch } from "../src/store/types.ts";
import { hashToken, isTokenActive, TOKEN_TTL_MS } from "../src/tokens.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_tokentest_${randomUUID().slice(0, 8)}`;

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

let seq = 0;
function tokenRow(ownerEmail: string, overrides: Partial<ApiToken> = {}): ApiToken {
  seq += 1;
  return {
    id: `t${seq}-${randomUUID().slice(0, 8)}`,
    ownerEmail,
    name: `token ${seq}`,
    prefix: "outf_abc",
    hash: hashToken(`outf_plain_${seq}_${randomUUID()}`),
    createdAt: iso(0),
    expiresAt: iso(TOKEN_TTL_MS),
    ...overrides,
  };
}

describe("MongoTokens against a real MongoDB", () => {
  let store: MongoStore;
  let tokens: TokensCollection;
  let server: { stop(): Promise<unknown> } | undefined;

  before(async () => {
    let uri = EXTERNAL_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      server = started;
      uri = started.getUri();
    }
    store = await MongoStore.connect(uri, DB_NAME);
    tokens = store.tokens;
  }, { timeout: 120_000 }); // first run downloads the mongod binary

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await store.client?.db(DB_NAME).dropDatabase();
    await store.close();
    await server?.stop();
  });

  test("insert, findById, findByHash round-trip without _id leaking out", async () => {
    const row = tokenRow("alice@mgms.eu");
    await tokens.insert(row);
    const byId = await tokens.findById(row.id);
    assert.deepEqual(byId, row);
    assert.equal((byId as { _id?: unknown })._id, undefined);
    assert.deepEqual(await tokens.findByHash(row.hash), row);
    assert.equal(await tokens.findById("no-such-token"), null);
  });

  test("listActiveForOwner and countActiveForOwner skip revoked and expired tokens", async () => {
    const owner = `list-${randomUUID().slice(0, 8)}@mgms.eu`;
    const live = tokenRow(owner);
    const revoked = tokenRow(owner, { revokedAt: iso(-1000) });
    const expired = tokenRow(owner, { expiresAt: iso(-1000) });
    // Minted before expiresAt existed: tokens.ts's fallback expires it TOKEN_TTL_MS after createdAt.
    const legacyOld = tokenRow(owner, { createdAt: iso(-TOKEN_TTL_MS - 1000), expiresAt: undefined });
    const legacyFresh = tokenRow(owner, { createdAt: iso(-1000), expiresAt: undefined });
    for (const row of [live, revoked, expired, legacyOld, legacyFresh]) await tokens.insert(row);

    const listed = await tokens.listActiveForOwner(owner);
    assert.deepEqual(listed.map((t) => t.id).sort(), [live.id, legacyFresh.id].sort());
    assert.equal(await tokens.countActiveForOwner(owner), 2);
    // The same rows, judged by the in-process rule the auth check uses.
    for (const row of [live, revoked, expired, legacyOld, legacyFresh]) {
      const stored = (await tokens.findById(row.id))!;
      assert.equal(
        isTokenActive(stored),
        listed.some((t) => t.id === row.id),
        `${row.id} (${stored.expiresAt ?? "no expiresAt"}${stored.revokedAt ? ", revoked" : ""})`,
      );
    }
  });

  test("an explicit revokedAt: null counts as active, as the auth check treats it", async () => {
    const owner = `null-${randomUUID().slice(0, 8)}@mgms.eu`;
    const row = tokenRow(owner);
    await tokens.insert(row);
    await tokens.update(row.id, { revokedAt: null as unknown as undefined });

    const stored = (await tokens.findById(row.id))!;
    assert.equal(isTokenActive(stored), true, "auth would accept it");
    assert.equal((await tokens.listActiveForOwner(owner)).length, 1, "so listing must show it");
    const revoked = await tokens.revokeAllForOwners({ email: owner }, iso(0));
    assert.deepEqual(revoked.map((t) => t.id), [row.id], "and a revoke must catch it");
  });

  test("revokeAllForOwners by email: case- and whitespace-insensitive, only that owner's active tokens", async () => {
    const tag = randomUUID().slice(0, 8);
    const mixedCase = tokenRow(`Alice-${tag}@MGMS.eu`);
    const padded = tokenRow(` alice-${tag}@mgms.eu `);
    const alreadyRevoked = tokenRow(`alice-${tag}@mgms.eu`, { revokedAt: "2026-01-01T00:00:00.000Z" });
    const expired = tokenRow(`alice-${tag}@mgms.eu`, { expiresAt: iso(-1000) });
    const other = tokenRow(`bob-${tag}@mgms.eu`);
    for (const row of [mixedCase, padded, alreadyRevoked, expired, other]) await tokens.insert(row);

    const at = iso(0);
    const revoked = await tokens.revokeAllForOwners({ email: `alice-${tag}@mgms.eu` }, at);
    assert.deepEqual(revoked.map((t) => t.id).sort(), [mixedCase.id, padded.id].sort());
    assert.ok(revoked.every((t) => t.revokedAt === at));
    assert.equal(revoked.every((t) => (t as { hash?: string }).hash !== undefined), true, "store returns full rows; the route strips hash");

    assert.equal((await tokens.findById(alreadyRevoked.id))!.revokedAt, "2026-01-01T00:00:00.000Z", "keeps its own timestamp");
    assert.equal((await tokens.findById(expired.id))!.revokedAt, undefined, "already dead, left alone");
    assert.equal((await tokens.findById(other.id))!.revokedAt, undefined, "another owner untouched");

    assert.deepEqual(await tokens.revokeAllForOwners({ email: `alice-${tag}@mgms.eu` }, iso(1000)), [], "a repeat is a no-op");
  });

  test("revokeAllForOwners by domain: that domain only, not look-alikes or subdomains", async () => {
    const tag = randomUUID().slice(0, 8);
    const domain = `@${tag}.example.com`;
    const hit = tokenRow(`a${domain}`);
    const hitUpper = tokenRow(`B@${tag.toUpperCase()}.EXAMPLE.COM`);
    const lookalike = tokenRow(`c@not${tag}.example.com`);
    const sub = tokenRow(`d@mail.${tag}.example.com`);
    const elsewhere = tokenRow(`e@${tag}.example.org`);
    for (const row of [hit, hitUpper, lookalike, sub, elsewhere]) await tokens.insert(row);

    const revoked = await tokens.revokeAllForOwners({ domain }, iso(0));
    assert.deepEqual(revoked.map((t) => t.id).sort(), [hit.id, hitUpper.id].sort());
    for (const row of [lookalike, sub, elsewhere]) {
      assert.equal((await tokens.findById(row.id))!.revokedAt, undefined, row.ownerEmail);
    }
  });

  test("an email with regex characters matches literally, not as a pattern", async () => {
    const tag = randomUUID().slice(0, 8);
    const literal = tokenRow(`a.b+c-${tag}@mgms.eu`);
    const wouldMatchIfRegex = tokenRow(`axbxc-${tag}@mgms.eu`);
    await tokens.insert(literal);
    await tokens.insert(wouldMatchIfRegex);

    const revoked = await tokens.revokeAllForOwners({ email: `a.b+c-${tag}@mgms.eu` }, iso(0));
    assert.deepEqual(revoked.map((t) => t.id), [literal.id]);
    assert.equal((await tokens.findById(wouldMatchIfRegex.id))!.revokedAt, undefined);
  });

  test("overlapping revokes sharing a timestamp each report only what they revoked", async () => {
    // The read-back used to match on `revokedAt` alone, so a later revoke whose match overlapped an
    // earlier one in the same millisecond -- one owner, then their whole domain -- reported the
    // earlier call's tokens as its own. Everything is revoked either way; the result was the lie.
    const tag = randomUUID().slice(0, 8);
    const domain = `@${tag}.example.com`;
    const alice = tokenRow(`alice${domain}`);
    const bob = tokenRow(`bob${domain}`);
    await tokens.insert(alice);
    await tokens.insert(bob);

    const sameMoment = iso(0);
    const byEmail = await tokens.revokeAllForOwners({ email: alice.ownerEmail }, sameMoment);
    const byDomain = await tokens.revokeAllForOwners({ domain }, sameMoment);
    assert.deepEqual(byEmail.map((t) => t.id), [alice.id]);
    assert.deepEqual(byDomain.map((t) => t.id), [bob.id], "only what this call revoked");
    assert.equal((await tokens.findById(alice.id))!.revokedAt, sameMoment, "both are revoked either way");
  });

  test("the Mongo store and the memory store agree on the same rows", async () => {
    // Its own domain, so this test's revokes can't touch rows the other tests left in the shared
    // scratch database -- and so both stores can be compared whole, not filtered down to our ids.
    const tag = randomUUID().slice(0, 8);
    const domain = `@${tag}.example.com`;
    const owner = `parity${domain}`;
    const rows = [
      tokenRow(owner),
      tokenRow(`PARITY@${tag.toUpperCase()}.EXAMPLE.COM`),
      tokenRow(owner, { revokedAt: iso(-1000) }),
      tokenRow(owner, { expiresAt: iso(-1000) }),
      tokenRow(owner, { createdAt: iso(-TOKEN_TTL_MS - 1000), expiresAt: undefined }),
      tokenRow(`other${domain}`),
      tokenRow(`sub@mail.${tag}.example.com`),
    ];
    const memory = new MemoryStore();
    for (const row of rows) {
      await tokens.insert(row);
      await memory.tokens.insert(row);
    }

    for (const owners of [{ email: owner }, { domain }] as TokenOwnerMatch[]) {
      const at = iso(0);
      const fromMongo = await tokens.revokeAllForOwners(owners, at);
      const fromMemory = await memory.tokens.revokeAllForOwners(owners, at);
      assert.deepEqual(fromMongo.map((t) => t.id).sort(), fromMemory.map((t) => t.id).sort(), JSON.stringify(owners));
    }
    // Both stores also agree on what is left active afterwards.
    assert.deepEqual(
      (await tokens.listActiveForOwner(owner)).map((t) => t.id),
      (await memory.tokens.listActiveForOwner(owner)).map((t) => t.id),
    );
  });
});
