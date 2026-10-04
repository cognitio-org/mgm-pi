/**
 * Kernal's Outfitter login (#391 CA-2, outfitter/docs/specs/central-auth.md §2): the device-code
 * flow, the index and secret storage, refresh with its cross-process lock, logout, the keychain
 * backends (with a fake `security`/`secret-tool`), and outfitter-env.ts's session-or-Dongle
 * credentials. No network: every request goes to a scripted fake fetch.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OUTFITTER_API,
  currentAccessToken,
  getAccessToken,
  getRouterKey,
  login,
  loginState,
  logout,
  outfitterApi,
  setRouterKey,
  type SessionStorage,
} from "../.pi/extensions/_shared/outfitter-session.ts";
import { chooseBackend, fileBackend, itemHash, keychainBackend, secretServiceBackend, type Runner } from "../.pi/extensions/_shared/keychain.ts";
import { outfitterBearer, outfitterCredentials } from "../.pi/extensions/_shared/outfitter-env.ts";

const API = "https://link.outfitter.test";
const HOUR = 3600;

type Call = { url: string; body: any };
type Reply = { status: number; body?: unknown } | Error;

/** A fetch that answers each path from its own queue (the last reply repeats) and records calls. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const queue = routes[path];
    if (!queue?.length) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const r = queue.length > 1 ? queue.shift()! : queue[0];
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls, paths: () => calls.map((c) => new URL(c.url).pathname) };
}

function storage(extra: Partial<SessionStorage> = {}): SessionStorage & { dir: string; notices: string[] } {
  const dir = join(mkdtempSync(join(tmpdir(), "kernal-auth-")), "auth");
  const notices: string[] = [];
  return { env: { KERNAL_AUTH_BACKEND: "file" }, authDir: dir, notice: (l) => notices.push(l), ...extra, dir, notices };
}

const CODE = {
  device_code: "kdc_abc",
  user_code: "BCDF-GHJK",
  verification_uri: "https://app.outfitter.test/device",
  verification_uri_complete: "https://app.outfitter.test/device?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};

function tokens(n: number, extra: Record<string, unknown> = {}) {
  return {
    token_type: "Bearer",
    access_token: `kda_${n}`,
    expires_in: HOUR,
    refresh_token: `kdr_${n}`,
    refresh_expires_in: 2592000,
    device: { id: `dev_${"a".repeat(15)}${n}`, name: "mbp-test" },
    account: { email: "a@example.com", userId: "u_123" },
    ...extra,
  };
}

const ROUTER_KEY = { key: "sk-device", baseUrl: "https://router.test/v1", alias: "kernal-device-dev_x", expiresAt: "2027-01-01T00:00:00.000Z" };

/** Signs in through the fake flow and returns the storage and the fetch. */
async function signedIn(extra: { now?: () => number; answer?: Record<string, unknown>; st?: ReturnType<typeof storage> } = {}) {
  const st = extra.st ?? storage();
  const f = fakeFetch({
    "/api/device/code": [{ status: 200, body: CODE }],
    "/api/device/token": [{ status: 200, body: tokens(1, { delivery: { routerKey: ROUTER_KEY }, problems: [], ...extra.answer }) }],
  });
  const lines: string[] = [];
  const account = await login({ ...st, api: API, print: (l) => lines.push(l), fetch: f.fn, openBrowser: false, sleep: async () => {}, now: extra.now, kernalVersion: "0.3.0" });
  return { st, account, lines, f };
}

describe("outfitterApi", () => {
  test("OUTFITTER_API trimmed and without a trailing slash, else link.kernal.one", () => {
    assert.equal(outfitterApi({}), DEFAULT_OUTFITTER_API);
    assert.equal(DEFAULT_OUTFITTER_API, "https://link.kernal.one");
    assert.equal(outfitterApi({ OUTFITTER_API: "  http://localhost:8080// " }), "http://localhost:8080");
    assert.equal(outfitterApi({ OUTFITTER_API: "  " }), DEFAULT_OUTFITTER_API);
  });
});

describe("login", () => {
  test("the device flow: code, pending, slow_down, approved; stored as one login", async () => {
    const st = storage();
    const f = fakeFetch({
      "/api/device/code": [{ status: 200, body: CODE }],
      "/api/device/token": [
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down", interval: 10 } },
        { status: 400, body: { error: "slow_down" } },
        { status: 200, body: tokens(1, { delivery: { routerKey: ROUTER_KEY }, problems: ["router key: LiteLLM did not answer"] }) },
      ],
    });
    const waits: number[] = [];
    const opened: string[] = [];
    const lines: string[] = [];
    const account = await login({
      ...st,
      api: `${API}/`,
      deviceName: "  mbp-test  ",
      print: (l) => lines.push(l),
      fetch: f.fn,
      openUrl: (u) => opened.push(u),
      sleep: async (ms) => void waits.push(ms),
      kernalVersion: "0.3.0",
    });
    assert.deepEqual(account, { api: API, email: "a@example.com", userId: "u_123", deviceId: "dev_aaaaaaaaaaaaaaa1", deviceName: "mbp-test" });
    assert.deepEqual(f.calls[0].body, { deviceName: "mbp-test", platform: `${process.platform}-${process.arch}`, kernalVersion: "0.3.0" });
    assert.deepEqual(f.calls[1].body, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "kdc_abc" });
    assert.deepEqual(waits, [5000, 5000, 10000, 15000], "interval, then slow_down's interval, then +5 s");
    assert.deepEqual(opened, [CODE.verification_uri_complete]);
    assert.ok(lines.some((l) => l.includes(CODE.verification_uri) && l.includes("BCDF-GHJK")), lines.join("\n"));
    assert.ok(lines.includes("warning: router key: LiteLLM did not answer"));

    assert.deepEqual(loginState({ ...st, api: API }), { signedIn: true, account });
    assert.deepEqual(getRouterKey({ ...st, api: API }), ROUTER_KEY);
    const index = JSON.parse(readFileSync(join(st.dir, "accounts.json"), "utf8"));
    assert.equal(index.version, 1);
    assert.deepEqual(index.defaults, { [API]: "a@example.com" });
    assert.equal(index.accounts[0].backend, "file");
    assert.ok(!JSON.stringify(index).includes("kda_") && !JSON.stringify(index).includes("kdr_") && !JSON.stringify(index).includes("sk-"), "no secret in the index");
    assert.equal(statSync(join(st.dir, "accounts.json")).mode & 0o777, 0o600);
    assert.equal(statSync(st.dir).mode & 0o777, 0o700);
    const secretFile = join(st.dir, `${itemHash(`${API}|a@example.com`)}.json`);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(JSON.parse(readFileSync(secretFile, "utf8")).value).refreshToken, "kdr_1");
    assert.deepEqual(st.notices, [], "KERNAL_AUTH_BACKEND=file asked for the file: no notice");
  });

  test("openBrowser false: nothing is opened, the URL and code are printed", async () => {
    const opened: string[] = [];
    const st = storage();
    const f = fakeFetch({ "/api/device/code": [{ status: 200, body: CODE }], "/api/device/token": [{ status: 200, body: tokens(1) }] });
    const lines: string[] = [];
    await login({ ...st, api: API, print: (l) => lines.push(l), fetch: f.fn, openBrowser: false, openUrl: (u) => opened.push(u), sleep: async () => {} });
    assert.deepEqual(opened, []);
    assert.ok(lines[0].includes("BCDF-GHJK"));
    assert.equal(getRouterKey({ ...st, api: API }), undefined, "no delivery: no router key");
  });

  for (const [error, message] of [
    ["access_denied", /denied/],
    ["expired_token", /expired/],
    ["invalid_grant", /no longer valid/],
  ] as const) {
    test(`token answer ${error}: a one-line reason, nothing stored`, async () => {
      const st = storage();
      const f = fakeFetch({ "/api/device/code": [{ status: 200, body: CODE }], "/api/device/token": [{ status: 400, body: { error } }] });
      await assert.rejects(login({ ...st, api: API, print: () => {}, fetch: f.fn, openBrowser: false, sleep: async () => {} }), message);
      assert.equal(loginState({ ...st, api: API }).signedIn, false);
      assert.equal(existsSync(join(st.dir, "accounts.json")), false);
    });
  }

  test("the code's own expiry ends the wait", async () => {
    let t = 0;
    const f = fakeFetch({ "/api/device/code": [{ status: 200, body: { ...CODE, expires_in: 12 } }], "/api/device/token": [{ status: 400, body: { error: "authorization_pending" } }] });
    await assert.rejects(
      login({ ...storage(), api: API, print: () => {}, fetch: f.fn, openBrowser: false, now: () => t, sleep: async (ms) => void (t += ms) }),
      /expired before it was approved/,
    );
    assert.equal(f.paths().filter((p) => p === "/api/device/token").length, 2);
  });

  test("a dropped poll is retried; a refused code request explains itself", async () => {
    const f = fakeFetch({
      "/api/device/code": [{ status: 200, body: CODE }],
      "/api/device/token": [new Error("socket hang up"), { status: 200, body: tokens(1) }],
    });
    await login({ ...storage(), api: API, print: () => {}, fetch: f.fn, openBrowser: false, sleep: async () => {} });

    const limited = fakeFetch({ "/api/device/code": [{ status: 429, body: { error: "rate_limited", retryAfter: 42 } }] });
    await assert.rejects(login({ ...storage(), api: API, print: () => {}, fetch: limited.fn }), /try again in 42 s/);
    const off = fakeFetch({ "/api/device/code": [{ status: 503, body: { error: "login_unavailable" } }] });
    await assert.rejects(login({ ...storage(), api: API, print: () => {}, fetch: off.fn }), /sign-in is not enabled on https:\/\/link.outfitter.test/);
    const down = fakeFetch({ "/api/device/code": [new Error("ECONNREFUSED")] });
    await assert.rejects(login({ ...storage(), api: API, print: () => {}, fetch: down.fn }), /could not reach https:\/\/link.outfitter.test: ECONNREFUSED/);
    const page = fakeFetch({ "/api/device/code": [{ status: 200, body: { hello: "a web page" } }] });
    await assert.rejects(login({ ...storage(), api: API, print: () => {}, fetch: page.fn }), /invalid answer/);
  });

  test("Ctrl-C (the signal) stops the wait", async () => {
    const abort = new AbortController();
    const f = fakeFetch({ "/api/device/code": [{ status: 200, body: { ...CODE, interval: 60 } }], "/api/device/token": [{ status: 400, body: { error: "authorization_pending" } }] });
    const p = login({ ...storage(), api: API, print: () => {}, fetch: f.fn, openBrowser: false, signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(p, /cancelled/);
  });

  test("signing in again as the same person revokes the old device", async () => {
    const { st } = await signedIn();
    const f = fakeFetch({
      "/api/device/code": [{ status: 200, body: CODE }],
      "/api/device/token": [{ status: 200, body: tokens(2) }],
      "/api/device/revoke": [{ status: 200, body: {} }],
    });
    await login({ ...st, api: API, print: () => {}, fetch: f.fn, openBrowser: false, sleep: async () => {} });
    assert.deepEqual(f.calls.find((c) => c.url.endsWith("/revoke"))?.body, { token: "kdr_1" });
    assert.equal(currentAccessToken({ ...st, api: API }), "kda_2");
    assert.equal(JSON.parse(readFileSync(join(st.dir, "accounts.json"), "utf8")).accounts.length, 1);
  });

  test("several accounts: the default, or the one named by email", async () => {
    const { st } = await signedIn();
    await signedIn({ st, answer: { account: { email: "b@example.com", userId: "u_b" }, device: { id: "dev_bbbbbbbbbbbbbbbb", name: "mbp-test" } } });
    assert.equal((loginState({ ...st, api: API }) as any).account.email, "b@example.com", "the newest login is the default");
    assert.equal((loginState({ ...st, api: API, email: "A@example.com" }) as any).account.email, "a@example.com");
    assert.equal(loginState({ ...st, api: API, email: "c@example.com" }).signedIn, false);
    assert.equal(loginState({ ...st, api: "https://other.test" }).signedIn, false, "another api has no login");
    await logout({ ...st, api: API, fetch: fakeFetch({ "/api/device/revoke": [{ status: 200, body: {} }] }).fn });
    assert.equal((loginState({ ...st, api: API }) as any).account.email, "a@example.com", "the remaining account becomes the default");
  });
});

describe("getAccessToken and refresh", () => {
  test("a fresh token is used as it is, with no request", async () => {
    const { st } = await signedIn();
    const f = fakeFetch({});
    assert.equal(await getAccessToken({ ...st, api: API, fetch: f.fn }), "kda_1");
    assert.equal(f.calls.length, 0);
  });

  test("under 2 minutes left: refreshed, the new pair stored, the router key kept", async () => {
    let t = Date.parse("2026-10-04T10:00:00Z");
    const { st } = await signedIn({ now: () => t });
    t += HOUR * 1000 - 60_000;
    const f = fakeFetch({ "/api/device/refresh": [{ status: 200, body: tokens(2) }] });
    assert.equal(await getAccessToken({ ...st, api: API, fetch: f.fn, now: () => t }), "kda_2");
    assert.deepEqual(f.calls[0].body, { grant_type: "refresh_token", refresh_token: "kdr_1" });
    assert.equal(currentAccessToken({ ...st, api: API }), "kda_2");
    assert.deepEqual(getRouterKey({ ...st, api: API }), ROUTER_KEY);
    const index = JSON.parse(readFileSync(join(st.dir, "accounts.json"), "utf8"));
    assert.equal(index.accounts[0].accessExpiresAt, new Date(t + HOUR * 1000).toISOString());
    assert.equal(existsSync(join(st.dir, `${itemHash(`${API}|a@example.com`)}.lock`)), false, "the lock is released");
  });

  test("single-flight: concurrent callers share one refresh", async () => {
    let t = Date.parse("2026-10-04T10:00:00Z");
    const { st } = await signedIn({ now: () => t });
    t += HOUR * 1000;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeFetch({ "/api/device/refresh": [{ status: 200, body: tokens(2) }] });
    const slow = (async (url: string, init?: RequestInit) => {
      await gate;
      return inner.fn(url, init);
    }) as unknown as typeof fetch;
    const a = getAccessToken({ ...st, api: API, fetch: slow, now: () => t });
    const b = getAccessToken({ ...st, api: API, fetch: slow, now: () => t });
    setTimeout(release, 150);
    assert.deepEqual(await Promise.all([a, b]), ["kda_2", "kda_2"]);
    assert.equal(inner.calls.length, 1, "the second waited for the lock and read the first one's pair");
  });

  test("a stale lock (a process that died holding it) is broken", async () => {
    let t = Date.now();
    const { st } = await signedIn({ now: () => t });
    t += HOUR * 1000;
    const lock = join(st.dir, `${itemHash(`${API}|a@example.com`)}.lock`);
    writeFileSync(lock, "99999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const f = fakeFetch({ "/api/device/refresh": [{ status: 200, body: tokens(2) }] });
    assert.equal(await getAccessToken({ ...st, api: API, fetch: f.fn, now: () => t }), "kda_2");
  });

  for (const error of ["invalid_grant", "access_denied"]) {
    test(`refresh refused (${error}): undefined, and the login is removed locally`, async () => {
      let t = Date.now();
      const { st } = await signedIn({ now: () => t });
      t += HOUR * 1000;
      const f = fakeFetch({ "/api/device/refresh": [{ status: 400, body: { error } }] });
      assert.equal(await getAccessToken({ ...st, api: API, fetch: f.fn, now: () => t }), undefined);
      assert.equal(loginState({ ...st, api: API }).signedIn, false);
      assert.equal(existsSync(join(st.dir, "accounts.json")), false);
      assert.deepEqual(readdirSync(st.dir), [], "secrets and lock gone too");
    });
  }

  test("offline or a 5xx: the old token while it lasts, then undefined; the login stays", async () => {
    let t = Date.now();
    const { st } = await signedIn({ now: () => t });
    t += HOUR * 1000 - 60_000;
    const down = fakeFetch({ "/api/device/refresh": [new Error("ENOTFOUND")] });
    assert.equal(await getAccessToken({ ...st, api: API, fetch: down.fn, now: () => t }), "kda_1");
    const broken = fakeFetch({ "/api/device/refresh": [{ status: 503, body: {} }] });
    t += 120_000;
    assert.equal(await getAccessToken({ ...st, api: API, fetch: broken.fn, now: () => t }), undefined);
    assert.equal(loginState({ ...st, api: API }).signedIn, true);
  });

  test("after a 401 (rejected): the keychain is re-read once; the same token is not handed back", async () => {
    const { st } = await signedIn();
    assert.equal(await getAccessToken({ ...st, api: API, rejected: "kda_1" }), undefined);
    assert.equal(await getAccessToken({ ...st, api: API, rejected: "kda_0" }), "kda_1", "another process already holds a newer one");
  });

  test("signed out: undefined, never a throw", async () => {
    assert.equal(await getAccessToken({ ...storage(), api: API }), undefined);
    const broken: SessionStorage = { ...storage(), backend: { name: "keychain", get: () => { throw new Error("locked"); }, set() {}, delete() {} } };
    assert.equal(await getAccessToken({ ...broken, api: API }), undefined);
  });
});

describe("router key and logout", () => {
  test("setRouterKey replaces the stored key; signed out it throws", async () => {
    const { st } = await signedIn();
    const next = { ...ROUTER_KEY, key: "sk-new" };
    setRouterKey(next, { ...st, api: API });
    assert.deepEqual(getRouterKey({ ...st, api: API }), next);
    assert.equal(currentAccessToken({ ...st, api: API }), "kda_1");
    assert.throws(() => setRouterKey(next, { ...storage(), api: API }), /not signed in to https:\/\/link.outfitter.test/);
  });

  test("logout revokes with the refresh token and forgets everything", async () => {
    const { st } = await signedIn();
    const f = fakeFetch({ "/api/device/revoke": [{ status: 200, body: {} }] });
    await logout({ ...st, api: API, fetch: f.fn });
    assert.deepEqual(f.calls.map((c) => [new URL(c.url).pathname, c.body]), [["/api/device/revoke", { token: "kdr_1" }]]);
    assert.equal(loginState({ ...st, api: API }).signedIn, false);
    assert.deepEqual(readdirSync(st.dir), []);
  });

  test("logout offline still forgets locally; signed out it does nothing", async () => {
    const { st } = await signedIn();
    await logout({ ...st, api: API, fetch: fakeFetch({ "/api/device/revoke": [new Error("offline")] }).fn });
    assert.equal(loginState({ ...st, api: API }).signedIn, false);
    const none = fakeFetch({});
    await logout({ ...storage(), api: API, fetch: none.fn });
    assert.equal(none.calls.length, 0);
  });
});

describe("keychain backends", () => {
  function recorder(answers: Partial<Record<string, { status: number; stdout?: string }>> = {}) {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const store = new Map<string, string>();
    const run: Runner = (cmd, args, input) => {
      calls.push({ cmd, args, input });
      const sub = args[0];
      if (answers[sub]) return { status: answers[sub]!.status, stdout: answers[sub]!.stdout ?? "" };
      if (cmd.endsWith("security") && sub === "-i") {
        const m = /-a "([^"]+)".* -X ([0-9a-f]+)\n$/.exec(input ?? "");
        if (m) store.set(m[1], Buffer.from(m[2], "hex").toString("utf8"));
        return { status: 0, stdout: "" };
      }
      if (sub === "find-generic-password") {
        const v = store.get(args[args.indexOf("-a") + 1]);
        return v === undefined ? { status: 44, stdout: "" } : { status: 0, stdout: `${v}\n` };
      }
      return { status: 0, stdout: "" };
    };
    return { run, calls };
  }

  test("macOS Keychain: the secret goes hex-encoded on stdin, never on argv", () => {
    const r = recorder();
    const kc = keychainBackend(r.run);
    const value = JSON.stringify({ accessToken: "kda_secret value", refreshToken: "kdr_secret" });
    kc.set(`${API}|a@example.com`, value);
    assert.equal(kc.get(`${API}|a@example.com`), value);
    for (const c of r.calls) assert.ok(!c.args.join(" ").includes("secret"), `argv carries no secret: ${c.args.join(" ")}`);
    assert.deepEqual(r.calls[0].args, ["-i"]);
    assert.match(r.calls[0].input!, /^add-generic-password -U -s kernal-outfitter -a "https:\/\/link.outfitter.test\|a@example.com" -l "Kernal \(Outfitter\)" -X [0-9a-f]+\n$/);
    assert.ok(!r.calls[0].input!.includes("kda_secret"));
    kc.delete(`${API}|a@example.com`);
    assert.deepEqual(r.calls.at(-1)!.args, ["delete-generic-password", "-s", "kernal-outfitter", "-a", `${API}|a@example.com`]);
    assert.throws(() => kc.set('bad"name', "x"), /unusable keychain item name/);
  });

  test("macOS Keychain: a write that did not land throws (security -i answers 0 regardless)", () => {
    const r = recorder({ "find-generic-password": { status: 44 } });
    assert.throws(() => keychainBackend(r.run).set("i", "v"), /macOS Keychain/);
  });

  test("Secret Service: store with the secret on stdin; lookup; clear", () => {
    const calls: { args: string[]; input?: string }[] = [];
    const ss = secretServiceBackend((_cmd, args, input) => {
      calls.push({ args, input });
      return { status: 0, stdout: args[0] === "lookup" ? "the-value\n" : "" };
    });
    ss.set("item", "the-value");
    assert.deepEqual(calls[0], { args: ["store", "--label=Kernal (Outfitter)", "service", "kernal-outfitter", "account", "item"], input: "the-value" });
    assert.equal(ss.get("item"), "the-value");
    ss.delete("item");
    assert.deepEqual(calls[2].args, ["clear", "service", "kernal-outfitter", "account", "item"]);
    assert.equal(secretServiceBackend(() => ({ status: 1, stdout: "" })).get("item"), undefined);
  });

  test("file backend: whole-file writes, 0600, keyed by item", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kernal-kc-")), "auth");
    const fb = fileBackend(dir);
    fb.set("one", "v1");
    assert.equal(fb.get("one"), "v1");
    assert.equal(fb.get("two"), undefined);
    assert.equal(statSync(join(dir, `${itemHash("one")}.json`)).mode & 0o777, 0o600);
    fb.delete("one");
    assert.equal(fb.get("one"), undefined);
  });

  test("chooseBackend: KERNAL_AUTH_BACKEND wins; Linux without a session bus gets the file", () => {
    assert.equal(chooseBackend("/tmp/x", { KERNAL_AUTH_BACKEND: "file" }).name, "file");
    assert.equal(chooseBackend("/tmp/x", { KERNAL_AUTH_BACKEND: "keychain" }).name, "keychain");
    assert.equal(chooseBackend("/tmp/x", { KERNAL_AUTH_BACKEND: "secret-service" }).name, "secret-service");
    if (process.platform === "linux") assert.equal(chooseBackend("/tmp/x", { PATH: "" }).name, "file");
    if (process.platform === "darwin") assert.equal(chooseBackend("/tmp/x", {}).name, "keychain");
  });

  test("a keychain that refuses the write gives way to the file, said once", async () => {
    const st = storage({ env: { KERNAL_AUTH_BACKEND: "secret-service" }, runner: () => ({ status: 1, stdout: "" }) });
    await signedIn({ st });
    assert.equal(JSON.parse(readFileSync(join(st.dir, "accounts.json"), "utf8")).accounts[0].backend, "file");
    assert.equal(currentAccessToken({ ...st, api: API }), "kda_1", "read back from where it was written");
    assert.equal(st.notices.length, 1);
    assert.match(st.notices[0], /no keychain available/);
  });
});

describe("outfitter-env: session first, the Dongle as a deprecated fallback", () => {
  async function home() {
    const h = mkdtempSync(join(tmpdir(), "kernal-home-"));
    const dir = join(h, ".kernal", "auth");
    mkdirSync(dir, { recursive: true });
    await signedIn({ st: { ...storage(), authDir: dir, dir } as any });
    return h;
  }

  test("signed in to OUTFITTER_API: the session, even with a Dongle set", async () => {
    const HOME = await home();
    const env = { HOME, KERNAL_AUTH_BACKEND: "file", OUTFITTER_API: API, OUTFITTER_TOKEN: "outf_old" };
    const creds = outfitterCredentials(env);
    assert.deepEqual(creds, { api: API, token: "kda_1", source: "session" });
    assert.equal(await outfitterBearer(creds), "kda_1");
  });

  test("a login for another api is not used; the Dongle is", async () => {
    const HOME = await home();
    const creds = outfitterCredentials({ HOME, KERNAL_AUTH_BACKEND: "file", OUTFITTER_API: "https://other.test", OUTFITTER_TOKEN: "outf_x" });
    assert.deepEqual(creds, { api: "https://other.test", token: "outf_x", source: "dongle" });
    assert.equal(await outfitterBearer(creds), "outf_x");
  });

  test("an explicit env without HOME or KERNAL_AUTH_DIR never looks at this machine's login", () => {
    assert.deepEqual(outfitterCredentials({}), { api: undefined, token: undefined });
    assert.deepEqual(outfitterCredentials({ OUTFITTER_API: API }), { api: API, token: undefined });
  });

  test("credentials without a source (older callers, tests) bear their token", async () => {
    assert.equal(await outfitterBearer({ api: API, token: "outf_plain" }), "outf_plain");
    assert.equal(await outfitterBearer({ api: API }), undefined);
  });
});

