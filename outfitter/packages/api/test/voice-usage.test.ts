// #257 voice spend: Deepgram usage read back by tag and priced with the configured rates, the
// periods (UTC day, ISO week, calendar month), the cache, the sysop per-person table, the routes,
// and the optional monthly cap on POST /api/voice/token. Deepgram is mocked through fetch.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";
import { VoiceService, voiceTag } from "../src/voice.ts";
import { VoiceUsage, spendPeriods, priced } from "../src/voice-usage.ts";

const RATES = { sttUsdPerMinute: 0.01, ttsUsdPer1kChars: 0.03 };
// Wednesday 2026-09-30, so this week started Monday 2026-09-28 and the month on 2026-09-01.
const NOW = new Date("2026-09-30T15:00:00Z");

function fakeFetch(routes: (url: URL) => unknown | Promise<unknown>) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Token dg-key");
    const body = await routes(url);
    if (body instanceof Response) return body;
    return Response.json(body);
  }) as typeof fetch;
  return { impl, urls };
}

const day = (start: string, hours: number, chars = 0) => ({ start, end: start, hours, tts: { characters: chars } });

function usage(fetchImpl: typeof fetch, cacheMs = 60_000) {
  return new VoiceUsage({ apiKey: "dg-key", projectId: "proj-1", rates: RATES, fetchImpl, now: () => NOW, cacheMs });
}

describe("spendPeriods", () => {
  test("UTC day, Monday-started week and calendar month", () => {
    assert.deepEqual(spendPeriods(NOW), { today: "2026-09-30", weekStart: "2026-09-28", monthStart: "2026-09-01" });
    // A Sunday belongs to the week that began the Monday before.
    assert.deepEqual(spendPeriods(new Date("2026-10-04T23:59:00Z")), { today: "2026-10-04", weekStart: "2026-09-28", monthStart: "2026-10-01" });
    // A Monday starts its own week.
    assert.equal(spendPeriods(new Date("2026-09-28T00:00:00Z")).weekStart, "2026-09-28");
  });
});

describe("VoiceUsage.forUser", () => {
  test("reads the person's tag from the earlier of week and month start, and buckets the days", async () => {
    const f = fakeFetch(() => ({
      results: [day("2026-09-10", 1), day("2026-09-28", 0.5), day("2026-09-30", 0.25, 2000)],
    }));
    const spend = await usage(f.impl).forUser("Alice@Example.com");
    const url = f.urls[0];
    assert.equal(url.pathname, "/v1/projects/proj-1/usage");
    assert.equal(url.searchParams.get("tag"), voiceTag("alice@example.com"));
    assert.equal(url.searchParams.get("start"), "2026-09-01");
    assert.equal(url.searchParams.get("end"), "2026-09-30");
    assert.deepEqual(spend.today, priced(15, 2000, RATES));
    assert.deepEqual(spend.week, priced(45, 2000, RATES));
    assert.deepEqual(spend.month, priced(105, 2000, RATES));
    assert.equal(spend.today.usd, 15 * 0.01 + 2 * 0.03);
    assert.equal(spend.asOf, NOW.toISOString());
  });

  test("a week that began last month reaches back into it for the week figure only", async () => {
    const early = new Date("2026-10-02T12:00:00Z"); // Friday; week began Monday 2026-09-28
    const f = fakeFetch(() => ({ results: [day("2026-09-29", 1), day("2026-10-01", 1)] }));
    const u = new VoiceUsage({ apiKey: "dg-key", projectId: "proj-1", rates: RATES, fetchImpl: f.impl, now: () => early });
    const spend = await u.forUser("a@b.c");
    assert.equal(f.urls[0].searchParams.get("start"), "2026-09-28");
    assert.equal(spend.week.minutes, 120);
    assert.equal(spend.month.minutes, 60);
  });

  test("caches for the configured time; a failure isn't cached", async () => {
    let calls = 0;
    let fail = true;
    const f = fakeFetch(() => {
      calls++;
      if (fail) return new Response("{}", { status: 500 });
      return { results: [] };
    });
    const u = usage(f.impl);
    await assert.rejects(u.forUser("a@b.c"), /deepgram usage 500/);
    fail = false;
    await u.forUser("a@b.c");
    await u.forUser("a@b.c");
    assert.equal(calls, 2);
  });

  test("enabled needs both the key and the project", () => {
    assert.equal(usage(fakeFetch(() => ({})).impl).enabled, true);
    assert.equal(new VoiceUsage({ apiKey: "k", projectId: "", rates: RATES }).enabled, false);
    assert.equal(new VoiceUsage({ apiKey: "", projectId: "p", rates: RATES }).enabled, false);
  });
});

describe("VoiceUsage.forProject", () => {
  test("groups the month by tag, names known people, and keeps untagged (laptop) use apart", async () => {
    const alice = voiceTag("alice@example.com");
    const f = fakeFetch(() => ({
      results: [
        { hours: 0.5, tts_characters: 0, grouping: { tags: [] } },
        { hours: 0.25, tts_characters: 1000, grouping: { tags: null } },
        { hours: 1, tts_characters: 0, grouping: { tags: [alice] } },
        { hours: 0.1, tts_characters: 0, grouping: { tags: ["outfitter-user-unknown"] } },
      ],
    }));
    const p = await usage(f.impl).forProject((tag) => (tag === alice ? "alice@example.com" : undefined));
    const url = f.urls[0];
    assert.equal(url.pathname, "/v1/projects/proj-1/usage/breakdown");
    assert.equal(url.searchParams.get("grouping"), "tags");
    assert.equal(url.searchParams.get("start"), "2026-09-01");
    assert.deepEqual(
      p.users.map((u) => [u.email ?? null, u.tag, Math.round(u.minutes)]),
      [["alice@example.com", alice, 60], [null, "outfitter-user-unknown", 6]],
    );
    assert.equal(Math.round(p.untagged.minutes), 45);
    assert.equal(p.untagged.ttsCharacters, 1000);
    assert.equal(Math.round(p.total.minutes), 111);
  });
});

function voiceApp(usageImpl: VoiceUsage, env: Record<string, string> = {}) {
  const mintFetch = (async () => Response.json({ access_token: "jwt", expires_in: 30 })) as typeof fetch;
  const voice = new VoiceService({ apiKey: "dg-key", model: "nova-3", language: "en", ttlSeconds: 30, perMinute: 20, fetchImpl: mintFetch });
  return buildTestApp(env, { voice, voiceUsage: usageImpl });
}

describe("GET /api/me/voice/spend", () => {
  test("the caller's figures with rates, and the cap when there is one", async () => {
    const f = fakeFetch(() => ({ results: [day("2026-09-30", 0.5)] }));
    const app = await voiceApp(usage(f.impl), { VOICE_MONTHLY_CAP_USD: "5" });
    const res = await app.fastify.inject({ method: "GET", url: "/api/me/voice/spend" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.available, true);
    assert.equal(body.currency, "USD");
    assert.equal(body.today.minutes, 30);
    assert.equal(body.month.usd, 0.3);
    assert.deepEqual(body.rates, RATES);
    assert.equal(body.capUsd, 5);
    assert.equal(f.urls[0].searchParams.get("tag"), voiceTag("dev@localhost"));
    await app.fastify.close();
  });

  test("not configured: available false, and Deepgram isn't called", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/me/voice/spend" });
    assert.deepEqual(res.json(), { available: false });
    await app.fastify.close();
  });

  test("502 when Deepgram's usage can't be read", async () => {
    const app = await voiceApp(usage(fakeFetch(() => new Response("{}", { status: 403 })).impl));
    const res = await app.fastify.inject({ method: "GET", url: "/api/me/voice/spend" });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "voice_usage_upstream" });
    await app.fastify.close();
  });
});

describe("GET /api/operator/voice/spend", () => {
  test("names the people it knows from the users collection", async () => {
    const f = fakeFetch(() => ({
      results: [
        { hours: 1, grouping: { tags: [voiceTag("dev@localhost")] } },
        { hours: 0.5, grouping: { tags: [] } },
      ],
    }));
    const app = await voiceApp(usage(f.impl));
    await app.store.users.upsertSeen("dev@localhost");
    const res = await app.fastify.inject({ method: "GET", url: "/api/operator/voice/spend" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.users[0].email, "dev@localhost");
    assert.equal(body.users[0].minutes, 60);
    assert.equal(body.untagged.minutes, 30);
    await app.fastify.close();
  });
});

describe("POST /api/voice/token with VOICE_MONTHLY_CAP_USD", () => {
  test("refuses at or over the cap with voice_cap_reached", async () => {
    const f = fakeFetch(() => ({ results: [day("2026-09-10", 10)] })); // 600 min * $0.01 = $6
    const app = await voiceApp(usage(f.impl), { VOICE_MONTHLY_CAP_USD: "6" });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "voice_cap_reached", capUsd: 6, monthUsd: 6 });
    await app.fastify.close();
  });

  test("under the cap mints as usual", async () => {
    const f = fakeFetch(() => ({ results: [day("2026-09-10", 1)] }));
    const app = await voiceApp(usage(f.impl), { VOICE_MONTHLY_CAP_USD: "6" });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().token, "jwt");
    await app.fastify.close();
  });

  test("an unreadable usage API doesn't take the mic away", async () => {
    const app = await voiceApp(usage(fakeFetch(() => new Response("{}", { status: 500 })).impl), { VOICE_MONTHLY_CAP_USD: "6" });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 200);
    await app.fastify.close();
  });

  test("a hanging usage read doesn't hold the mic: it mints after about 1.5 s", async () => {
    const hang = (() => new Promise<Response>(() => {})) as typeof fetch;
    const app = await voiceApp(usage(hang), { VOICE_MONTHLY_CAP_USD: "6" });
    const t0 = Date.now();
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    const took = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    assert.ok(took >= 1400 && took < 4000, `took ${took} ms`);
    await app.fastify.close();
  });

  test("compared in cents, as shown: $4.996 against a $5 cap is refused", async () => {
    const f = fakeFetch(() => ({ results: [day("2026-09-10", 4.996 / 0.6)] })); // $4.996 at $0.01/min
    const app = await voiceApp(usage(f.impl), { VOICE_MONTHLY_CAP_USD: "5" });
    const res = await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(res.statusCode, 403);
    await app.fastify.close();
  });

  test("no cap: usage isn't read at all", async () => {
    const f = fakeFetch(() => ({ results: [] }));
    const app = await voiceApp(usage(f.impl));
    await app.fastify.inject({ method: "POST", url: "/api/voice/token" });
    assert.equal(f.urls.length, 0);
    await app.fastify.close();
  });
});
