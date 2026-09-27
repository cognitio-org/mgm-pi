/**
 * The session page's preview routes (#217 phase 3): list, person-made share links, close. Share
 * links come only from here, and only from the floppy's owner or a sysop.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { generateToken, hashToken, tokenPrefix } from "../src/tokens.ts";
import type { Run, Store } from "../src/store/types.ts";
import { FakeNgrok } from "./fake-ngrok.ts";

const RUN_ID = "3f2a9c1e-0000-4000-8000-00000000abcd";

async function bearerFor(store: Store, email: string): Promise<Record<string, string>> {
  const token = generateToken();
  await store.tokens.insert({ id: crypto.randomUUID(), ownerEmail: email, name: "test", prefix: tokenPrefix(token), hash: hashToken(token), createdAt: new Date().toISOString() });
  return { authorization: `Bearer ${token}` };
}

/** A session owned by owner@example.com with a live run whose model has previewed port 3000. */
async function setup(env: Record<string, string> = { PREVIEW_DOMAIN: "kernal.run", PREVIEW_ALLOW: "domain:example.com" }) {
  const store = new MemoryStore();
  const ngrok = new FakeNgrok();
  const app = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "sysop@example.com", ...env }, { store, ngrok });
  const now = new Date().toISOString();
  await store.sessions.insert({ id: "s1", guruId: "g", repo: null, status: "open", cost: 0, ownerEmail: "owner@example.com", createdAt: now, updatedAt: now });
  const run = { id: RUN_ID, sessionId: "s1", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now } as unknown as Run;
  await store.runs.insert(run);
  if (app.previews.enabled) {
    await app.previews.runSpecConfig(run);
    await store.runs.update(RUN_ID, { startup: { specSentAt: now } as any });
    await app.previews.open(RUN_ID, 3000, false);
  }
  const owner = await bearerFor(store, "owner@example.com");
  const other = await bearerFor(store, "someone@example.com");
  const sysop = await bearerFor(store, "sysop@example.com");
  return { app, store, ngrok, owner, other, sysop };
}

const list = (app: TestApp, headers: Record<string, string>) => app.fastify.inject({ method: "GET", url: "/api/sessions/s1/previews", headers });
const share = (app: TestApp, headers: Record<string, string>, port = 3000, ttlSeconds?: number) =>
  app.fastify.inject({ method: "POST", url: `/api/sessions/s1/previews/${port}/share`, headers, payload: ttlSeconds ? { ttlSeconds } : {} });

describe("preview routes", () => {
  test("GET lists the live run's previews for any viewer; only the owner or a sysop may share", async () => {
    const { app, owner, other, sysop } = await setup();
    const asOther = (await list(app, other)).json();
    assert.equal(asOther.enabled, true);
    assert.equal(asOther.canShare, false);
    assert.equal(asOther.previews.length, 1);
    assert.equal(asOther.previews[0].port, 3000);
    assert.equal(asOther.previews[0].share, false);
    assert.match(asOther.previews[0].url, /^https:\/\/[0-9a-f]{32}\.kernal\.run$/);
    assert.equal((await list(app, owner)).json().canShare, true);
    assert.equal((await list(app, sysop)).json().canShare, true);
    await app.fastify.close();
  });

  test("POST share: owner only, only a port the model previewed, TTL clamped to the maximum", async () => {
    const { app, ngrok, owner, other } = await setup();
    assert.equal((await share(app, other)).statusCode, 403);
    const none = await share(app, owner, 4000);
    assert.equal(none.statusCode, 409);
    assert.match(none.json().error, /no preview of port 4000/);
    const before = Date.now();
    const made = await share(app, owner, 3000, 3600);
    assert.equal(made.statusCode, 200, made.body);
    const body = made.json();
    assert.equal(body.share, true);
    assert.match(body.url, /^https:\/\/[0-9a-f]{32}\.kernal\.run$/);
    const ttl = (Date.parse(body.expiresAt) - before) / 1000;
    assert.ok(ttl > 3500 && ttl <= 3610, `ttl ${ttl}`);
    const policy = JSON.parse([...ngrok.endpoints.values()].find((e) => e.url === body.url)!.trafficPolicy);
    assert.match(policy.on_http_request[0].expressions[0], /__kernal_preview_ack/, "the share policy, with its notice");
    // a TTL past the maximum is clamped (a fresh share: close the first)
    await app.fastify.inject({ method: "DELETE", url: `/api/sessions/s1/previews/${body.id}`, headers: owner });
    const long = (await share(app, owner, 3000, 365 * 24 * 3600)).json();
    assert.ok((Date.parse(long.expiresAt) - Date.now()) / 1000 <= 7 * 24 * 3600 + 5);
    assert.equal((await list(app, owner)).json().previews.length, 2);
    await app.fastify.close();
  });

  test("DELETE closes one preview: owner only, 404 when gone or malformed", async () => {
    const { app, ngrok, owner, other } = await setup();
    const id = (await list(app, owner)).json().previews[0].id;
    assert.equal((await app.fastify.inject({ method: "DELETE", url: `/api/sessions/s1/previews/${id}`, headers: other })).statusCode, 403);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: `/api/sessions/s1/previews/${id}`, headers: owner })).statusCode, 204);
    assert.equal(ngrok.endpoints.size, 0);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: `/api/sessions/s1/previews/${id}`, headers: owner })).statusCode, 404);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/sessions/s1/previews/not-an-id", headers: owner })).statusCode, 404);
    assert.equal((await list(app, owner)).json().previews.length, 0);
    await app.fastify.close();
  });

  test("a run that ended lists nothing and can't be shared", async () => {
    const { app, store, owner } = await setup();
    await store.runs.update(RUN_ID, { state: "stopped" });
    assert.deepEqual((await list(app, owner)).json().previews, []);
    assert.equal((await share(app, owner)).statusCode, 409);
    await app.fastify.close();
  });

  test("previews off: GET says so, POST is 503", async () => {
    const { app, owner } = await setup({});
    const body = (await list(app, owner)).json();
    assert.equal(body.enabled, false);
    assert.equal(body.canShare, false);
    assert.equal((await share(app, owner)).statusCode, 503);
    await app.fastify.close();
  });
});
