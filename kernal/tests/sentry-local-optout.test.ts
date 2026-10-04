/**
 * Sentry's local opt-outs live in one place (#428): this machine's config layer, config.local.json,
 * which `/sentry off|on`, `/sentry agent|content|metrics off|on` and /admin's "Only this machine" all
 * write through central-config's setLocalOptOut. So either tool undoes the other, `/sentry status`
 * and /admin read the same resolution, the legacy settings.json flags (`kernal.sentry: false` from
 * #374, `kernal.sentryAgentTraces: false` and so on) still count as opt-outs and are cleared by an
 * `on`, and no local `true` ever turns anything on. Real central-config and /admin modules against a
 * temporary ~/.kernal; a fake pi, a fake Sentry client, no network.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetCentralConfig, _setCentralConfigDeps, localOverridesPath, resolve, setLocalOptOut, setLocalOverride,
} from "../.pi/extensions/_shared/central-config.ts";
import { _setAdminCentralDeps, saveSettings, settingsRows } from "../.pi/extensions/kernal-admin/central.ts";
import { optedOut, signalOptOuts } from "../.pi/extensions/sentry/config.ts";
import { sending, liveSignals, _resetSentryState, type SentryLike, type SentrySpan } from "../.pi/extensions/sentry/client.ts";
import type { FleetSettings } from "../.pi/extensions/_shared/fleet-settings.ts";
import sentryExtension from "../.pi/extensions/sentry/index.ts";
import { makePi } from "./harness.ts";

const DSN = "https://publicKey@o0.ingest.us.sentry.io/1";
const API = "https://link.outfitter.test";
const CREDS = { api: API, token: "outf_dongle" };
const ALL: FleetSettings = { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 1, agentTraces: true, agentContent: true, metrics: true } } };

let home: string;
/** The agent settings.json, as central-config and the extension read it. */
let settings: Record<string, any>;
let settingsWrites: number;

function setup() {
  _resetCentralConfig();
  _setCentralConfigDeps({
    session: { loginState: () => ({ signedIn: false as const }), getAccessToken: async () => undefined, getRouterKey: () => undefined, setRouterKey: () => {} } as any,
    env: () => ({}),
    dotenv: () => ({}),
    settings: () => structuredClone(settings),
    saveKernal: (patch) => {
      settingsWrites++;
      const k = { ...(settings.kernal ?? {}) };
      for (const [key, v] of Object.entries(patch)) { if (v === undefined) delete k[key]; else k[key] = v; }
      settings = { ...settings, kernal: k };
    },
    fetch: (async () => { throw new Error("no network in this test"); }) as typeof fetch,
    now: () => Date.now(),
    warn: () => {},
  });
  _setAdminCentralDeps({});
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kernal-sentry-optout-"));
  process.env.KERNAL_HOME_DIR = home;
  settings = {};
  settingsWrites = 0;
  _resetSentryState();
  setup();
});
afterEach(() => { _setAdminCentralDeps({}); _resetCentralConfig(); delete process.env.KERNAL_HOME_DIR; });

const machineFile = (): Record<string, unknown> =>
  existsSync(localOverridesPath()) ? JSON.parse(readFileSync(localOverridesPath(), "utf8")).values : {};

function fakeSentry(): SentryLike {
  const span: SentrySpan = { setStatus() {}, setAttributes() {}, end() {}, raw: {} };
  return { init() {}, captureException() { return "id"; }, captureCrash() {}, count() {}, async flush() { return true; }, startInactiveSpan() { return span; } };
}

/** The real extension, signed out, with the fleet's settings cached; its opt-outs saved by the
 * default (setLocalOptOut) and read through the real central resolution. */
async function startSentry(fleet: FleetSettings = ALL) {
  const pi = makePi();
  const dir = mkdtempSync(join(tmpdir(), "kernal-fleet-"));
  const cacheFile = join(dir, "fleet-settings.json");
  writeFileSync(cacheFile, JSON.stringify({ api: API, fetchedAt: new Date().toISOString(), settings: fleet }));
  const fetch = (async () => new Response(JSON.stringify(fleet), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
  let refreshed: Promise<void> = Promise.resolve();
  sentryExtension(pi as any, {
    signedIn: false, sentry: fakeSentry(), credentials: CREDS, settings: structuredClone(settings), cacheFile, fetch,
    central: { resolve: () => resolve(), refresh: async () => undefined },
    crashFile: join(dir, "crashes.json"), crashesSentFile: join(dir, "sent.json"),
    onRefresh: (p) => { refreshed = p; },
  });
  await refreshed;
  await new Promise((r) => setImmediate(r));
  const notes: string[] = [];
  const command = async (args: string) => { await pi.commands.get("sentry")!.handler(args, { ui: { notify: (m: string) => notes.push(m) } }); return notes.at(-1)!; };
  return { command };
}

const row = (key: string) => settingsRows(resolve(), undefined, undefined, machineFile()).find((r) => r.key === key)!;

describe("/sentry writes the same place /admin does", () => {
  test("/sentry off and /sentry agent off save `false` to config.local.json, never settings.json", async () => {
    const { command } = await startSentry();
    assert.equal(sending(), true);
    assert.match(await command("off"), /off on this laptop/);
    assert.equal(sending(), false);
    assert.deepEqual(machineFile(), { "telemetry.sentry.enabled": false });
    await command("on");
    await command("agent off");
    await command("metrics off");
    assert.deepEqual(machineFile(), { "telemetry.sentry.agentTraces": false, "telemetry.sentry.metrics": false });
    assert.equal(settingsWrites, 0, "settings.json untouched: nothing legacy to clear");
    assert.equal(settings.kernal, undefined);
  });

  test("/admin clears an opt-out /sentry set", async () => {
    const { command } = await startSentry();
    await command("off");
    await command("content off");
    // /admin shows them as this machine's, editable, from the same resolution.
    assert.equal(row("telemetry.sentry.enabled").machine, false);
    assert.equal(row("telemetry.sentry.enabled").value, false);
    assert.equal(row("telemetry.sentry.enabled").canMachine, true);
    assert.equal(row("telemetry.sentry.agentContent").machine, false);
    const r = await saveSettings({ target: "machine", values: { "telemetry.sentry.enabled": null, "telemetry.sentry.agentContent": null } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(machineFile(), {});
    // The next start follows the fleet again.
    _resetSentryState();
    await startSentry();
    assert.equal(sending(), true);
    assert.deepEqual(liveSignals(), { agentTraces: true, agentContent: true, metrics: true });
  });

  test("/sentry on clears an opt-out /admin set, and status agrees with /admin", async () => {
    const r = await saveSettings({ target: "machine", values: { "telemetry.sentry.enabled": false, "telemetry.sentry.agentTraces": false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { command } = await startSentry();
    assert.equal(sending(), false, "an /admin opt-out stops Sentry on this laptop too");
    assert.match(await command("status"), /off on this laptop/);
    assert.match(await command("on"), /on, set by Outfitter/);
    assert.equal(sending(), true);
    assert.equal(row("telemetry.sentry.enabled").machine, undefined);
    assert.match(await command("status"), /Agent monitoring[^\n]*off on this laptop/);
    assert.match(await command("agent on"), /Agent monitoring[^\n]*on, set by Outfitter/);
    assert.deepEqual(machineFile(), {});
    assert.equal(liveSignals().agentTraces, true);
  });
});

describe("legacy settings.json flags", () => {
  test("`kernal.sentry: false` (#374) and the #424 flags still opt out, for /sentry and /admin alike", async () => {
    settings = { kernal: { sentry: false, sentryMetrics: false } };
    const { command } = await startSentry();
    assert.equal(sending(), false);
    assert.match(await command("status"), /off on this laptop/);
    const enabled = row("telemetry.sentry.enabled");
    assert.equal(enabled.value, false);
    assert.equal(enabled.sourceLabel, "this machine (settings.json)");
    assert.equal(enabled.machine, false, "shown as this machine's, so /admin can clear it");
    assert.equal(row("telemetry.sentry.metrics").machine, false);
    assert.equal(optedOut(settings, resolve().values), true);
    assert.equal(signalOptOuts(settings, resolve().values).metrics, true);
  });

  test("/sentry on and /sentry metrics on clear the legacy flag too", async () => {
    settings = { kernal: { sentry: false, sentryMetrics: false, memory: "tool" } };
    const { command } = await startSentry();
    assert.match(await command("on"), /on, set by Outfitter/);
    assert.equal(sending(), true);
    assert.deepEqual(settings.kernal, { sentryMetrics: false, memory: "tool" });
    await command("metrics on");
    assert.deepEqual(settings.kernal, { memory: "tool" }, "the rest of the kernal section is untouched");
    assert.equal(liveSignals().metrics, true);
    assert.equal(resolve().values["telemetry.sentry.enabled"].source, "default", "signed out, with no opt-out left: the default");
  });

  test("/admin's \"not set here\" clears a legacy flag", async () => {
    settings = { kernal: { sentryAgentTraces: false } };
    const r = await saveSettings({ target: "machine", values: { "telemetry.sentry.agentTraces": null } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(settings.kernal, {});
    assert.equal(resolve().values["telemetry.sentry.agentTraces"].source, "default");
  });

  test("an off writes config.local.json and leaves the legacy flag alone; settings.json is only written to clear one", () => {
    settings = { kernal: { sentry: false } };
    setLocalOptOut("telemetry.sentry.enabled", true);
    assert.equal(settingsWrites, 0);
    assert.deepEqual(machineFile(), { "telemetry.sentry.enabled": false });
    setLocalOptOut("telemetry.sentry.agentContent", false);
    assert.equal(settingsWrites, 0, "no legacy flag for that key: settings.json untouched");
    assert.throws(() => setLocalOptOut("model.default", true), /no local opt-out/);
  });
});

describe("only ever an opt-out", () => {
  test("a local `true` (config.local.json or settings.json) turns nothing on", async () => {
    settings = { kernal: { sentry: true, sentryAgentTraces: true } };
    setLocalOverride("telemetry.sentry.enabled", true);
    setLocalOverride("telemetry.sentry.agentTraces", true);
    for (const key of ["telemetry.sentry.enabled", "telemetry.sentry.agentTraces"]) {
      const v = resolve().values[key];
      assert.equal(v.value, false, `${key}: the default, not the local true`);
      assert.equal(v.source, "default");
    }
    // Nor can /admin save one while nothing central turned it on.
    const r = await saveSettings({ target: "machine", values: { "telemetry.sentry.metrics": true } });
    assert.equal(r.status, 422);
    // And with the fleet off, /sentry on cannot turn it on either.
    const { command } = await startSentry({ telemetry: { sentry: { enabled: false } } });
    await command("on");
    assert.equal(sending(), false);
  });

  test("with the fleet on, a local `true` changes nothing and a local `false` beats it", async () => {
    setLocalOverride("telemetry.sentry.metrics", true);
    const { command } = await startSentry();
    assert.equal(liveSignals().metrics, true);
    await command("metrics off");
    assert.equal(liveSignals().metrics, false);
    assert.deepEqual(machineFile(), { "telemetry.sentry.metrics": false });
  });
});
