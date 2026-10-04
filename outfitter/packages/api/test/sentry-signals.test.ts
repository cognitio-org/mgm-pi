// #424: Sentry's further signals (logs, metrics, AI agent traces and their content, profiles) as
// fleet settings: declared in the central schema, off by default, validated, sent to clients and
// run.spec only while on, and gated in the api's own SDK (sentry.ts) live and at the wire. Plus the
// Document-Policy header the web app's profiler needs (routes/static.ts) and the redaction the
// logs pass through.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { buildTestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, sendHello } from "./agent-socket.ts";
import { settingDecl, SETTINGS_SCHEMA_VERSION, parseValueWrite } from "../src/central/settings-schema.ts";
import { fleetLevelValues } from "../src/central/settings-resolver.ts";
import { clientFleetSettings, defaultFleetSettings, parseSentryUpdate, sentrySignals, withDefaults, type FleetSettings, type SentryFleetSettings } from "../src/fleet-settings.ts";
import {
  applySentrySettings,
  itemAllowed,
  metrics,
  profilerStartedForTests,
  profilingWanted,
  redact,
  resetSentryForTests,
  Sentry,
  sentryLogMethod,
  toSentryLog,
  type SentryRuntime,
} from "../src/sentry.ts";
import { registerStaticRoutes } from "../src/routes/static.ts";

const DSN = "http://publicKey@127.0.0.1:9/1";
const ON: SentryFleetSettings = { enabled: true, dsn: DSN, tracesSampleRate: 0.05 };
const ALL: SentryFleetSettings = { ...ON, logs: true, metrics: true, agentTraces: true, agentContent: true, profilesSampleRate: 0.5 };
const SIGNAL_KEYS = ["telemetry.sentry.logs", "telemetry.sentry.metrics", "telemetry.sentry.agentTraces", "telemetry.sentry.agentContent"];

afterEach(async () => {
  await resetSentryForTests();
});

function fleet(sentry: SentryFleetSettings): FleetSettings {
  return { telemetry: { sentry } };
}

describe("the schema", () => {
  test("five new keys, version 2, booleans off and opt-out like telemetry.sentry.enabled, the rate fleet-only at 0", () => {
    assert.equal(SETTINGS_SCHEMA_VERSION, 2);
    for (const key of SIGNAL_KEYS) {
      const d = settingDecl(key)!;
      assert.ok(d, key);
      assert.equal(d.type, "boolean", key);
      assert.equal(d.default, false, key);
      assert.equal(d.override, "opt-out", key);
      assert.deepEqual(d.levels, ["fleet", "local"], key);
      assert.equal(d.since, 2, key);
      assert.equal(d.secret, false, key);
    }
    const rate = settingDecl("telemetry.sentry.profilesSampleRate")!;
    assert.deepEqual([rate.type, rate.min, rate.max, rate.default, rate.override, rate.since], ["number", 0, 1, 0, "none", 2]);
    assert.deepEqual(rate.levels, ["fleet"]);
  });

  test("a fleet write takes only a rate in [0, 1] and only booleans for the switches", () => {
    for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5"]) {
      assert.deepEqual(parseValueWrite("fleet", { values: { "telemetry.sentry.profilesSampleRate": bad } }), { error: "invalid_value", key: "telemetry.sentry.profilesSampleRate" }, String(bad));
    }
    assert.deepEqual(parseValueWrite("fleet", { values: { "telemetry.sentry.logs": "yes" } }), { error: "invalid_value", key: "telemetry.sentry.logs" });
    assert.deepEqual(parseValueWrite("user", { values: { "telemetry.sentry.metrics": true } }), { error: "level_not_allowed", key: "telemetry.sentry.metrics" });
  });
});

describe("the fleet document", () => {
  test("off by default: no signal stored, every signal off, and off while Sentry is off whatever is stored", () => {
    assert.deepEqual(defaultFleetSettings().telemetry.sentry, { enabled: false, dsn: "https://1318f3af9a71b190730c227fb61c32dc@o4512181408432128.ingest.us.sentry.io/4512181422260224", tracesSampleRate: 0.05 });
    assert.deepEqual(sentrySignals(defaultFleetSettings().telemetry.sentry), { logs: false, metrics: false, agentTraces: false, agentContent: false, profilesSampleRate: 0 });
    assert.deepEqual(sentrySignals({ ...ALL, enabled: false }), { logs: false, metrics: false, agentTraces: false, agentContent: false, profilesSampleRate: 0 });
    assert.deepEqual(sentrySignals({ ...ALL, dsn: undefined }).logs, false, "on without a DSN reads as off");
  });

  test("agentContent needs agentTraces", () => {
    assert.equal(sentrySignals({ ...ON, agentContent: true }).agentContent, false);
    assert.equal(sentrySignals({ ...ON, agentTraces: true, agentContent: true }).agentContent, true);
  });

  test("withDefaults keeps signals that are on and drops malformed or off ones", () => {
    const doc = { telemetry: { sentry: { ...ON, logs: true, metrics: "yes", agentTraces: false, profilesSampleRate: 7 } } } as unknown as FleetSettings;
    assert.deepEqual(withDefaults(doc).telemetry.sentry, { ...ON, logs: true });
    assert.deepEqual(withDefaults(fleet(ALL)).telemetry.sentry, ALL);
  });

  test("parseSentryUpdate validates each signal; one left out, false or 0 is not stored", () => {
    assert.deepEqual(parseSentryUpdate({ telemetry: { sentry: { ...ALL } } }, { allowHttp: true }), { value: ALL });
    assert.deepEqual(parseSentryUpdate({ telemetry: { sentry: { ...ON, logs: false, profilesSampleRate: 0 } } }, { allowHttp: true }), { value: ON });
    assert.deepEqual(parseSentryUpdate({ telemetry: { sentry: { ...ON, logs: "true" } } }, { allowHttp: true }), { error: "telemetry.sentry.logs must be true or false" });
    for (const bad of [1.01, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.1"]) {
      assert.deepEqual(parseSentryUpdate({ telemetry: { sentry: { ...ON, profilesSampleRate: bad } } }, { allowHttp: true }), { error: "telemetry.sentry.profilesSampleRate must be a number from 0 to 1" }, String(bad));
    }
    // Kept while Sentry is off, like the DSN: turning it back on brings them back.
    assert.deepEqual(parseSentryUpdate({ telemetry: { sentry: { ...ALL, enabled: false } } }, { allowHttp: true }), { value: { ...ALL, enabled: false } });
  });

  test("the client answer: unchanged while off, only the signals that are on while on", () => {
    assert.deepEqual(clientFleetSettings(fleet({ ...ALL, enabled: false })).telemetry.sentry, { enabled: false });
    assert.deepEqual(clientFleetSettings(fleet(ON)).telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.05 });
    assert.deepEqual(clientFleetSettings(fleet({ ...ON, metrics: true, profilesSampleRate: 0.25 })).telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.05, metrics: true, profilesSampleRate: 0.25 });
  });

  test("the fleet level sets a signal key only while Sentry and that signal are on", () => {
    const off = fleetLevelValues(fleet({ ...ALL, enabled: false }));
    for (const key of [...SIGNAL_KEYS, "telemetry.sentry.profilesSampleRate"]) assert.equal(off[key], undefined, key);
    const on = fleetLevelValues(fleet({ ...ON, logs: true, profilesSampleRate: 0.1 }));
    assert.equal(on["telemetry.sentry.logs"], true);
    assert.equal(on["telemetry.sentry.metrics"], undefined);
    assert.equal(on["telemetry.sentry.profilesSampleRate"], 0.1);
  });
});

/** These tests turn profiles on through the app: start the SDK first (same DSN) with a stand-in
 * profiler, so the app's settings reuse it instead of loading the real native one, whose trace
 * lifecycle keeps a chunk timer alive and would hold the test process open. */
function withFakeProfiler(): void {
  const factory = () => ({ name: "FakeProfiling", setup: () => undefined });
  applySentrySettings({ ...ON, profilesSampleRate: 0.1 }, runtime(fakeTransport().transport, { loadProfiler: async () => factory as never }));
  applySentrySettings({ ...ON, enabled: false }, runtime(fakeTransport().transport));
}

describe("routes", () => {
  test("the operator fleet write stores signals in telemetry.sentry; GET /api/config and /api/fleet-settings carry them", async () => {
    withFakeProfiler();
    const app = await buildTestApp();
    const f = app.fastify;
    try {
      const put = await f.inject({
        method: "PUT",
        url: "/api/operator/config/fleet",
        headers: { "if-match": 'W/"0"' },
        payload: { values: { "telemetry.sentry.enabled": true, "telemetry.sentry.dsn": DSN, "telemetry.sentry.logs": true, "telemetry.sentry.agentTraces": true, "telemetry.sentry.profilesSampleRate": 0.2 } },
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.deepEqual((await app.store.fleetSettings.get())?.telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.05, logs: true, agentTraces: true, profilesSampleRate: 0.2 });
      assert.equal(put.json().values["telemetry.sentry.logs"], true);
      assert.equal(put.json().values["telemetry.sentry.metrics"], undefined);

      const cfg = (await f.inject({ method: "GET", url: "/api/config" })).json();
      assert.equal(cfg.values["telemetry.sentry.logs"].value, true);
      assert.equal(cfg.values["telemetry.sentry.metrics"].value, false);
      assert.equal(cfg.values["telemetry.sentry.metrics"].source, "default");
      assert.equal(cfg.values["telemetry.sentry.profilesSampleRate"].value, 0.2);

      const client = (await f.inject({ method: "GET", url: "/api/fleet-settings" })).json();
      assert.deepEqual(client.telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.05, logs: true, agentTraces: true, profilesSampleRate: 0.2 });

      // A signal turned off (false or null) is gone again; a bad rate names its key.
      const off = await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": 'W/"1"' }, payload: { values: { "telemetry.sentry.logs": false, "telemetry.sentry.agentTraces": null } } });
      assert.equal(off.statusCode, 200, off.body);
      assert.deepEqual((await app.store.fleetSettings.get())?.telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.05, profilesSampleRate: 0.2 });
      const bad = await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": 'W/"2"' }, payload: { values: { "telemetry.sentry.profilesSampleRate": 2 } } });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().key, "telemetry.sentry.profilesSampleRate");

      // Sentry off: the client answer is what it always was.
      await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": 'W/"2"' }, payload: { values: { "telemetry.sentry.enabled": false } } });
      assert.deepEqual((await f.inject({ method: "GET", url: "/api/fleet-settings" })).json().telemetry, { sentry: { enabled: false } });
    } finally {
      app.stopBackgroundTasks();
      await f.close();
    }
  });

  test("run.spec's telemetry carries the signals that are on, and only those", async () => {
    withFakeProfiler();
    const app = await buildTestApp();
    try {
      await app.fastify.inject({
        method: "PUT",
        url: "/api/operator/fleet-settings",
        payload: { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.25, logs: true, agentTraces: true, agentContent: true, profilesSampleRate: 0.1 } } },
      });
      const { session, runId, runToken } = await makeRunningSession(app);
      const agent = await openAgentSocket(app, runId);
      sendHello(agent, runId, session.id, runToken);
      const spec = await agent.nextMessage();
      assert.deepEqual(spec.telemetry, { sentry: { dsn: DSN, tracesSampleRate: 0.25, environment: "development", logs: true, agentTraces: true, agentContent: true, profilesSampleRate: 0.1 } });
      agent.close();
    } finally {
      app.stopBackgroundTasks();
      await app.fastify.close();
    }
  });
});

/** Every envelope item sent, by type, with its payload. */
function fakeTransport() {
  const items: Array<{ type: string; payload: unknown }> = [];
  const transport: SentryRuntime["transport"] = () => ({
    send: async (envelope) => {
      for (const [header, payload] of envelope[1] as Array<[{ type: string }, unknown]>) items.push({ type: header.type, payload });
      return {};
    },
    flush: async () => true,
  });
  return { transport, items };
}

const runtime = (transport: SentryRuntime["transport"], extra: Partial<SentryRuntime> = {}): SentryRuntime => ({ release: "", environment: "test", transport, ...extra });

/** The log records sent, flattened. */
function logs(items: Array<{ type: string; payload: unknown }>): Array<{ body: string; level: string; attributes: Record<string, { value: unknown }> }> {
  return items.filter((i) => i.type === "log").flatMap((i) => (i.payload as { items: never[] }).items);
}

/** A pino-shaped call through the hook, as Fastify's logger makes it. */
function logThrough(level: number, args: unknown[], bindings: Record<string, unknown> = {}): unknown[][] {
  const printed: unknown[][] = [];
  sentryLogMethod.call({ bindings: () => bindings }, args, (...a: unknown[]) => printed.push(a), level);
  return printed;
}

describe("logs", () => {
  test("off by default: lines are still printed, nothing is sent", async () => {
    const { transport, items } = fakeTransport();
    applySentrySettings(ON, runtime(transport));
    assert.deepEqual(logThrough(40, [{ provider: "x" }, "a warning"]), [[{ provider: "x" }, "a warning"]]);
    Sentry.logger.warn("direct, still gated");
    await Sentry.flush(1000);
    assert.deepEqual(logs(items), []);
  });

  test("on: info, warn and error lines go, redacted, with the query cut, and Fastify's request lines stay local", async () => {
    const { transport, items } = fakeTransport();
    applySentrySettings({ ...ON, logs: true }, runtime(transport));
    logThrough(30, [{ req: { method: "GET", url: "/api/x?token=abc" } }, "incoming request"]);
    logThrough(20, ["a debug line"]);
    logThrough(40, [{ deviceId: "dev_1", err: new Error("auth failed for Bearer abcdefghijklmnop"), body: { value: "sk-secretsecretsecret1" }, count: 2 }, "router key re-mint failed with kda_AAAAAAAAAAAAAAAAAAAAAAAA"], { reqId: "req-1" });
    await Sentry.flush(1000);
    const sent = logs(items);
    assert.equal(sent.length, 1);
    const [line] = sent;
    assert.equal(line!.level, "warn");
    assert.equal(line!.body, "router key re-mint failed with [redacted]");
    assert.equal(line!.attributes.deviceId?.value, "dev_1");
    assert.equal(line!.attributes.reqId?.value, "req-1");
    assert.equal(line!.attributes.count?.value, 2);
    assert.equal(line!.attributes["err.message"]?.value, "auth failed for Bearer [redacted]");
    assert.equal(line!.attributes.body, undefined, "a body is never sent");
  });

  test("turned off again: none sent, live, at the call and at the wire", async () => {
    const { transport, items } = fakeTransport();
    applySentrySettings({ ...ON, logs: true }, runtime(transport));
    applySentrySettings(ON, runtime(transport));
    logThrough(50, ["an error"]);
    Sentry.logger.error("direct");
    await Sentry.flush(1000);
    assert.deepEqual(logs(items), []);
    assert.equal(itemAllowed("log"), false);
    assert.equal(itemAllowed("event"), true);
  });

  test("through Fastify's logger: a route's req.log line goes, with its reqId; the request lines don't", async () => {
    const { transport, items } = fakeTransport();
    applySentrySettings({ ...ON, logs: true }, runtime(transport));
    const app = Fastify({ logger: { stream: { write: () => undefined }, hooks: { logMethod: sentryLogMethod } } });
    app.get("/x", async (req) => {
      req.log.warn({ provider: "anthropic" }, "provider key write failed");
      return {};
    });
    try {
      await app.inject({ method: "GET", url: "/x?token=abc" });
      await Sentry.flush(1000);
      const sent = logs(items);
      assert.deepEqual(sent.map((l) => l.body), ["provider key write failed"]);
      assert.equal(sent[0]!.attributes.provider?.value, "anthropic");
      assert.equal(typeof sent[0]!.attributes.reqId?.value, "string");
    } finally {
      await app.close();
    }
  });

  test("toSentryLog: req as method and path only, res as its status, objects as clipped JSON", () => {
    const log = toSentryLog([{ req: { method: "POST", url: "/api/device/token?x=1", headers: { authorization: "Bearer zzzzzzzzzzzz" } }, res: { statusCode: 502 }, match: { email: "a@b" }, token: "outf_abcdefghijk" }, "done"], 30)!;
    assert.deepEqual(log.attributes, { "http.request.method": "POST", "url.path": "/api/device/token", "http.response.status_code": 502, match: '{"email":"a@b"}' });
    assert.equal(toSentryLog(["x"], 10), undefined, "trace and debug stay local");
    const long = toSentryLog([{ note: "y".repeat(5000) }, "z".repeat(5000)], 30)!;
    assert.ok(long.message.length <= 4097 && (long.attributes.note as string).length <= 1025);
  });
});

describe("metrics", () => {
  function sentMetrics(items: Array<{ type: string; payload: unknown }>): Array<{ name: string; value: number; type: string }> {
    return items.filter((i) => i.type === "trace_metric").flatMap((i) => (i.payload as { items: never[] }).items);
  }

  test("nothing while off; counted and distributed while on", async () => {
    const { transport, items } = fakeTransport();
    applySentrySettings(ON, runtime(transport));
    metrics.count("device.login.started");
    await Sentry.flush(1000);
    assert.deepEqual(sentMetrics(items), []);

    applySentrySettings({ ...ON, metrics: true }, runtime(transport));
    metrics.count("device.login.started");
    metrics.distribution("router.key.mint.duration", 12.5, "millisecond", { kind: "device", outcome: "ok" });
    metrics.distribution("ignored", Number.NaN);
    await Sentry.flush(1000);
    const sent = sentMetrics(items);
    assert.deepEqual(sent.map((m) => [m.name, m.value]).sort(), [["device.login.started", 1], ["router.key.mint.duration", 12.5]]);
  });

  test("a device code request counts a login started", async () => {
    // The SDK starts once per process: started here with this transport, the app's own settings
    // (same DSN) then switch it off and on without starting another.
    const { transport, items } = fakeTransport();
    applySentrySettings({ ...ON, metrics: true }, runtime(transport));
    const app = await buildTestApp();
    try {
      await app.fastify.inject({ method: "PUT", url: "/api/operator/fleet-settings", payload: { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0, metrics: true } } } });
      const res = await app.fastify.inject({ method: "POST", url: "/api/device/code", payload: { deviceName: "laptop" } });
      assert.equal(res.statusCode, 200, res.body);
      await Sentry.flush(1000);
      assert.ok(sentMetrics(items).some((m) => m.name === "device.login.started"));
    } finally {
      app.stopBackgroundTasks();
      await app.fastify.close();
    }
  });
});

describe("profiles", () => {
  test("not loaded while the rate is 0", () => {
    applySentrySettings(ON, runtime(fakeTransport().transport, { loadProfiler: async () => assert.fail("loaded") }));
    assert.equal(profilerStartedForTests(), undefined);
  });

  test("on: the profiler is added with the fleet's rate and the trace lifecycle", async () => {
    let seen: Record<string, unknown> | undefined;
    const factory = () => ({ name: "FakeProfiling", setup: (client: { getOptions(): Record<string, unknown> }) => void (seen = { ...client.getOptions() }) });
    applySentrySettings({ ...ON, profilesSampleRate: 0.3 }, runtime(fakeTransport().transport, { loadProfiler: async () => factory as never }));
    assert.equal(await profilerStartedForTests(), true);
    assert.equal(seen?.profileSessionSampleRate, 0.3);
    assert.equal(seen?.profileLifecycle, "trace");
    assert.equal(itemAllowed("profile_chunk"), true);
    applySentrySettings(ON, runtime(fakeTransport().transport));
    assert.equal(itemAllowed("profile_chunk"), false, "a rate of 0 stops profiles at the wire at once");
  });

  test("an add-on that does not load is a warning, not a failed start", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (msg: string) => void warnings.push(msg);
    try {
      applySentrySettings({ ...ON, profilesSampleRate: 1 }, runtime(fakeTransport().transport, { loadProfiler: async () => Promise.reject(new Error("no prebuilt binary")) }));
      assert.equal(await profilerStartedForTests(), false);
    } finally {
      console.warn = warn;
    }
    assert.match(warnings.join("\n"), /profiling-node did not load.*no prebuilt binary/);
  });

  test("the real @sentry/profiling-node loads on this Node", async () => {
    const { nodeProfilingIntegration } = await import("@sentry/profiling-node");
    assert.equal(typeof nodeProfilingIntegration, "function");
  });

  test("profilingWanted follows Sentry and the rate", () => {
    assert.equal(profilingWanted(undefined), false);
    assert.equal(profilingWanted({ ...ON, profilesSampleRate: 0.1 }), true);
    assert.equal(profilingWanted({ ...ON, enabled: false, profilesSampleRate: 0.1 }), false);
    assert.equal(profilingWanted(ON), false);
  });
});

describe("Document-Policy on the web shell", () => {
  test("js-profiling exactly while profiling is wanted, on index.html and the SPA fallback, never on assets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(dir, "app.js"), "1");
    let wanted = false;
    const app = Fastify();
    try {
      await registerStaticRoutes(app, { webDist: dir, profiling: () => wanted });
      const off = await app.inject({ method: "GET", url: "/sessions/abc" });
      assert.equal(off.statusCode, 200);
      assert.equal(off.headers["document-policy"], undefined);
      wanted = true;
      for (const url of ["/", "/index.html", "/sessions/abc"]) {
        const res = await app.inject({ method: "GET", url });
        assert.equal(res.headers["document-policy"], "js-profiling", url);
        assert.equal(res.headers["cache-control"], "no-cache", url);
      }
      assert.equal((await app.inject({ method: "GET", url: "/app.js" })).headers["document-policy"], undefined);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("redact", () => {
  test("Kernal's device tokens and bare bearer tokens", () => {
    assert.equal(redact("kda_abcdefghijklmnopqrstuvwxyz0123 kdr_abcdefghijklmnopqrst kdc_ABCDEFGHIJKLMNOPQR"), "[redacted] [redacted] [redacted]");
    assert.equal(redact("sent Bearer eyJhbGciOiJIUzI1NiJ9xyz"), "sent Bearer [redacted]");
    assert.equal(redact("Authorization: Bearer abc.def.ghi-jkl"), "Authorization: Bearer [redacted]");
    assert.equal(redact("kda_short"), "kda_short", "too short to be a token");
  });
});
