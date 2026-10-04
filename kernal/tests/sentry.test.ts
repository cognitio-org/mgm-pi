/**
 * Sentry extension: the on/off rules (config.ts: Outfitter's fleet settings and the person's own
 * `/sentry off`), the fleet-settings cache and fetch (_shared/fleet-settings.ts), the process-wide
 * live gate (client.ts), event scrubbing (lib.ts), and error capture and trace spans driven through
 * the real entry point with a fake pi (harness.ts) and a fake Sentry client (no network, no real
 * @sentry/node init).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SIGNALS, decide, defaultEnvironment, describe as describeDecision, optedOut, releaseName } from "../.pi/extensions/sentry/config.ts";
import { applySentry, sending, _resetSentryState, type SentryLike, type SentryInit, type SentrySpan } from "../.pi/extensions/sentry/client.ts";
import { CRASH_MAX_AGE_MS, agentRunError, agentRunReport, crashesToReport, scrubEvent, toolSpanAttributes } from "../.pi/extensions/sentry/lib.ts";
import { MAX_CACHE_AGE_MS, cachedFleetSettings, parseFleetSettings, refreshFleetSettings, type FleetSettings } from "../.pi/extensions/_shared/fleet-settings.ts";
import sentryExtension from "../.pi/extensions/sentry/index.ts";
import { makePi } from "./harness.ts";

const DSN = "https://publicKey@o0.ingest.us.sentry.io/1";
const API = "https://link.outfitter.test";
const CREDS = { api: API, token: "outf_dongle" };
const ON: FleetSettings = { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.05 } } };
const OFF: FleetSettings = { telemetry: { sentry: { enabled: false } } };

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "kernal-fleet-")), "fleet-settings.json");
}

function writeCache(file: string, settings: FleetSettings, api = API, fetchedAt = new Date().toISOString()): void {
  writeFileSync(file, JSON.stringify({ api, fetchedAt, settings }));
}

/** A fetch that answers GET /api/fleet-settings with `body`, recording what it was asked. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; auth?: string }[] = [];
  const fn = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

function fakeSentry() {
  const inits: SentryInit[] = [];
  const captured: { error: unknown; context?: any }[] = [];
  const crashes: any[] = [];
  const spans: { name: string; op: string; attributes?: any; parent?: string; onlyIfParent?: boolean; status?: "ok" | "error"; ended: boolean }[] = [];
  const counts: { name: string; value: number; attributes?: Record<string, string> }[] = [];
  let flushes = 0;
  const sentry: SentryLike = {
    init(options) { inits.push(options); },
    captureException(error, context) { captured.push({ error, context }); return "event-id"; },
    captureCrash(crash) { crashes.push(crash); },
    count(name, value, attributes) { counts.push({ name, value, ...(attributes ? { attributes } : {}) }); },
    async flush() { flushes++; return true; },
    startInactiveSpan(options) {
      const rec = { name: options.name, op: options.op, attributes: options.attributes, parent: (options.parent?.raw as any)?.name, onlyIfParent: options.onlyIfParent, status: undefined as "ok" | "error" | undefined, ended: false };
      spans.push(rec);
      const span: SentrySpan = { setStatus: (o) => { rec.status = o; }, setAttributes: (a) => { rec.attributes = { ...rec.attributes, ...a }; }, end: () => { rec.ended = true; }, raw: rec };
      return span;
    },
  };
  return { sentry, inits, captured, spans, crashes, counts, flushes: () => flushes };
}

describe("sentry config: both Outfitter and the person must say yes", () => {
  test("on only with a Dongle, the fleet on, and no local opt-out", () => {
    assert.deepEqual(decide(ON, { optedOut: false, hasDongle: true }), { on: true, dsn: DSN, tracesSampleRate: 0.05, signals: NO_SIGNALS });
    assert.deepEqual(decide(OFF, { optedOut: false, hasDongle: true }), { on: false, why: "fleet" });
    assert.deepEqual(decide(ON, { optedOut: false, hasDongle: false }), { on: false, why: "no-dongle" });
    assert.deepEqual(decide(ON, { optedOut: true, hasDongle: true }), { on: false, why: "laptop" });
  });

  test("only a local false opts out (config.local.json or the legacy kernal.sentry); anything else follows the fleet", () => {
    assert.equal(optedOut({ kernal: { sentry: false } }), true);
    const local = (value: boolean, source = "local") => ({ "telemetry.sentry.enabled": { value, source, override: "opt-out", locked: false } }) as any;
    assert.equal(optedOut({}, local(false)), true, "config.local.json's false (/sentry off, /admin)");
    assert.equal(optedOut({}, local(true)), false);
    assert.equal(optedOut({}, local(false, "fleet")), false, "the fleet's off is not this laptop's opt-out");
    assert.equal(optedOut({ kernal: { sentry: true } }), false, "true cannot force it on");
    assert.equal(optedOut({ kernal: {} }), false);
    assert.equal(optedOut({}), false);
  });

  test("a release bundle reports as production, a source checkout as development", () => {
    assert.equal(defaultEnvironment(true), "production");
    assert.equal(defaultEnvironment(false), "development");
  });

  test("a bundle reports the release kernal@X.Y.Z, the name release.yml creates", () => {
    assert.equal(releaseName("0.3.0"), "kernal@0.3.0");
    assert.equal(releaseName("1.2.0-rc.1"), "kernal@1.2.0-rc.1");
  });

  test("the status line tells a decision apart from what is actually happening", () => {
    const on = { on: true as const, dsn: DSN, tracesSampleRate: 0.05 };
    assert.match(describeDecision(on, "failed"), /failed to start/);
    assert.match(describeDecision(on, "restart-needed"), /DSN changed/);
    assert.match(describeDecision(on, "starting"), /Starting up/);
  });

  test("agentRunReport redacts keys and keeps the fingerprint free of numbers and ids", () => {
    const r = agentRunReport("401: invalid key sk-ant-api03-AbCdEf1234567890abcdef1234567890");
    assert.ok(!r.message.includes("AbCdEf1234567890"), r.message);
    assert.equal(agentRunReport("503 after 3 tries").fingerprint[1], "<n> after <n> tries");
  });

  test("the status line says who decided", () => {
    assert.match(describeDecision({ on: true, dsn: DSN, tracesSampleRate: 0.05 }), /on, set by Outfitter.*5% of agent runs/);
    assert.match(describeDecision({ on: false, why: "laptop" }), /off on this laptop/);
    assert.match(describeDecision({ on: false, why: "fleet" }), /Outfitter has it off/);
    assert.match(describeDecision({ on: false, why: "no-dongle" }), /not connected to Outfitter/);
  });
});

describe("fleet settings on the laptop", () => {
  test("parseFleetSettings: anything but a well-formed 'on' reads as off", () => {
    assert.deepEqual(parseFleetSettings(ON), ON);
    assert.deepEqual(parseFleetSettings({ telemetry: { sentry: { enabled: true } } }), OFF, "no DSN");
    assert.deepEqual(parseFleetSettings({ telemetry: { sentry: { enabled: true, dsn: "not a dsn" } } }), OFF);
    assert.deepEqual(parseFleetSettings(null), OFF);
    assert.deepEqual(parseFleetSettings({ telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 7 } } }).telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0 });
  });

  test("the cache is used only with a Dongle, and only from the same Outfitter", () => {
    const file = tmpFile();
    writeCache(file, ON);
    assert.deepEqual(cachedFleetSettings(CREDS, file), ON);
    assert.deepEqual(cachedFleetSettings({}, file), OFF, "no Dongle: off, cached or not");
    assert.deepEqual(cachedFleetSettings({ ...CREDS, api: "https://other.test" }, file), OFF);
    assert.deepEqual(cachedFleetSettings(CREDS, join(tmpdir(), "missing", "x.json")), OFF);
  });

  test("refresh asks with the Dongle and caches the answer for the next start", async () => {
    const file = tmpFile();
    const { fn, calls } = fakeFetch(ON);
    assert.deepEqual(await refreshFleetSettings(CREDS, { fetch: fn, file }), ON);
    assert.deepEqual(calls, [{ url: `${API}/api/fleet-settings`, auth: "Bearer outf_dongle" }]);
    const cache = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(cache.api, API);
    assert.deepEqual(cache.settings, ON);
  });

  test("an outage keeps the cached answer and does not throw", async () => {
    const file = tmpFile();
    writeCache(file, ON);
    assert.equal(await refreshFleetSettings(CREDS, { fetch: fakeFetch({}, 503).fn, file }), undefined);
    const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
    assert.equal(await refreshFleetSettings(CREDS, { fetch: offline, file }), undefined);
    assert.deepEqual(cachedFleetSettings(CREDS, file), ON);
  });

  test("a refused Dongle replaces a cached 'on' with off", async () => {
    const file = tmpFile();
    writeCache(file, ON);
    assert.deepEqual(await refreshFleetSettings(CREDS, { fetch: fakeFetch({ error: "invalid token" }, 401).fn, file }), OFF);
    assert.deepEqual(cachedFleetSettings(CREDS, file), OFF);
  });

  test("a cached answer older than the limit reads as off", () => {
    const file = tmpFile();
    const now = Date.parse("2026-10-03T00:00:00.000Z");
    writeCache(file, ON, API, new Date(now - MAX_CACHE_AGE_MS - 1).toISOString());
    assert.deepEqual(cachedFleetSettings(CREDS, file, now), OFF);
    writeCache(file, ON, API, new Date(now - 1000).toISOString());
    assert.deepEqual(cachedFleetSettings(CREDS, file, now), ON);
  });

  test("an OUTFITTER_API with a path prefix keeps it", async () => {
    const { fn, calls } = fakeFetch(ON);
    await refreshFleetSettings({ api: "https://example.test/outfitter/", token: "t" }, { fetch: fn, file: tmpFile() });
    assert.equal(calls[0].url, "https://example.test/outfitter/api/fleet-settings");
  });

  test("no Dongle: no request at all", async () => {
    const { fn, calls } = fakeFetch(ON);
    assert.equal(await refreshFleetSettings({}, { fetch: fn, file: tmpFile() }), undefined);
    assert.equal(calls.length, 0);
  });
});

describe("applySentry: the process-wide live gate", () => {
  beforeEach(() => _resetSentryState());
  const runtime = { environment: "development" };

  test("starts the SDK once, then only moves the gate", async () => {
    const { sentry, inits } = fakeSentry();
    await applySentry({ on: true, dsn: DSN, tracesSampleRate: 0.05 }, runtime, sentry);
    assert.equal(sending(), true);
    await applySentry({ on: false, why: "laptop" }, runtime, sentry);
    assert.equal(sending(), false);
    assert.equal(inits[0].gate().sending, false, "the SDK's beforeSend sees off at once");
    await applySentry({ on: true, dsn: DSN, tracesSampleRate: 0.5 }, runtime, sentry);
    assert.equal(inits.length, 1);
    assert.equal(inits[0].gate().tracesSampleRate, 0.5);
  });

  test("never starts while off", async () => {
    const { sentry, inits } = fakeSentry();
    await applySentry({ on: false, why: "fleet" }, runtime, sentry);
    assert.equal(inits.length, 0);
    assert.equal(sending(), false);
  });

  test("a new DSN mid-process sends nothing until Kernal restarts", async () => {
    const { sentry } = fakeSentry();
    await applySentry({ on: true, dsn: DSN, tracesSampleRate: 0.05 }, runtime, sentry);
    await applySentry({ on: true, dsn: "https://otherKey@o0.ingest.us.sentry.io/2", tracesSampleRate: 0.05 }, runtime, sentry);
    assert.equal(sending(), false);
  });

  test("a decision that changes while the SDK is still loading wins once it has loaded", async () => {
    let release!: () => void;
    const inits: SentryInit[] = [];
    const slow: SentryLike = {
      init: (o) => { inits.push(o); return new Promise<void>((r) => { release = r; }); },
      captureException: () => "id",
      captureCrash: () => {},
      flush: async () => true,
      count: () => {},
      startInactiveSpan: () => ({ setStatus() {}, setAttributes() {}, end() {} }),
    };
    const starting = applySentry({ on: true, dsn: DSN, tracesSampleRate: 0.05 }, runtime, slow);
    await applySentry({ on: false, why: "laptop" }, runtime, slow);
    release();
    await starting;
    assert.equal(inits.length, 1);
    assert.equal(sending(), false);
  });

  test("an SDK that fails to start leaves Sentry off and never throws", async () => {
    const broken: SentryLike = {
      init: () => { throw new Error("Cannot find module '@sentry/node'"); },
      captureException: () => "id",
      captureCrash: () => {},
      flush: async () => true,
      count: () => {},
      startInactiveSpan: () => ({ setStatus() {}, setAttributes() {}, end() {} }),
    };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { errors.push(a[0]); };
    try {
      await applySentry({ on: true, dsn: DSN, tracesSampleRate: 0.05 }, runtime, broken);
      await applySentry({ on: true, dsn: DSN, tracesSampleRate: 0.05 }, runtime, broken);
    } finally {
      console.error = original;
    }
    assert.equal(sending(), false);
    assert.equal(errors.length, 1, "said once");
    assert.match(String(errors[0]), /Sentry did not start/);
  });

  test("the state survives a reload: a second extension instance does not start the SDK again", () => {
    const { sentry, inits } = fakeSentry();
    const file = tmpFile();
    writeCache(file, ON);
    sentryExtension(makePi() as any, { sentry, credentials: CREDS, settings: {}, cacheFile: file, fetch: fakeFetch(ON).fn, onRefresh: () => {} });
    sentryExtension(makePi() as any, { sentry, credentials: CREDS, settings: {}, cacheFile: file, fetch: fakeFetch(ON).fn, onRefresh: () => {} });
    assert.equal(inits.length, 1);
  });
});

describe("crashes from earlier runs (pi's crashes.json)", () => {
  beforeEach(() => _resetSentryState());
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const record = (timestamp: string, extra: Record<string, unknown> = {}) => ({
    timestamp, version: "0.87.1", kind: "uncaught_exception", message: "boom", stack: "Error: boom\n    at x (/Users/someone/a.ts:1:1)",
    sessionFile: "/Users/someone/.pi/sessions/s.jsonl", cwd: "/Users/someone/secret-project", ...extra,
  });

  test("crashesToReport: recent, unsent, well-formed, and never the cwd or session file", () => {
    const records = [record("2026-10-03T11:00:00.000Z"), record("2026-10-02T11:00:00.000Z"), record(new Date(now - CRASH_MAX_AGE_MS - 1).toISOString()), { nope: 1 }];
    const out = crashesToReport(records, ["2026-10-02T11:00:00.000Z"], now);
    assert.deepEqual(out.map((c) => c.timestamp), ["2026-10-03T11:00:00.000Z"]);
    assert.equal((out[0] as any).cwd, undefined);
    assert.equal((out[0] as any).sessionFile, undefined);
    assert.deepEqual(crashesToReport("garbage", [], now), []);
  });

  async function start(opts: { cached: FleetSettings; crashFile: string; sentFile: string }) {
    const fake = fakeSentry();
    sentryExtension(makePi() as any, {
      signedIn: false, sentry: fake.sentry, credentials: CREDS, settings: {}, cacheFile: (() => { const f = tmpFile(); writeCache(f, opts.cached); return f; })(),
      fetch: fakeFetch(opts.cached).fn, onRefresh: () => {}, crashFile: opts.crashFile, crashesSentFile: opts.sentFile, now: () => now,
    });
    await new Promise((r) => setImmediate(r));
    return fake;
  }

  test("sent once Sentry is on, and each crash only once, across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-crash-"));
    const crashFile = join(dir, "crashes.json");
    const sentFile = join(dir, "sent.json");
    writeFileSync(crashFile, JSON.stringify([record("2026-10-03T11:00:00.000Z")]));
    const first = await start({ cached: ON, crashFile, sentFile });
    assert.equal(first.crashes.length, 1);
    assert.equal(first.crashes[0].message, "boom");
    _resetSentryState(); // a later Kernal start
    const second = await start({ cached: ON, crashFile, sentFile });
    assert.equal(second.crashes.length, 0);
  });

  test("nothing is sent, or marked sent, while Sentry is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-crash-"));
    const crashFile = join(dir, "crashes.json");
    const sentFile = join(dir, "sent.json");
    writeFileSync(crashFile, JSON.stringify([record("2026-10-03T11:00:00.000Z")]));
    const off = await start({ cached: OFF, crashFile, sentFile });
    assert.equal(off.crashes.length, 0);
    _resetSentryState();
    const on = await start({ cached: ON, crashFile, sentFile });
    assert.equal(on.crashes.length, 1, "still pending for the first start with Sentry on");
  });
});

describe("the real @sentry/node, in a child process", () => {
  test("drops Console and OnUnhandledRejection, survives a reload, and sends nothing at all while off", () => {
    const out = execFileSync(process.execPath, ["--import", "./tests/resolve-pi.mjs", "tests/fixtures/sentry-real-child.ts"], { encoding: "utf8", timeout: 60_000 });
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    assert.ok(!r.integrations.includes("Console"), "console lines never ride along as breadcrumbs");
    assert.ok(!r.integrations.includes("OnUnhandledRejection"));
    assert.ok(r.integrations.includes("OnUncaughtException"));
    assert.equal(r.unhandledRejectionListeners, 0, "pi keeps crashing on an unhandled rejection");
    assert.equal(r.reloadError, undefined, "a reloaded module copy still reaches the running SDK");
    assert.ok(r.whileOn.includes("event"));
    assert.deepEqual(r.whileOff, [], "no events, client reports or sessions while off");
    assert.deepEqual(r.runChildren, ["tool.read"], "a tool call is a child span inside its run's transaction");
    assert.deepEqual(r.traceHeaders, { sentryTrace: null, baggage: null }, "no trace headers on outbound requests");
    assert.deepEqual(r.crash, { level: "fatal", type: "UncaughtException", value: "boom", hasFrames: true, source: "crash", crashedAtTag: false }, "a recorded crash arrives as a fatal event with its stack");
    // #424: Kernal's own gen_ai spans reach Sentry (the run as a transaction, its model call in the
    // SDK's span item), counters only with metrics on and never with the hostname, and no AI SDK
    // auto-instrumentation runs beside them.
    for (const name of ["OpenAI", "Anthropic_AI", "Google_GenAI", "VercelAI", "LangChain"]) assert.ok(!r.integrations.includes(name), name);
    // Content in a gen_ai span leaves with home as ~ (the SDK moves the span after scrubbing), and
    // content recorded before an agentContent opt-out never leaves at all.
    assert.deepEqual(r.genAi, { agentTransaction: true, chatInputTokens: 10, chatOp: "gen_ai.chat", chatInputScrubbed: true, staleSpanSent: true, staleContent: null, metrics: ["kernal.tool.calls"], metricHasHost: false, metricTool: "read" });
  });
});

describe("scrubEvent", () => {
  test("survives the SDK's cyclic metadata and leaves it untouched", () => {
    const scope: any = { name: "scope" };
    scope.self = scope;
    const event = { message: "/Users/someone/x", sdkProcessingMetadata: { capturedSpanScope: scope }, spans: [{ data: { path: "/Users/someone/y" } }] };
    const out = scrubEvent(event, "/Users/someone");
    assert.equal(out.message, "~/x");
    assert.equal(out.spans[0].data.path, "~/y");
    assert.equal(out.sdkProcessingMetadata.capturedSpanScope, scope);
  });

  test("drops the hostname and writes the home directory as ~", () => {
    const event = {
      server_name: "Someones-MacBook-Pro.local",
      exception: { values: [{ value: "ENOENT: /Users/someone/project/x.ts", stacktrace: { frames: [{ filename: "/Users/someone/.kernal/kernal-0.2.10/.pi/extensions/a.ts" }] } }] },
    };
    const out = scrubEvent(event, "/Users/someone");
    assert.equal((out as any).server_name, undefined);
    assert.equal(out.exception.values[0].value, "ENOENT: ~/project/x.ts");
    assert.equal(out.exception.values[0].stacktrace.frames[0].filename, "~/.kernal/kernal-0.2.10/.pi/extensions/a.ts");
  });
});

describe("sentry lib", () => {
  test("agentRunError finds the last failed assistant turn", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", content: [] },
      { role: "assistant", stopReason: "error", errorMessage: "503: overloaded" },
    ];
    assert.equal(agentRunError(messages as any), "503: overloaded");
    assert.equal(agentRunError([{ role: "assistant", stopReason: "stop" }] as any), undefined);
    assert.equal(agentRunError([]), undefined);
    assert.equal(agentRunError([{ role: "assistant", stopReason: "error" }] as any), "(error without message)");
  });

  test("toolSpanAttributes carries only the tool name (no args/results: those can hold secrets)", () => {
    assert.deepEqual(toolSpanAttributes("bash"), { "kernal.tool": "bash" });
  });
});

describe("sentry extension wired to pi", () => {
  beforeEach(() => _resetSentryState());

  /** The extension on a fake pi, with the fleet `cached` from a previous start and `fresh` from
   * Outfitter now. Resolves once the background refresh has landed. */
  async function load(opts: { cached?: FleetSettings; fresh?: unknown; settings?: Record<string, unknown>; credentials?: typeof CREDS | {} } = {}) {
    const fake = fakeSentry();
    const pi = makePi();
    const file = tmpFile();
    if (opts.cached) writeCache(file, opts.cached);
    const fetch = fakeFetch(opts.fresh ?? opts.cached ?? OFF);
    const saved: Array<false | undefined> = [];
    let refreshed: Promise<void> = Promise.resolve();
    sentryExtension(pi as any, {
      signedIn: false, // not the developer's own login
      sentry: fake.sentry,
      credentials: opts.credentials ?? CREDS,
      settings: opts.settings ?? {},
      saveOptOut: (v) => saved.push(v),
      fetch: fetch.fn,
      cacheFile: file,
      onRefresh: (p) => { refreshed = p; },
    });
    await refreshed;
    await new Promise((r) => setImmediate(r)); // the start-up apply, which nothing awaits
    const notes: string[] = [];
    const ctx = { ui: { notify: (m: string) => notes.push(m) } };
    const command = (args: string) => pi.commands.get("sentry")!.handler(args, ctx);
    return { ...fake, pi, fetch, saved, notes, command };
  }

  test("a clean agent run on: an ok trace span and no captured error", async () => {
    const { pi, spans, captured } = await load({ cached: ON });
    await pi.emit("agent_start", {}, {});
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, {});
    assert.equal(captured.length, 0);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "agent.run");
    assert.equal(spans[0].status, "ok");
    assert.equal(spans[0].ended, true);
  });

  test("an agent run that ends in an assistant error is captured and its span marked error", async () => {
    const { pi, spans, captured } = await load({ cached: ON });
    await pi.emit("agent_start", {}, {});
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "401: nope" }] }, {});
    assert.equal(captured.length, 1);
    assert.equal((captured[0].error as Error).message, "401: nope");
    assert.equal(captured[0].context.tags.source, "agent_end");
    assert.equal(spans[0].status, "error");
  });

  test("tool calls are child spans of their run, keyed by toolCallId, open across the two events", async () => {
    const { pi, spans } = await load({ cached: ON });
    await pi.emit("agent_start", {}, {});
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read" }, {});
    await pi.emit("tool_execution_start", { toolCallId: "c2", toolName: "write" }, {});
    assert.equal(spans[1].ended, false);
    await pi.emit("tool_execution_end", { toolCallId: "c2", toolName: "write", isError: true }, {});
    await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "read", isError: false }, {});
    assert.deepEqual(spans.slice(1).map((s) => [s.name, s.op, s.parent, s.onlyIfParent, s.status, s.ended]), [
      ["tool.read", "tool.execute", "agent.run", true, "ok", true],
      ["tool.write", "tool.execute", "agent.run", true, "error", true],
    ]);
    assert.deepEqual(spans[1].attributes, { "kernal.tool": "read" });
  });

  test("a tool call outside an agent run gets no span", async () => {
    const { pi, spans } = await load({ cached: ON });
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read" }, {});
    await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "read", isError: false }, {});
    assert.equal(spans.length, 0);
  });

  test("a failed run is reported redacted and grouped by its message's shape", async () => {
    const { pi, captured } = await load({ cached: ON });
    await pi.emit("agent_start", {}, {});
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429: rate limited (request req_8f3a9c2e1b7d4f60)" }] }, {});
    assert.deepEqual(captured[0].context.fingerprint, ["agent_end", "<n>: rate limited (request <id>)"]);
  });

  test("/sentry on that cannot be saved stays off and says so", async () => {
    const fake = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { signedIn: false, sentry: fake.sentry, credentials: CREDS, settings: { kernal: { sentry: false } }, cacheFile: tmpFile(), fetch: fakeFetch(ON).fn, onRefresh: () => {}, saveOptOut: () => { throw new Error("settings.json is not valid JSON"); } });
    const notes: string[] = [];
    await pi.commands.get("sentry")!.handler("on", { ui: { notify: (m: string) => notes.push(m) } });
    assert.equal(sending(), false);
    assert.match(notes[0], /stays off/);
  });

  test("off by default: nothing cached, Outfitter off -- no init, no spans, no captures", async () => {
    const { pi, inits, spans, captured } = await load({});
    await pi.emit("agent_start", {}, {});
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "x" }] }, {});
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read" }, {});
    assert.equal(inits.length, 0);
    assert.equal(spans.length, 0);
    assert.equal(captured.length, 0);
  });

  test("no Dongle: off, and Outfitter is never asked", async () => {
    const { inits, fetch } = await load({ cached: ON, credentials: {} });
    assert.equal(inits.length, 0);
    assert.equal(fetch.calls.length, 0);
  });

  test("Outfitter turning it on reaches a running session once the refresh lands", async () => {
    const { pi, inits, spans } = await load({ cached: OFF, fresh: ON });
    assert.equal(inits.length, 1);
    assert.equal(inits[0].dsn, DSN);
    await pi.emit("agent_start", {}, {});
    assert.equal(spans.length, 1);
  });

  test("Outfitter turning it off stops a running session's sending", async () => {
    const { inits } = await load({ cached: ON, fresh: OFF });
    assert.equal(inits.length, 1, "started from the cache");
    assert.equal(sending(), false, "then stopped by the fresh answer");
  });

  test("an opted-out laptop sends nothing and does not even ask Outfitter", async () => {
    const { inits, fetch, notes, command } = await load({ cached: ON, settings: { kernal: { sentry: false } } });
    assert.equal(inits.length, 0);
    assert.equal(fetch.calls.length, 0);
    await command("");
    assert.match(notes[0], /off on this laptop/);
  });

  test("/sentry off stops sending at once and saves the opt-out; /sentry on clears it", async () => {
    const { saved, notes, command } = await load({ cached: ON });
    assert.equal(sending(), true);
    await command("off");
    assert.equal(sending(), false);
    assert.deepEqual(saved, [false]);
    assert.match(notes.at(-1)!, /off on this laptop/);
    await command("on");
    assert.equal(sending(), true);
    assert.deepEqual(saved, [false, undefined]);
    assert.match(notes.at(-1)!, /on, set by Outfitter/);
  });

  test("/sentry on cannot override Outfitter's off", async () => {
    const { notes, command } = await load({ cached: OFF });
    await command("on");
    assert.equal(sending(), false);
    assert.match(notes.at(-1)!, /Outfitter has it off/);
  });

  test("an older instance's late refresh cannot turn sending back on after a reload", async () => {
    const { sentry } = fakeSentry();
    let releaseOld!: (r: Response) => void;
    const slowFetch = (() => new Promise<Response>((r) => { releaseOld = r; })) as typeof fetch;
    let oldRefresh: Promise<void> = Promise.resolve();
    const file = tmpFile();
    writeCache(file, OFF);
    sentryExtension(makePi() as any, { sentry, credentials: CREDS, settings: {}, cacheFile: file, fetch: slowFetch, onRefresh: (p) => { oldRefresh = p; } });
    // /reload: a new instance, opted out.
    sentryExtension(makePi() as any, { sentry, credentials: CREDS, settings: { kernal: { sentry: false } }, cacheFile: file, fetch: fakeFetch(ON).fn, onRefresh: () => {} });
    await new Promise((r) => setImmediate(r)); // the old refresh awaits its bearer (outfitterBearer) before it fetches
    releaseOld(new Response(JSON.stringify(ON), { status: 200, headers: { "content-type": "application/json" } }));
    await oldRefresh;
    await new Promise((r) => setImmediate(r));
    assert.equal(sending(), false);
  });

  test("/sentry off stops sending even when saving the setting fails", async () => {
    const fake = fakeSentry();
    const pi = makePi();
    const file = tmpFile();
    writeCache(file, ON);
    sentryExtension(pi as any, { signedIn: false, sentry: fake.sentry, credentials: CREDS, settings: {}, cacheFile: file, fetch: fakeFetch(ON).fn, onRefresh: () => {}, saveOptOut: () => { throw new Error("settings.json is not valid JSON"); } });
    await new Promise((r) => setImmediate(r));
    assert.equal(sending(), true);
    const notes: string[] = [];
    await pi.commands.get("sentry")!.handler("off", { ui: { notify: (m: string) => notes.push(m) } });
    assert.equal(sending(), false);
    assert.match(notes[0], /saving that failed/);
  });

  test("an unknown subcommand prints the usage", async () => {
    const { notes, command } = await load({});
    await command("maybe");
    assert.match(notes[0], /usage: \/sentry/);
  });
});
