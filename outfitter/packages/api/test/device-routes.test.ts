// #390 CA-1 (docs/specs/central-auth.md §1.3-§1.8): the device-code flow over HTTP, across a link
// app and a web app sharing one store, the way the two Cloud Run services share Atlas. People sign
// in to the web app through (fake) IAP (device-iap.ts); Kernal talks to link with no credential,
// then with its device token. Also the Dongle fixes and device tokens in the auth preHandler.

import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { TEST_IAP_AUDIENCE, iapHeaders, useFakeIap } from "./device-iap.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/types.ts";
import { generateToken, hashToken, tokenPrefix } from "../src/tokens.ts";
import { DEVICE_CODE_GRANT_TYPE } from "../src/central/device-tokens.ts";

const ALLOW = "user:alice@example.com;domain:example.org";
const COMMON = { OUTFITTER_DEV: "0", OUTFITTER_LOGIN_ALLOW: ALLOW, OUTFITTER_OPERATORS: "sysop@example.com" };

interface Pair {
  store: Store;
  link: TestApp;
  web: TestApp;
  close(): Promise<void>;
}

async function pair(t: TestContext, env: Record<string, string> = {}): Promise<Pair> {
  useFakeIap(t);
  const store = new MemoryStore();
  const link = await buildTestApp({ ...COMMON, OUTFITTER_ROLE: "link", OUTFITTER_WEB_ORIGIN: "https://app.example.com", ...env }, { store });
  const web = await buildTestApp({ ...COMMON, OUTFITTER_ROLE: "web", IAP_AUDIENCE: TEST_IAP_AUDIENCE, ...env }, { store });
  return {
    store,
    link,
    web,
    async close() {
      for (const app of [link, web]) {
        app.stopBackgroundTasks();
        await app.fastify.close();
      }
    },
  };
}

async function dongleFor(store: Store, email: string): Promise<Record<string, string>> {
  const token = generateToken();
  await store.tokens.insert({ id: crypto.randomUUID(), ownerEmail: email, name: "t", prefix: tokenPrefix(token), hash: hashToken(token), createdAt: new Date().toISOString() });
  return { authorization: `Bearer ${token}` };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Kernal asks, `approver` approves on the web, Kernal's next poll gets the tokens. */
async function login(p: Pair, approver = "alice@example.com", ip = "198.51.100.7") {
  const code = await p.link.fastify.inject({
    method: "POST",
    url: "/api/device/code",
    headers: { "x-forwarded-for": `10.0.0.1, ${ip}` },
    payload: { deviceName: "mbp-alice", platform: "darwin-arm64", kernalVersion: "0.3.0" },
  });
  assert.equal(code.statusCode, 200, code.body);
  const { device_code, user_code } = code.json();
  const approved = await p.web.fastify.inject({
    method: "POST",
    url: "/api/device/approve",
    headers: iapHeaders(approver, { "x-forwarded-for": "203.0.113.9" }),
    payload: { userCode: user_code, approve: true },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  const tokens = await p.link.fastify.inject({
    method: "POST",
    url: "/api/device/token",
    payload: { grant_type: DEVICE_CODE_GRANT_TYPE, device_code },
  });
  assert.equal(tokens.statusCode, 200, tokens.body);
  return tokens.json() as { access_token: string; refresh_token: string; device: { id: string; name: string }; account: { email: string }; delivery: object; problems: string[] };
}

describe("device login over HTTP", () => {
  test("code on link → approve on web → tokens on link; the access token works on both roles", async (t) => {
    const p = await pair(t);
    const code = await p.link.fastify.inject({ method: "POST", url: "/api/device/code", payload: { deviceName: "mbp-alice" } });
    const body = code.json();
    assert.equal(body.verification_uri, "https://app.example.com/device");
    assert.equal(body.interval, 5);

    const pending = await p.link.fastify.inject({ method: "POST", url: "/api/device/token", payload: { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: body.device_code } });
    assert.equal(pending.statusCode, 400);
    assert.deepEqual(pending.json(), { error: "authorization_pending" });

    const shown = await p.web.fastify.inject({ method: "GET", url: `/api/device/pending?code=${body.user_code.toLowerCase()}`, headers: iapHeaders("alice@example.com") });
    assert.equal(shown.statusCode, 200, shown.body);
    assert.equal(shown.json().userCode, body.user_code);
    assert.equal(shown.json().deviceName, "mbp-alice");
    assert.ok(shown.json().requestedAt && shown.json().expiresAt);

    const tokens = await login(p);
    assert.deepEqual(tokens.account.email, "alice@example.com");
    assert.deepEqual(tokens.delivery, {}, "no minting configured in tests");
    assert.deepEqual(tokens.problems, []);
    for (const app of [p.link, p.web]) {
      const me = await app.fastify.inject({ method: "GET", url: "/api/me", headers: bearer(tokens.access_token) });
      assert.equal(me.statusCode, 200, me.body);
      assert.equal(me.json().email, "alice@example.com");
      assert.equal(me.json().operator, false);
    }
    await p.close();
  });

  test("the approve page's endpoints refuse a Dongle and a device token: a person approves", async (t) => {
    const p = await pair(t);
    const tokens = await login(p);
    const dongle = await dongleFor(p.store, "alice@example.com");
    const code = (await p.link.fastify.inject({ method: "POST", url: "/api/device/code", payload: { deviceName: "other" } })).json();
    for (const headers of [dongle, bearer(tokens.access_token)]) {
      const approve = await p.web.fastify.inject({ method: "POST", url: "/api/device/approve", headers, payload: { userCode: code.user_code, approve: true } });
      assert.equal(approve.statusCode, 403);
      assert.equal(approve.json().error, "a person must approve this in the web app");
      const pending = await p.web.fastify.inject({ method: "GET", url: `/api/device/pending?code=${code.user_code}`, headers });
      assert.equal(pending.statusCode, 403);
      assert.equal((await p.web.fastify.inject({ method: "GET", url: "/api/me/devices", headers })).statusCode, 403);
    }
    await p.close();
  });

  test("approve: allow-list, bad bodies, unknown and decided codes", async (t) => {
    const p = await pair(t);
    const code = (await p.link.fastify.inject({ method: "POST", url: "/api/device/code", payload: { deviceName: "x" } })).json();
    const approve = (email: string, payload: object) => p.web.fastify.inject({ method: "POST", url: "/api/device/approve", headers: iapHeaders(email), payload });

    const outsider = await approve("mallory@example.com", { userCode: code.user_code, approve: true });
    assert.equal(outsider.statusCode, 403);
    assert.equal(outsider.json().error, "access_denied");
    assert.equal((await approve("alice@example.com", { userCode: code.user_code })).statusCode, 400);
    assert.equal((await approve("alice@example.com", { userCode: "nope", approve: true })).statusCode, 400);
    assert.equal((await approve("alice@example.com", { userCode: "BCDF-GHJK", approve: true })).statusCode, 409);

    const unknown = await p.web.fastify.inject({ method: "GET", url: "/api/device/pending?code=BCDF-GHJK", headers: iapHeaders("alice@example.com") });
    assert.equal(unknown.statusCode, 404);
    assert.deepEqual(unknown.json(), { error: "unknown_code" });

    const denied = await approve("mallory@example.com", { userCode: code.user_code, approve: false });
    assert.deepEqual(denied.json(), { status: "denied" }, "anyone signed in may deny");
    const again = await approve("alice@example.com", { userCode: code.user_code, approve: true });
    assert.equal(again.statusCode, 409);
    assert.deepEqual(again.json(), { error: "not_pending" });
    const poll = await p.link.fastify.inject({ method: "POST", url: "/api/device/token", payload: { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: code.device_code } });
    assert.deepEqual(poll.json(), { error: "access_denied" });
    await p.close();
  });

  test("malformed bodies are invalid_request; revoke answers {} even for an unknown token", async (t) => {
    const p = await pair(t);
    const post = (url: string, payload: unknown) => p.link.fastify.inject({ method: "POST", url, payload: payload as object });
    for (const [url, payload] of [
      ["/api/device/code", {}],
      ["/api/device/code", { deviceName: "a".repeat(65) }],
      ["/api/device/token", { device_code: "kdc_x" }],
      ["/api/device/token", { grant_type: "refresh_token", device_code: "kdc_x" }],
      ["/api/device/refresh", { grant_type: DEVICE_CODE_GRANT_TYPE, refresh_token: "kdr_x" }],
      ["/api/device/revoke", {}],
    ] as const) {
      const res = await post(url, payload);
      assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
      assert.deepEqual(res.json(), { error: "invalid_request" });
    }
    const revoke = await post("/api/device/revoke", { token: "kdr_unknown" });
    assert.equal(revoke.statusCode, 200);
    assert.deepEqual(revoke.json(), {});
    const refresh = await post("/api/device/refresh", { grant_type: "refresh_token", refresh_token: "kdr_unknown" });
    assert.deepEqual(refresh.json(), { error: "invalid_grant" });
    await p.close();
  });

  test("refresh rotates over HTTP; logout revokes; the old tokens stop working", async (t) => {
    const p = await pair(t);
    const tokens = await login(p);
    const refreshed = await p.link.fastify.inject({ method: "POST", url: "/api/device/refresh", payload: { grant_type: "refresh_token", refresh_token: tokens.refresh_token } });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const next = refreshed.json();
    assert.equal(next.device.id, tokens.device.id);
    assert.equal(next.delivery, undefined);
    assert.equal(next.problems, undefined);
    assert.equal((await p.link.fastify.inject({ method: "GET", url: "/api/me", headers: bearer(next.access_token) })).statusCode, 200);

    const out = await p.link.fastify.inject({ method: "POST", url: "/api/device/revoke", payload: { token: next.refresh_token } });
    assert.deepEqual(out.json(), {});
    for (const token of [tokens.access_token, next.access_token]) {
      const me = await p.link.fastify.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
      assert.equal(me.statusCode, 401);
      assert.equal(me.json().error, "invalid or revoked API token", "the Dongle's generic refusal");
    }
    assert.equal((await p.store.devices.findById(tokens.device.id))?.revokedReason, "logout");
    await p.close();
  });

  test("an owner taken off the allow-list is refused at refresh and every device is signed out", async (t) => {
    const p = await pair(t);
    const tokens = await login(p, "bob@example.org");
    await p.close();
    const link = await buildTestApp({ ...COMMON, OUTFITTER_ROLE: "link", OUTFITTER_LOGIN_ALLOW: "user:alice@example.com" }, { store: p.store });
    const res = await link.fastify.inject({ method: "POST", url: "/api/device/refresh", payload: { grant_type: "refresh_token", refresh_token: tokens.refresh_token } });
    assert.deepEqual(res.json(), { error: "access_denied" });
    assert.equal((await p.store.devices.findById(tokens.device.id))?.revokedReason, "access-removed");
    assert.equal((await link.fastify.inject({ method: "GET", url: "/api/me", headers: bearer(tokens.access_token) })).statusCode, 401);
    link.stopBackgroundTasks();
    await link.fastify.close();
  });

  test("Devices page: lists the caller's own devices, newest first, no hashes; revoke is owner-only", async (t) => {
    const p = await pair(t);
    const first = await login(p);
    const second = await login(p);
    const bobs = await login(p, "bob@example.org");
    // A use of the token records where the device was last seen.
    await p.link.fastify.inject({ method: "GET", url: "/api/me", headers: { ...bearer(first.access_token), "x-forwarded-for": "192.0.2.44" } });

    const list = await p.web.fastify.inject({ method: "GET", url: "/api/me/devices", headers: iapHeaders("Alice@example.com") });
    assert.equal(list.statusCode, 200);
    const rows = list.json() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => r.id).sort(), [first.device.id, second.device.id].sort());
    const row = rows.find((r) => r.id === first.device.id)!;
    assert.equal(row.name, "mbp-alice");
    assert.equal(row.kind, "laptop");
    assert.equal(row.platform, "darwin-arm64");
    assert.equal(row.kernalVersion, "0.3.0");
    assert.equal(row.loginIp, "198.51.100.7");
    assert.equal(row.lastSeenIp, "192.0.2.44");
    assert.ok(row.lastSeenAt);
    assert.equal(row.routerKey, null);
    assert.ok(!/Hash|hash/.test(JSON.stringify(rows)), "never a hash");

    const notMine = await p.web.fastify.inject({ method: "DELETE", url: `/api/me/devices/${bobs.device.id}`, headers: iapHeaders("alice@example.com") });
    assert.equal(notMine.statusCode, 404);
    assert.deepEqual(notMine.json(), { error: "device not found" });
    const del = await p.web.fastify.inject({ method: "DELETE", url: `/api/me/devices/${first.device.id}`, headers: iapHeaders("alice@example.com") });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().id, first.device.id);
    assert.ok(del.json().revokedAt);
    assert.equal((await p.store.devices.findById(first.device.id))?.revokedReason, "revoked");
    assert.equal((await p.link.fastify.inject({ method: "GET", url: "/api/me", headers: bearer(first.access_token) })).statusCode, 401);
    assert.equal((await p.web.fastify.inject({ method: "DELETE", url: `/api/me/devices/${first.device.id}`, headers: iapHeaders("alice@example.com") })).statusCode, 404, "already revoked");
    const after = (await p.web.fastify.inject({ method: "GET", url: "/api/me/devices", headers: iapHeaders("alice@example.com") })).json();
    assert.deepEqual(after.map((r: { id: string }) => r.id), [second.device.id]);
    await p.close();
  });

  test("operators revoke by email or domain, and make machine tokens; others get 403", async (t) => {
    const p = await pair(t);
    const bob = await login(p, "bob@example.org");
    const carol = await login(p, "carol@example.org");
    const alice = await login(p, "alice@example.com");
    const op = iapHeaders("sysop@example.com");

    const refused = await p.web.fastify.inject({ method: "POST", url: "/api/operator/devices/revoke", headers: iapHeaders("alice@example.com"), payload: { email: "bob@example.org" } });
    assert.equal(refused.statusCode, 403);
    const dongleOp = await p.web.fastify.inject({ method: "POST", url: "/api/operator/devices/revoke", headers: await dongleFor(p.store, "sysop@example.com"), payload: { email: "bob@example.org" } });
    assert.equal(dongleOp.statusCode, 403, "an operator's Dongle is not an operator");

    assert.equal((await p.web.fastify.inject({ method: "POST", url: "/api/operator/devices/revoke", headers: op, payload: {} })).statusCode, 400);
    const byDomain = await p.web.fastify.inject({ method: "POST", url: "/api/operator/devices/revoke", headers: op, payload: { domain: "example.org" } });
    assert.equal(byDomain.statusCode, 200, byDomain.body);
    assert.deepEqual(byDomain.json().revoked.map((r: { id: string }) => r.id).sort(), [bob.device.id, carol.device.id].sort());
    assert.equal((await p.store.devices.findById(bob.device.id))?.revokedReason, "operator");
    assert.equal((await p.link.fastify.inject({ method: "GET", url: "/api/me", headers: bearer(alice.access_token) })).statusCode, 200);

    const made = await p.web.fastify.inject({ method: "POST", url: "/api/operator/machine-tokens", headers: op, payload: { name: "ci-e2e" } });
    assert.equal(made.statusCode, 201, made.body);
    assert.match(made.json().token, /^kda_/);
    assert.equal(made.json().device.kind, "machine");
    assert.equal(made.json().device.name, "ci-e2e");
    const me = await p.link.fastify.inject({ method: "GET", url: "/api/me", headers: bearer(made.json().token) });
    assert.equal(me.json().email, "sysop@example.com");
    const opsDevices = (await p.web.fastify.inject({ method: "GET", url: "/api/me/devices", headers: op })).json();
    assert.deepEqual(opsDevices.map((r: { id: string }) => r.id), [made.json().device.id], "on the operator's own Devices page");
    const notOp = await p.web.fastify.inject({ method: "POST", url: "/api/operator/machine-tokens", headers: iapHeaders("alice@example.com"), payload: { name: "x" } });
    assert.equal(notOp.statusCode, 403);
    assert.equal((await p.web.fastify.inject({ method: "POST", url: "/api/operator/machine-tokens", headers: op, payload: {} })).statusCode, 400);
    await p.close();
  });

  test("a machine token stops working once its owner is off both lists (it never refreshes)", async (t) => {
    const p = await pair(t);
    const made = await p.web.fastify.inject({ method: "POST", url: "/api/operator/machine-tokens", headers: iapHeaders("sysop@example.com"), payload: { name: "ci-e2e" } });
    assert.equal(made.statusCode, 201, made.body);
    const headers = bearer(made.json().token);
    assert.equal((await p.link.fastify.inject({ method: "GET", url: "/api/me", headers })).statusCode, 200);
    await p.close();
    // The next deploy drops the operator from OUTFITTER_OPERATORS; they were never on ALLOW.
    for (const role of ["link", "web"]) {
      const app = await buildTestApp({ ...COMMON, OUTFITTER_OPERATORS: "", OUTFITTER_ROLE: role, IAP_AUDIENCE: TEST_IAP_AUDIENCE }, { store: p.store });
      const refused = await app.fastify.inject({ method: "GET", url: "/api/me", headers });
      assert.equal(refused.statusCode, 401, role);
      assert.equal(refused.json().error, "invalid or revoked API token");
      await app.fastify.close();
    }
  });

  test("routes register per role: the public flow on link, the person's routes on web, both on all", async (t) => {
    const p = await pair(t);
    for (const url of ["/api/device/code", "/api/device/token", "/api/device/refresh", "/api/device/revoke"]) {
      assert.ok(p.link.fastify.hasRoute({ method: "POST", url }), url);
      assert.ok(!p.web.fastify.hasRoute({ method: "POST", url }), url);
    }
    for (const [method, url] of [["GET", "/api/device/pending"], ["POST", "/api/device/approve"], ["GET", "/api/me/devices"], ["DELETE", "/api/me/devices/:id"], ["POST", "/api/operator/devices/revoke"], ["POST", "/api/operator/machine-tokens"]] as const) {
      assert.ok(p.web.fastify.hasRoute({ method, url }), url);
      assert.ok(!p.link.fastify.hasRoute({ method, url }), url);
    }
    await p.close();
    const all = await buildTestApp({});
    assert.ok(all.fastify.hasRoute({ method: "POST", url: "/api/device/code" }));
    assert.ok(all.fastify.hasRoute({ method: "POST", url: "/api/device/approve" }));
    await all.fastify.close();
  });
});

describe("availability and rate limits (§1.9)", () => {
  test("no allow-list outside dev mode: login_unavailable", async () => {
    const link = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_ROLE: "link" });
    const res = await link.fastify.inject({ method: "POST", url: "/api/device/code", payload: { deviceName: "mbp" } });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "login_unavailable" });
    await link.fastify.close();
  });

  test("dev mode with no list: anyone, on role all, and verification_uri falls back to the origin", async () => {
    const all = await buildTestApp({ OUTFITTER_ORIGIN: "http://localhost:8080" });
    const code = (await all.fastify.inject({ method: "POST", url: "/api/device/code", payload: { deviceName: "mbp" } })).json();
    assert.equal(code.verification_uri, "http://localhost:8080/device");
    // dev mode: the person is dev@localhost.
    const approved = await all.fastify.inject({ method: "POST", url: "/api/device/approve", payload: { userCode: code.user_code, approve: true } });
    assert.equal(approved.statusCode, 200, approved.body);
    const tokens = (await all.fastify.inject({ method: "POST", url: "/api/device/token", payload: { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: code.device_code } })).json();
    assert.match(tokens.access_token, /^kda_/);
    // A device token is verified in dev mode too (it carries the device id), unlike a Dongle.
    const bad = await all.fastify.inject({ method: "GET", url: "/api/me", headers: bearer("kda_bogus") });
    assert.equal(bad.statusCode, 401);
    await all.fastify.close();
  });

  test("POST /api/device/code: 10 per IP per 10 minutes", async () => {
    const link = await buildTestApp({ ...COMMON, OUTFITTER_ROLE: "link" });
    const ask = (ip: string) => link.fastify.inject({ method: "POST", url: "/api/device/code", headers: { "x-forwarded-for": ip }, payload: { deviceName: "mbp" } });
    for (let i = 0; i < 10; i++) assert.equal((await ask("198.51.100.1")).statusCode, 200);
    const limited = await ask("198.51.100.1");
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, "rate_limited");
    assert.ok(limited.json().retryAfter > 0 && limited.json().retryAfter <= 600);
    assert.equal((await ask("198.51.100.2")).statusCode, 200, "another IP");
    // A caller can't pick a new IP: Cloud Run appends the real one after whatever it sent.
    assert.equal((await ask("192.0.2.200, 198.51.100.1")).statusCode, 429, "a spoofed leading hop");
    await link.fastify.close();
  });

  test("GET pending and POST approve: 20 per person per 10 minutes, together", async (t) => {
    const p = await pair(t);
    const look = () => p.web.fastify.inject({ method: "GET", url: "/api/device/pending?code=BCDF-GHJK", headers: iapHeaders("alice@example.com") });
    for (let i = 0; i < 19; i++) assert.equal((await look()).statusCode, 404);
    const approve = await p.web.fastify.inject({ method: "POST", url: "/api/device/approve", headers: iapHeaders("alice@example.com"), payload: { userCode: "BCDF-GHJK", approve: true } });
    assert.equal(approve.statusCode, 409, "the 20th");
    assert.equal((await look()).statusCode, 429);
    assert.equal((await p.web.fastify.inject({ method: "GET", url: "/api/device/pending?code=BCDF-GHJK", headers: iapHeaders("bob@example.org") })).statusCode, 404, "per person");
    await p.close();
  });
});

describe("Dongle fixes (§1.8)", () => {
  test("1: a Dongle or a device token can't mint tokens of either kind", async (t) => {
    const p = await pair(t);
    const device = await login(p);
    for (const headers of [await dongleFor(p.store, "alice@example.com"), bearer(device.access_token)]) {
      for (const payload of [{ name: "more" }, { name: "a2a", kind: "a2a" }]) {
        const res = await p.web.fastify.inject({ method: "POST", url: "/api/me/tokens", headers, payload });
        assert.equal(res.statusCode, 403, JSON.stringify(payload));
        assert.deepEqual(res.json(), { error: "tokens are created in the web app" });
      }
    }
    const person = await p.web.fastify.inject({ method: "POST", url: "/api/me/tokens", headers: iapHeaders("alice@example.com"), payload: { name: "laptop" } });
    assert.equal(person.statusCode, 410, "#399: not even a person in the web app makes a Dongle now");
    await p.close();
  });

  test("2: an operator's Dongle is not an operator on the all role", async () => {
    const store = new MemoryStore();
    const all = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "sysop@example.com" }, { store });
    const headers = await dongleFor(store, "sysop@example.com");
    assert.equal((await all.fastify.inject({ method: "GET", url: "/api/me", headers })).json().operator, false);
    const op = await all.fastify.inject({ method: "GET", url: "/api/operator/settings", headers });
    assert.equal(op.statusCode, 403);
    await all.fastify.close();
  });

  test("3: once the allow-list is set, a Dongle whose owner is not on it is refused, on link and web", async (t) => {
    useFakeIap(t);
    const store = new MemoryStore();
    const gone = await dongleFor(store, "former@example.com");
    const staying = await dongleFor(store, "bob@example.org");
    const operator = await dongleFor(store, "sysop@example.com");
    for (const role of ["link", "web"]) {
      const app = await buildTestApp({ ...COMMON, OUTFITTER_ROLE: role, IAP_AUDIENCE: TEST_IAP_AUDIENCE }, { store });
      const refused = await app.fastify.inject({ method: "GET", url: "/api/me", headers: gone });
      assert.equal(refused.statusCode, 401, role);
      assert.equal(refused.json().error, "invalid or revoked API token");
      assert.equal((await app.fastify.inject({ method: "GET", url: "/api/me", headers: staying })).statusCode, 200, role);
      assert.equal((await app.fastify.inject({ method: "GET", url: "/api/me", headers: operator })).statusCode, 200, `${role}: operators count as allowed`);
      await app.fastify.close();
    }
    // No list (a deploy without OUTFITTER_LOGIN_ALLOW): today's behaviour.
    const unset = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_ROLE: "link" }, { store });
    assert.equal((await unset.fastify.inject({ method: "GET", url: "/api/me", headers: gone })).statusCode, 200);
    await unset.fastify.close();
  });
});

describe("GET /api/me ip (for the approve page's warning)", () => {
  test("is the last X-Forwarded-For hop, the one Cloud Run appends; a hop the caller sent is ignored", async () => {
    const app = await buildTestApp({});
    const me = await app.fastify.inject({ method: "GET", url: "/api/me", headers: { "x-forwarded-for": "198.51.100.66, 203.0.113.5" } });
    assert.equal(me.json().ip, "203.0.113.5");
    const plain = await app.fastify.inject({ method: "GET", url: "/api/me", headers: { "x-forwarded-for": "203.0.113.5" } });
    assert.equal(plain.json().ip, "203.0.113.5");
    await app.fastify.close();
  });
});
