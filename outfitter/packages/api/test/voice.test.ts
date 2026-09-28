// #252 web voice: POST /api/voice/token mints short-lived Deepgram tokens (Deepgram mocked through
// an injected fetch), GET|PUT /api/me/voice keeps a person's preferences, and PUT
// /api/sessions/:id/voice picks a floppy's engine. The Mongo half of setVoicePrefs runs against a
// mongod this test starts itself, like mongo-tokens.test.ts.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "./helpers.ts";
import { VoiceService, voiceTag } from "../src/voice.ts";
import { MongoStore } from "../src/store/mongo.ts";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeDeepgram(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const granted = () => Response.json({ access_token: "jwt-abc", expires_in: 30 });

function service(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof VoiceService>[0]> = {}): VoiceService {
  return new VoiceService({ apiKey: "dg-key", model: "nova-3", language: "en", ttlSeconds: 30, perMinute: 20, fetchImpl, ...overrides });
}

async function seedSession(app: Awaited<ReturnType<typeof buildTestApp>>, id: string): Promise<void> {
  const now = new Date().toISOString();
  await app.store.sessions.insert({ id, guruId: "test-guru", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now });
}

describe("voiceTag", () => {
  test("is stable, case-insensitive and never contains the email", () => {
    const tag = voiceTag("Alice@Example.com");
    assert.equal(tag, voiceTag(" alice@example.com "));
    assert.match(tag, /^outfitter-user-[0-9a-f]{16}$/);
    assert.ok(!tag.includes("alice"));
    assert.notEqual(tag, voiceTag("bob@example.com"));
  });
});

describe("POST /api/voice/token", () => {
  test("mints a token with the Member key and returns model, language and the caller's tag", async () => {
    const dg = fakeDeepgram(granted);
    const app = await buildTestApp({}, { voice: service(dg.fetch) });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.token, "jwt-abc");
    assert.equal(body.model, "nova-3");
    assert.equal(body.language, "en");
    assert.equal(body.tag, voiceTag("dev@localhost"));
    assert.equal(res.headers["cache-control"], "no-store");
    assert.ok(Date.parse(body.expiresAt) > Date.now());
    assert.equal(dg.calls.length, 1);
    assert.equal(dg.calls[0].url, "https://api.deepgram.com/v1/auth/grant");
    assert.equal((dg.calls[0].init.headers as Record<string, string>).Authorization, "Token dg-key");
    assert.deepEqual(JSON.parse(String(dg.calls[0].init.body)), { ttl_seconds: 30 });
    await app.fastify.close();
  });

  test("404 voice_disabled without a key, and Deepgram is never called", async () => {
    const dg = fakeDeepgram(granted);
    const app = await buildTestApp({}, { voice: service(dg.fetch, { apiKey: "" }) });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "voice_disabled");
    assert.equal(dg.calls.length, 0);
    await app.fastify.close();
  });

  test("the default service reads DEEPGRAM_API_KEY: unset means disabled", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 404);
    await app.fastify.close();
  });

  test("502 voice_upstream when Deepgram refuses, without leaking its message", async () => {
    const dg = fakeDeepgram(() => Response.json({ err_code: "FORBIDDEN", err_msg: "Insufficient permissions." }, { status: 403 }));
    const app = await buildTestApp({}, { voice: service(dg.fetch) });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "voice_upstream" });
    await app.fastify.close();
  });

  test("502 when Deepgram can't be reached", async () => {
    const dg = fakeDeepgram(() => {
      throw new TypeError("fetch failed");
    });
    const app = await buildTestApp({}, { voice: service(dg.fetch) });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 502);
    await app.fastify.close();
  });

  test("429 with retry-after past the per-minute limit, per person", async () => {
    let now = 1_000_000;
    const dg = fakeDeepgram(granted);
    const voice = service(dg.fetch, { perMinute: 2, now: () => now });
    const app = await buildTestApp({}, { voice });
    for (let i = 0; i < 2; i++) {
      assert.equal((await app.fastify.inject({ method: "POST", url: "/api/voice/token" })).statusCode, 200);
    }
    now += 10_000;
    const limited = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, "voice_rate_limited");
    assert.equal(limited.headers["retry-after"], "50");
    assert.equal(limited.headers["cache-control"], "no-store");
    assert.equal(dg.calls.length, 2);
    // Someone else still gets one.
    assert.equal((await voice.mint("bob@example.com")).ok, true);
    // And the window slides.
    now += 50_000;
    assert.equal((await app.fastify.inject({ method: "POST", url: "/api/voice/token" })).statusCode, 200);
    await app.fastify.close();
  });

  test("isn't registered on the link role", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link" }, { voice: service(fakeDeepgram(granted).fetch) });
    // The link role answers 401 to anything without a personal token, so ask the router directly.
    assert.equal(app.fastify.hasRoute({ method: "POST", url: "/api/voice/token" }), false);
    assert.equal(app.fastify.hasRoute({ method: "PUT", url: "/api/sessions/:id/voice" }), false);
    await app.fastify.close();
  });
});

describe("GET|PUT /api/me/voice", () => {
  test("defaults to Send, and reports whether Deepgram is available", async () => {
    const on = await buildTestApp({}, { voice: service(fakeDeepgram(granted).fetch) });
    const res = await on.fastify.inject({ method: "GET", url: "/api/me/voice" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { deepgram: true, model: "nova-3", language: "en", prefs: { afterSpeaking: "send" } });
    await on.fastify.close();

    const off = await buildTestApp();
    assert.equal((await off.fastify.inject({ method: "GET", url: "/api/me/voice" })).json().deepgram, false);
    await off.fastify.close();
  });

  test("PUT stores Review and GET returns it; anything else is a 400", async () => {
    const app = await buildTestApp();
    const put = await app.fastify.inject({ method: "PUT", url: "/api/me/voice", payload: { afterSpeaking: "review" } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), { prefs: { afterSpeaking: "review" } });
    assert.equal((await app.fastify.inject({ method: "GET", url: "/api/me/voice" })).json().prefs.afterSpeaking, "review");
    const bad = await app.fastify.inject({ method: "PUT", url: "/api/me/voice", payload: { afterSpeaking: "shout" } });
    assert.equal(bad.statusCode, 400);
    await app.fastify.close();
  });
});

describe("PUT /api/sessions/:id/voice", () => {
  test("sets the engine, which GET /api/sessions/:id then carries", async () => {
    const app = await buildTestApp();
    await seedSession(app, "s-voice");
    const put = await app.fastify.inject({ method: "PUT", url: "/api/sessions/s-voice/voice", payload: { engine: "builtin" } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), { voiceEngine: "builtin" });
    const got = await app.fastify.inject({ method: "GET", url: "/api/sessions/s-voice" });
    assert.equal(got.json().voiceEngine, "builtin");
    await app.fastify.close();
  });

  test("400 for an unknown engine, 404 for an unknown session", async () => {
    const app = await buildTestApp();
    await seedSession(app, "s-voice");
    assert.equal((await app.fastify.inject({ method: "PUT", url: "/api/sessions/s-voice/voice", payload: { engine: "whisper" } })).statusCode, 400);
    assert.equal((await app.fastify.inject({ method: "PUT", url: "/api/sessions/nope/voice", payload: { engine: "builtin" } })).statusCode, 404);
    await app.fastify.close();
  });
});

describe("MongoUsers.setVoicePrefs against a real MongoDB", () => {
  const DB_NAME = `outfitter_voicetest_${randomUUID().slice(0, 8)}`;
  let store: MongoStore;
  let server: { stop(): Promise<unknown> } | undefined;

  before(async () => {
    let uri = process.env.OUTFITTER_TEST_MONGODB_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      server = started;
      uri = started.getUri();
    }
    store = await MongoStore.connect(uri, DB_NAME);
  }, { timeout: 120_000 });

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await store.client?.db(DB_NAME).dropDatabase();
    await store.close();
    await server?.stop();
  });

  test("creates the user when needed, replaces the prefs, and keeps the rest of the row", async () => {
    const created = await store.users.setVoicePrefs("new@example.com", { afterSpeaking: "review" });
    assert.equal(created.email, "new@example.com");
    assert.ok(created.createdAt);
    assert.deepEqual(created.voice, { afterSpeaking: "review" });

    const seen = await store.users.upsertSeen("seen@example.com");
    const updated = await store.users.setVoicePrefs("seen@example.com", { afterSpeaking: "send" });
    assert.equal(updated.createdAt, seen.createdAt);
    assert.equal(updated.lastSeenAt, seen.lastSeenAt);
    assert.deepEqual((await store.users.findByEmail("seen@example.com"))?.voice, { afterSpeaking: "send" });
    assert.equal((updated as { _id?: unknown })._id, undefined);
  });

  test("#257: list returns every user row without _id", async () => {
    const all = await store.users.list();
    const emails = all.map((u) => u.email).sort();
    assert.ok(emails.includes("new@example.com") && emails.includes("seen@example.com"));
    assert.ok(all.every((u) => (u as { _id?: unknown })._id === undefined));
  });
});
