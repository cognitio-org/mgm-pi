/**
 * /config (kernal-config, #397 CA-8) driven through its entry point with a fake pi (harness.ts):
 * the listing (sources, locks, masked secrets), /config reload and /config profile, the start-up
 * refresh, and the sentry extension reading its three keys from the central settings when signed
 * in. The session and the network are fakes.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCentralConfig, _setCentralConfigDeps, configCachePath, resolve } from "../.pi/extensions/_shared/central-config.ts";
import configExtension, { headerLine, renderConfig, renderProfile } from "../.pi/extensions/kernal-config/index.ts";
import sentryExtension from "../.pi/extensions/sentry/index.ts";
import { _resetSentryState, type SentryLike, type SentryInit } from "../.pi/extensions/sentry/client.ts";
import { makePi } from "./harness.ts";

const API = "https://link.outfitter.test";
const EMAIL = "a@example.com";
const ACCOUNT = { api: API, email: EMAIL, userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };
const DSN = "https://publicKey@o0.ingest.us.sentry.io/1";

let signedIn: boolean;
let fetchCalls: string[];
let answer: unknown;

function fetchFake(): typeof fetch {
  return (async (url: URL | string) => {
    fetchCalls.push(String(url));
    const path = new URL(String(url)).pathname;
    if (path === "/api/config") return new Response(JSON.stringify(answer), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function setup() {
  _resetCentralConfig();
  _setCentralConfigDeps({
    session: {
      loginState: () => (signedIn ? { signedIn: true, account: ACCOUNT } : { signedIn: false }),
      getAccessToken: async () => (signedIn ? "kda_test" : undefined),
      getRouterKey: () => (signedIn ? { key: "sk-device-abcd1234", baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x" } : undefined),
      setRouterKey: () => {},
    },
    env: () => ({ OUTFITTER_API: API }),
    dotenv: () => ({}),
    settings: () => ({}),
    fetch: fetchFake(),
    warn: () => {},
  });
}

function config(values: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, account: { email: EMAIL, userId: "u_1" }, profile: null, profiles: [], values, resolvedAt: "2026-10-04T10:00:00.000Z", ...extra };
}

async function run(pi: ReturnType<typeof makePi>, args: string) {
  const notes: { msg: string; level: string }[] = [];
  await pi.commands.get("config")!.handler(args, { ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) } });
  return notes;
}

beforeEach(() => {
  process.env.KERNAL_HOME_DIR = mkdtempSync(join(tmpdir(), "kernal-config-cmd-"));
  process.env.KERNAL_VOICE_SETTINGS = join(process.env.KERNAL_HOME_DIR, "pi-listen.json");   // never the real pi-listen settings
  signedIn = true;
  fetchCalls = [];
  answer = config({});
  setup();
});

describe("/config", () => {
  test("signed out: local settings only, and says how to sign in", async () => {
    signedIn = false;
    setup();
    const pi = makePi();
    configExtension(pi as any);
    const [note] = await run(pi, "");
    assert.match(note.msg, /^Signed out: this machine's settings only\. Run kernal login/);
    assert.match(note.msg, /router\.baseUrl = https:\/\/router\.kernal\.one\/v1 {2}\(default\)/);
    assert.match(note.msg, /model\.default = \(unset\)/);
    assert.equal(fetchCalls.length, 0);
  });

  test("signed in: sources, locks and a masked router key; the start-up refresh ran in the background", async () => {
    answer = config({
      "router.baseUrl": { value: "https://fleet.test/v1", source: "fleet", locked: true },
      "model.default": { value: "claude-auto-llm", source: "profile", sourceName: "work" },
    }, { profile: "work", profiles: ["personal", "work"] });
    const pi = makePi();
    let done: Promise<void> | undefined;
    configExtension(pi as any, { onRefresh: (p) => { done = p; } });
    resolve();   // start-up (connect's loadEnv) resolves before the refresh lands
    await done;
    assert.ok(fetchCalls.some((u) => u === `${API}/api/config`));
    // The refresh rewrote the cache; this process keeps what it resolved at start until a reload.
    const before = await run(pi, "");
    assert.match(before[0].msg, /not fetched yet/);
    const [note] = await run(pi, "reload");
    assert.match(note.msg, /a@example\.com on https:\/\/link\.outfitter\.test, profile work; settings fetched /);
    assert.match(note.msg, /router\.baseUrl = https:\/\/fleet\.test\/v1 {2}\(fleet, locked: set by your Sysop\)/);
    assert.match(note.msg, /model\.default = claude-auto-llm {2}\(profile work\)/);
    assert.match(note.msg, /router\.key = …1234 {2}\(this device\)/);
    assert.doesNotMatch(note.msg, /sk-device/);
    assert.match(note.msg, /Change them at https:\/\/link\.outfitter\.test\/account/);
  });

  test("reload offline: the cached settings, said so", async () => {
    const file = configCachePath(API, EMAIL, undefined);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ api: API, email: EMAIL, profile: null, fetchedAt: new Date().toISOString(), response: config({ "model.default": { value: "cached", source: "user" } }) }));
    _setCentralConfigDeps({ fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    const pi = makePi();
    configExtension(pi as any);
    const [note] = await run(pi, "reload");
    assert.match(note.msg, /^Could not reach Outfitter; showing the cached settings\./);
    assert.match(note.msg, /model\.default = cached {2}\(your account\)/);
  });

  test("profile: the active one and the account's list", async () => {
    answer = config({}, { profile: "personal", profiles: ["personal", "work"] });
    const pi = makePi();
    configExtension(pi as any);
    await run(pi, "reload");
    const [note] = await run(pi, "profile");
    assert.match(note.msg, /^Profile: personal \(the account's default\)\nProfiles of a@example\.com: personal, work/);
  });

  test("unknown subcommand: usage", async () => {
    const pi = makePi();
    configExtension(pi as any);
    assert.deepEqual(await run(pi, "frob"), [{ msg: "usage: /config [reload | profile]", level: "warning" }]);
    assert.deepEqual(pi.commands.get("config")!.getArgumentCompletions!("re"), [{ value: "reload", label: "reload" }]);
  });

  test("pure renderers", () => {
    const out = { api: null, account: null, profile: null, schemaVersion: 1, values: {}, fetchedAt: null, fromCache: false };
    assert.match(headerLine(out), /^Signed out/);
    assert.match(renderProfile(out, "work"), /KERNAL_PROFILE=work is ignored/);
    assert.doesNotMatch(renderConfig(out), /Change them at/);
    const none = { ...out, api: API, account: EMAIL, profiles: [] };
    assert.equal(renderProfile(none, undefined), "Profile: none (account-wide settings only)\na@example.com has no profiles yet.\nStart Kernal with --profile <name> to use another one.");
  });
});

describe("sentry, signed in", () => {
  function fakeSentry() {
    const inits: SentryInit[] = [];
    const sentry: SentryLike = {
      init(options) { inits.push(options); },
      captureException() { return "id"; },
      captureCrash() {},
      async flush() { return true; },
      startInactiveSpan() { return { setStatus() {}, end() {}, raw: {} }; },
    };
    return { sentry, inits };
  }

  test("reads its three keys from the central settings, not GET /api/fleet-settings", async () => {
    _resetSentryState();
    const on = config({
      "telemetry.sentry.enabled": { value: true, source: "fleet" },
      "telemetry.sentry.dsn": { value: DSN, source: "fleet", locked: true },
      "telemetry.sentry.tracesSampleRate": { value: 0.2, source: "fleet", locked: true },
    });
    answer = on;
    const { sentry, inits } = fakeSentry();
    const pi = makePi();
    let done: Promise<void> | undefined;
    const dir = mkdtempSync(join(tmpdir(), "kernal-sentry-central-"));
    sentryExtension(pi as any, {
      sentry,
      signedIn: true,
      credentials: {},
      settings: {},
      fetch: fetchFake(),
      cacheFile: join(dir, "fleet.json"),
      crashFile: join(dir, "crashes.json"),
      crashesSentFile: join(dir, "sent.json"),
      onRefresh: (p) => { done = p; },
    });
    await done;
    assert.ok(fetchCalls.every((u) => !u.includes("/api/fleet-settings")));
    assert.ok(fetchCalls.some((u) => u.endsWith("/api/config")));
    assert.equal(inits.length, 1);
    assert.equal(inits[0].dsn, DSN);
    assert.equal(inits[0].gate().tracesSampleRate, 0.2);
    _resetSentryState();
  });

  test("off in the central settings: nothing starts", async () => {
    _resetSentryState();
    const { sentry, inits } = fakeSentry();
    const pi = makePi();
    let done: Promise<void> | undefined;
    sentryExtension(pi as any, {
      sentry, signedIn: true, credentials: {}, settings: {},
      central: { resolve: () => resolve(), refresh: async () => resolve() },
      onRefresh: (p) => { done = p; },
    });
    await done;
    assert.equal(inits.length, 0);
    const notes: string[] = [];
    await pi.commands.get("sentry")!.handler("status", { ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0], /Outfitter has it off/);
    _resetSentryState();
  });
});
