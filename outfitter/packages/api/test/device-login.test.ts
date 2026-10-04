// #390 CA-1 (docs/specs/central-auth.md §1): the device-code flow's logic (central/device-login.ts)
// on a MemoryStore with a fake clock and a DeviceLifecycle that records what it is told. The HTTP
// around it is device-routes.test.ts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Config } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { DeviceLifecycle } from "../src/central/device-lifecycle.ts";
import {
  RateLimiter,
  createMachineToken,
  decideDeviceCode,
  deviceForAccessToken,
  dongleOwnerAllowed,
  exchangeDeviceCode,
  isLoginAllowed,
  loginAvailable,
  parseDeviceCodeRequest,
  refreshDevice,
  revokeByToken,
  startDeviceCode,
} from "../src/central/device-login.ts";
import {
  ACCESS_TOKEN_TTL_MS,
  DEVICE_CODE_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  USER_CODE_ALPHABET,
  formatUserCode,
  hashToken,
  newDeviceId,
  newUserCode,
  normalizeUserCode,
} from "../src/central/device-tokens.ts";
import { userIdFor } from "../src/central/user-id.ts";

const ALLOW = "user:alice@example.com;domain:example.org;group:staff@example.com";

function config(env: Record<string, string> = {}): Config {
  return loadConfig({
    OUTFITTER_DEV: "0",
    OUTFITTER_ORIGIN: "https://link.example.com",
    OUTFITTER_WEB_ORIGIN: "https://app.example.com/",
    OUTFITTER_LOGIN_ALLOW: ALLOW,
    OUTFITTER_OPERATORS: "sysop@example.com",
    ...env,
  } as NodeJS.ProcessEnv);
}

/** Flow deps with a clock the test moves and a lifecycle that records every event. */
function setup(env: Record<string, string> = {}) {
  // Starts at the real time: the memory store's findPendingByUserCode reads the real clock.
  let nowMs = Date.now();
  const events: string[] = [];
  const lifecycle = new DeviceLifecycle();
  lifecycle.register({
    name: "router key",
    onLogin: async ({ device }) => {
      events.push(`login:${device.id}:${device.ownerEmail}`);
      return { routerKey: { key: "sk-test", baseUrl: "https://router.example/v1", alias: `kernal-device-${device.id}` } };
    },
    onRevoked: async ({ device, reason }) => {
      events.push(`revoked:${device.id}:${reason}`);
    },
  });
  const store = new MemoryStore();
  const deps = { store, config: config(env), deviceLifecycle: lifecycle, now: () => nowMs };
  return {
    store,
    deps,
    events,
    advance: (ms: number) => {
      nowMs += ms;
    },
    nowMs: () => nowMs,
  };
}

/** A login up to the first tokens: code, approval by `approver`, exchange. */
async function signIn(s: ReturnType<typeof setup>, approver = "alice@example.com") {
  const started = await startDeviceCode(s.deps, { deviceName: "mbp", platform: "darwin-arm64", kernalVersion: "0.3.0" }, "198.51.100.7");
  const code = await s.store.deviceCodes.findPendingByUserCode(normalizeUserCode(started.user_code)!);
  const decided = await decideDeviceCode(s.deps, code!, true, { email: approver, ip: "203.0.113.9" });
  assert.equal("status" in decided && decided.status, "approved");
  const exchanged = await exchangeDeviceCode(s.deps, started.device_code);
  assert.ok(exchanged.ok, JSON.stringify(exchanged));
  return { started, answer: exchanged.answer };
}

describe("token and code formats", () => {
  test("user codes use the alphabet, are normalized from what people type, and display XXXX-XXXX", () => {
    for (let i = 0; i < 50; i++) {
      const code = newUserCode();
      assert.match(code, new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`));
      assert.equal(normalizeUserCode(formatUserCode(code).toLowerCase()), code);
    }
    assert.equal(normalizeUserCode(" bcdf-ghjk "), "BCDFGHJK");
    assert.equal(normalizeUserCode("BCDF GHJ"), undefined, "7 letters");
    assert.equal(normalizeUserCode("BCDFGHJKL"), undefined, "9 letters");
    assert.equal(normalizeUserCode("AEIO-UBCD"), undefined, "vowels are dropped, leaving too few");
    assert.equal(normalizeUserCode(42), undefined);
    assert.equal(formatUserCode("BCDFGHJK"), "BCDF-GHJK");
  });

  test("device ids are dev_ + 16 base32 characters", () => {
    for (let i = 0; i < 20; i++) assert.match(newDeviceId(), /^dev_[a-z2-7]{16}$/);
  });

  test("POST /api/device/code bodies: name required and printable, the rest optional, at most 64", () => {
    assert.deepEqual(parseDeviceCodeRequest({ deviceName: "  mbp  " }), { deviceName: "mbp" });
    assert.deepEqual(parseDeviceCodeRequest({ deviceName: "mbp", platform: "linux-x64", kernalVersion: "" }), { deviceName: "mbp", platform: "linux-x64" });
    for (const bad of [null, "x", {}, { deviceName: "" }, { deviceName: "   " }, { deviceName: "a".repeat(65) }, { deviceName: "a\u0007b" }, { deviceName: "a‮b" }, { deviceName: 5 }, { deviceName: "ok", platform: 3 }, { deviceName: "ok", kernalVersion: "v".repeat(65) }]) {
      assert.equal(parseDeviceCodeRequest(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("allow-list (§1.6)", () => {
  test("emails exact, domains by suffix, groups ignored, operators always, case-insensitive", () => {
    const c = config();
    assert.ok(isLoginAllowed("Alice@Example.com", c));
    assert.ok(isLoginAllowed("bob@example.org", c));
    assert.ok(!isLoginAllowed("bob@sub.example.org.evil.com", c));
    assert.ok(!isLoginAllowed("bob@notexample.org", c));
    assert.ok(!isLoginAllowed("staff@example.com", c), "group: entries are ignored");
    assert.ok(isLoginAllowed("sysop@example.com", c), "operators always count");
    assert.ok(!isLoginAllowed("mallory@example.com", c));
  });

  test("empty list: dev mode allows everyone; otherwise no login, and Dongles are left alone", () => {
    const dev = config({ OUTFITTER_DEV: "1", OUTFITTER_LOGIN_ALLOW: "" });
    assert.ok(loginAvailable(dev));
    assert.ok(isLoginAllowed("anyone@example.net", dev));
    const prod = config({ OUTFITTER_LOGIN_ALLOW: "" });
    assert.ok(!loginAvailable(prod));
    assert.ok(!isLoginAllowed("anyone@example.net", prod));
    assert.ok(dongleOwnerAllowed("anyone@example.net", prod), "no list: Dongles keep today's behaviour");
    assert.ok(!dongleOwnerAllowed("anyone@example.net", config()), "a list: Dongles of people not on it stop");
  });
});

describe("RateLimiter", () => {
  test("counts per key in a sliding window and says how long to wait", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    assert.equal(limiter.take("a"), undefined);
    assert.equal(limiter.take("a"), undefined);
    assert.equal(limiter.take("a"), 60);
    assert.equal(limiter.take("b"), undefined, "per key");
    now = 30_000;
    assert.equal(limiter.take("a"), 30);
    now = 60_000;
    assert.equal(limiter.take("a"), undefined, "the first hit left the window");
  });
});

describe("device code → approve → token", () => {
  test("the happy path: pending, slow_down, approved, one device with hashed tokens, the login hook's delivery", async () => {
    const s = setup();
    const started = await startDeviceCode(s.deps, { deviceName: "mbp" }, "198.51.100.7");
    assert.match(started.device_code, /^kdc_[A-Za-z0-9_-]{43}$/);
    assert.match(started.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(started.verification_uri, "https://app.example.com/device");
    assert.equal(started.verification_uri_complete, `https://app.example.com/device?code=${started.user_code}`);
    assert.equal(started.expires_in, 600);
    assert.equal(started.interval, 5);

    const first = await exchangeDeviceCode(s.deps, started.device_code);
    assert.deepEqual(!first.ok && first.error, { error: "authorization_pending" });
    s.advance(2_000);
    const tooSoon = await exchangeDeviceCode(s.deps, started.device_code);
    assert.deepEqual(!tooSoon.ok && tooSoon.error, { error: "slow_down", interval: 10 });
    s.advance(6_000);
    const stillSoon = await exchangeDeviceCode(s.deps, started.device_code);
    assert.deepEqual(!stillSoon.ok && stillSoon.error, { error: "slow_down", interval: 15 }, "the new interval counts");
    s.advance(15_000);
    const pending = await exchangeDeviceCode(s.deps, started.device_code);
    assert.deepEqual(!pending.ok && pending.error, { error: "authorization_pending" });

    const code = await s.store.deviceCodes.findPendingByUserCode(normalizeUserCode(started.user_code)!);
    assert.equal(code?.requestIp, "198.51.100.7");
    assert.equal(code?.deviceCodeHash, hashToken(started.device_code), "only the hash is stored");
    const decided = await decideDeviceCode(s.deps, code!, true, { email: "Alice@Example.com", ip: "203.0.113.9" });
    assert.ok("status" in decided && decided.status === "approved" && /^dev_/.test(decided.deviceId!));

    const done = await exchangeDeviceCode(s.deps, started.device_code);
    assert.ok(done.ok);
    const a = done.answer;
    assert.equal(a.token_type, "Bearer");
    assert.match(a.access_token, /^kda_/);
    assert.match(a.refresh_token, /^kdr_/);
    assert.equal(a.expires_in, 3600);
    assert.equal(a.refresh_expires_in, 2592000);
    assert.deepEqual(a.account, { email: "alice@example.com", userId: userIdFor("alice@example.com") });
    assert.equal(a.device.id, "status" in decided ? decided.deviceId : "");
    assert.equal(a.device.name, "mbp");
    assert.equal(a.delivery.routerKey?.alias, `kernal-device-${a.device.id}`);
    assert.deepEqual(a.problems, []);
    assert.deepEqual(s.events, [`login:${a.device.id}:alice@example.com`]);

    const device = await s.store.devices.findById(a.device.id);
    assert.equal(device?.accessHash, hashToken(a.access_token));
    assert.equal(device?.refreshHash, hashToken(a.refresh_token));
    assert.equal(device?.loginIp, "198.51.100.7");
    assert.equal(device?.approvedIp, "203.0.113.9");
    assert.equal(device?.kind, "laptop");
    assert.equal(device?.accessExpiresAt, new Date(s.nowMs() + ACCESS_TOKEN_TTL_MS).toISOString());
    assert.equal(device?.refreshExpiresAt, new Date(s.nowMs() + REFRESH_TOKEN_TTL_MS).toISOString());
    assert.ok(!JSON.stringify(device).includes(a.access_token) && !JSON.stringify(device).includes(a.refresh_token));

    const again = await exchangeDeviceCode(s.deps, started.device_code);
    assert.deepEqual(!again.ok && again.error, { error: "invalid_grant" }, "a consumed code is spent");
  });

  test("two polls racing for one approved code: exactly one device", async () => {
    const s = setup();
    const started = await startDeviceCode(s.deps, { deviceName: "mbp" }, undefined);
    const code = await s.store.deviceCodes.findPendingByUserCode(normalizeUserCode(started.user_code)!);
    await decideDeviceCode(s.deps, code!, true, { email: "alice@example.com" });
    const results = await Promise.all([exchangeDeviceCode(s.deps, started.device_code), exchangeDeviceCode(s.deps, started.device_code)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.deepEqual(results.find((r) => !r.ok)?.error, { error: "invalid_grant" });
    assert.equal((await s.store.devices.listActiveForOwner("alice@example.com")).length, 1);
  });

  test("denied, expired, unknown and malformed codes", async () => {
    const s = setup();
    const denied = await startDeviceCode(s.deps, { deviceName: "a" }, undefined);
    const code = await s.store.deviceCodes.findPendingByUserCode(normalizeUserCode(denied.user_code)!);
    assert.deepEqual(await decideDeviceCode(s.deps, code!, false, { email: "mallory@example.com" }), { status: "denied" });
    assert.deepEqual(await decideDeviceCode(s.deps, code!, true, { email: "alice@example.com" }), { error: "not_pending" }, "decided once");
    const d = await exchangeDeviceCode(s.deps, denied.device_code);
    assert.deepEqual(!d.ok && d.error, { error: "access_denied" });

    const late = await startDeviceCode(s.deps, { deviceName: "b" }, undefined);
    s.advance(DEVICE_CODE_TTL_MS);
    const e = await exchangeDeviceCode(s.deps, late.device_code);
    assert.deepEqual(!e.ok && e.error, { error: "expired_token" });

    for (const bogus of ["kdc_nope", "kda_wrongkind", ""]) {
      const r = await exchangeDeviceCode(s.deps, bogus);
      assert.deepEqual(!r.ok && r.error, { error: "invalid_grant" }, bogus);
    }
    assert.deepEqual(s.events, []);
  });

  test("an approver removed from the allow-list before the exchange: access_denied, no device", async () => {
    const s = setup();
    const started = await startDeviceCode(s.deps, { deviceName: "mbp" }, undefined);
    const code = await s.store.deviceCodes.findPendingByUserCode(normalizeUserCode(started.user_code)!);
    await decideDeviceCode(s.deps, code!, true, { email: "bob@example.org" });
    s.deps.config = config({ OUTFITTER_LOGIN_ALLOW: "user:alice@example.com" });
    const r = await exchangeDeviceCode(s.deps, started.device_code);
    assert.deepEqual(!r.ok && r.error, { error: "access_denied" });
    assert.equal((await s.store.devices.listActiveForOwner("bob@example.org")).length, 0);
  });

  test("a failing login hook still signs the device in and says why", async () => {
    const s = setup();
    s.deps.deviceLifecycle.register({ name: "router key", onLogin: async () => { throw new Error("LiteLLM did not answer"); } });
    const { answer } = await signIn(s);
    assert.deepEqual(answer.problems, ["router key: LiteLLM did not answer"]);
    assert.equal(answer.delivery.routerKey?.key, "sk-test", "the working hook's delivery is kept");
  });

  test("a user-code collision retries with a new code", async () => {
    const s = setup();
    const original = s.store.deviceCodes.insert.bind(s.store.deviceCodes);
    let calls = 0;
    const { DuplicateDeviceCodeError } = await import("../src/store/devices.ts");
    s.store.deviceCodes.insert = async (code) => {
      calls++;
      if (calls === 1) throw new DuplicateDeviceCodeError("taken");
      return original(code);
    };
    const started = await startDeviceCode(s.deps, { deviceName: "mbp" }, undefined);
    assert.equal(calls, 2);
    assert.ok(await s.store.deviceCodes.findPendingByUserCode(normalizeUserCode(started.user_code)!));
  });
});

describe("refresh (§1.3)", () => {
  test("rotates both tokens; the old access token works until its own expiry, the old refresh token for the grace", async () => {
    const s = setup();
    const { answer: first } = await signIn(s);
    s.advance(50 * 60_000);
    const r = await refreshDevice(s.deps, first.refresh_token);
    assert.ok(r.ok);
    const second = r.answer;
    assert.notEqual(second.access_token, first.access_token);
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.equal(second.device.id, first.device.id);
    assert.ok(!("delivery" in second) && !("problems" in second), "delivery only on the first answer");

    assert.ok(await deviceForAccessToken(s.store, second.access_token, s.nowMs()));
    assert.ok(await deviceForAccessToken(s.store, first.access_token, s.nowMs()), "previous access token, before its expiry");
    assert.equal(await deviceForAccessToken(s.store, first.access_token, s.nowMs() + 10 * 60_000), null, "past its own expiry");

    // Within the grace, the replaced refresh token rotates again (a second Kernal process).
    s.advance(REFRESH_ROTATION_GRACE_MS - 1_000);
    const graced = await refreshDevice(s.deps, first.refresh_token);
    assert.ok(graced.ok, "within the grace");
    assert.deepEqual(s.events.filter((e) => e.startsWith("revoked")), []);
  });

  test("a replaced refresh token after the grace is a reuse: the device is revoked", async () => {
    const s = setup();
    const { answer: first } = await signIn(s);
    const r = await refreshDevice(s.deps, first.refresh_token);
    assert.ok(r.ok);
    s.advance(REFRESH_ROTATION_GRACE_MS + 1);
    const reuse = await refreshDevice(s.deps, first.refresh_token);
    assert.deepEqual(!reuse.ok && reuse.error, { error: "invalid_grant" });
    assert.ok(s.events.includes(`revoked:${first.device.id}:refresh-reuse`));
    const after = await refreshDevice(s.deps, r.answer.refresh_token);
    assert.deepEqual(!after.ok && after.error, { error: "invalid_grant" }, "the thief's copy and the owner's are both dead");
    assert.equal(await deviceForAccessToken(s.store, r.answer.access_token, s.nowMs()), null);
  });

  test("two refreshes racing with the same token both get a working pair", async () => {
    const s = setup();
    const { answer } = await signIn(s);
    const [a, b] = await Promise.all([refreshDevice(s.deps, answer.refresh_token), refreshDevice(s.deps, answer.refresh_token)]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    const d = await s.store.devices.findById(answer.device.id);
    assert.ok(!d?.revokedAt);
  });

  test("expired, unknown, revoked and wrong-kind refresh tokens: invalid_grant", async () => {
    const s = setup();
    const { answer } = await signIn(s);
    for (const bogus of ["kdr_unknown", answer.access_token, "outf_x"]) {
      const r = await refreshDevice(s.deps, bogus);
      assert.deepEqual(!r.ok && r.error, { error: "invalid_grant" }, bogus);
    }
    s.advance(REFRESH_TOKEN_TTL_MS);
    const expired = await refreshDevice(s.deps, answer.refresh_token);
    assert.deepEqual(!expired.ok && expired.error, { error: "invalid_grant" });
  });

  test("the sliding window: each rotation sets a fresh 30 days", async () => {
    const s = setup();
    const { answer } = await signIn(s);
    s.advance(REFRESH_TOKEN_TTL_MS - 60_000);
    const r = await refreshDevice(s.deps, answer.refresh_token);
    assert.ok(r.ok);
    s.advance(REFRESH_TOKEN_TTL_MS - 60_000);
    assert.ok((await refreshDevice(s.deps, r.answer.refresh_token)).ok);
  });

  test("an owner no longer on the allow-list: every device revoked (access-removed), access_denied", async () => {
    const s = setup();
    const { answer: one } = await signIn(s, "bob@example.org");
    const { answer: two } = await signIn(s, "bob@example.org");
    const { answer: alice } = await signIn(s, "alice@example.com");
    s.deps.config = config({ OUTFITTER_LOGIN_ALLOW: "user:alice@example.com" });
    const r = await refreshDevice(s.deps, one.refresh_token);
    assert.deepEqual(!r.ok && r.error, { error: "access_denied" });
    const revoked = s.events.filter((e) => e.startsWith("revoked")).sort();
    assert.deepEqual(revoked, [`revoked:${one.device.id}:access-removed`, `revoked:${two.device.id}:access-removed`].sort());
    assert.equal(await deviceForAccessToken(s.store, two.access_token, s.nowMs()), null);
    assert.ok(await deviceForAccessToken(s.store, alice.access_token, s.nowMs()), "someone else's device is untouched");
  });
});

describe("revoke (kernal logout)", () => {
  test("by refresh or access token; fires the hook once; unknown tokens are ignored", async () => {
    const s = setup();
    const { answer: a } = await signIn(s);
    const { answer: b } = await signIn(s);
    await revokeByToken(s.deps, a.refresh_token);
    await revokeByToken(s.deps, a.refresh_token);
    await revokeByToken(s.deps, b.access_token);
    await revokeByToken(s.deps, "kdr_unknown");
    await revokeByToken(s.deps, "nonsense");
    assert.deepEqual(s.events.filter((e) => e.startsWith("revoked")), [`revoked:${a.device.id}:logout`, `revoked:${b.device.id}:logout`]);
    assert.equal(await deviceForAccessToken(s.store, a.access_token, s.nowMs()), null);
    const r = await refreshDevice(s.deps, b.refresh_token);
    assert.deepEqual(!r.ok && r.error, { error: "invalid_grant" });
  });
});

describe("machine tokens (§1.7)", () => {
  test("an access token for 90 days, no refresh token, kind machine, no login hook", async () => {
    const s = setup();
    const { token, device } = await createMachineToken(s.deps, { email: "Sysop@example.com" }, "ci-e2e");
    assert.match(token, /^kda_/);
    assert.equal(device.kind, "machine");
    assert.equal(device.ownerEmail, "sysop@example.com");
    assert.equal(device.refreshHash, undefined);
    assert.ok(await deviceForAccessToken(s.store, token, s.nowMs() + 89 * 24 * 3600_000));
    assert.equal(await deviceForAccessToken(s.store, token, s.nowMs() + 91 * 24 * 3600_000), null);
    assert.deepEqual(s.events, []);
  });
});
