/**
 * Kernal applies the centrally managed personal settings (#437): model.provider, model.default,
 * model.thinking, compaction.summaryModel, compaction.masking, memory.mode, voice.enabled and
 * voice.language. The precedence (this machine → account → legacy local values → fleet → default)
 * per key, the effective file bin/kernal reads (memory mode, with and without node), the model and
 * thinking level at session start (never mid-conversation), voice into pi-listen's settings,
 * compaction and laptop memory reading the resolution, a Drive's run settings, and /connect's save
 * target. The session, Outfitter and the environment are fakes; nothing leaves the process.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx, makePi, tmpAgentDir, fakeTransport } from "./harness.ts";
import {
  KNOWN_SETTINGS, _resetCentralConfig, _setCentralConfigDeps, combineAccountFirst, configCachePath, describeSource, effectivePath,
  localOverridesPath, resolve, setLocalOverride, startBackgroundRefresh, type ConfigResponse,
} from "../.pi/extensions/_shared/central-config.ts";
import { applyModelAtSessionStart, applyVoiceSettings, cliChoices, describeChanges, snapshot } from "../.pi/extensions/_shared/central-apply.ts";
import { _setAdminCentralDeps, whenSaved } from "../.pi/extensions/kernal-admin/central.ts";
import { maskingFrom, summarizerFrom } from "../.pi/extensions/compaction/index.ts";
import { chosenMode, registerLaptopMemory } from "../.pi/extensions/outfitter-agentengine/laptop.ts";
import configExtension from "../.pi/extensions/kernal-config/index.ts";

const API = "https://link.outfitter.test";
const EMAIL = "a@example.com";
const ACCOUNT = { api: API, email: EMAIL, userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };

const tmp = mkdtempSync(join(tmpdir(), "kernal-apply-"));
process.env.HOME = tmp; process.chdir(tmp);   // no real ~/localllm/.env in reach
const connect = await import("../.pi/extensions/connect/index.ts");

let home: string;
let signedIn: boolean;
let shell: NodeJS.ProcessEnv;
let dotenv: Record<string, string>;
let settings: Record<string, unknown>;
let shipped: Record<string, unknown>;
let voice: Record<string, unknown>;
let fetchImpl: typeof fetch;
const now = Date.parse("2026-10-04T12:00:00.000Z");

const session = {
  loginState: () => (signedIn ? { signedIn: true as const, account: ACCOUNT } : { signedIn: false as const }),
  getAccessToken: async () => (signedIn ? "kda_test" : undefined),
  getRouterKey: () => undefined,
  setRouterKey: () => {},
  outfitterApi: () => API,
};

function setup() {
  _resetCentralConfig();
  _setCentralConfigDeps({
    session, env: () => shell, dotenv: () => dotenv, settings: () => settings, shippedSettings: () => shipped, voiceSettings: () => voice,
    now: () => now, warn: () => {}, fetch: (...a: Parameters<typeof fetch>) => fetchImpl(...a),
  });
  _setAdminCentralDeps({});
  _setAdminCentralDeps({ session, fetch: (...a: Parameters<typeof fetch>) => fetchImpl(...a) });
}

function response(values: ConfigResponse["values"], extra: Partial<ConfigResponse> = {}): ConfigResponse {
  return { schemaVersion: 2, account: { email: EMAIL, userId: "u_1" }, profile: null, profiles: [], values, resolvedAt: "2026-10-04T10:00:00.000Z", ...extra };
}

function writeCache(resp: ConfigResponse, profile?: string) {
  const file = configCachePath(API, EMAIL, profile);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ api: API, email: EMAIL, profile: profile ?? null, fetchedAt: new Date(now).toISOString(), response: resp }));
}

function writeLocal(values: Record<string, unknown>) {
  mkdirSync(home, { recursive: true });
  writeFileSync(localOverridesPath(), JSON.stringify({ version: 1, values }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kernal-apply-home-"));
  process.env.KERNAL_HOME_DIR = home;
  process.env.KERNAL_VOICE_SETTINGS = join(home, "pi-listen", "settings.json");
  delete process.env.KERNAL_CONFIG_CACHE_DIR;
  delete process.env.KERNAL_SANDBOX;
  delete process.env.KERNAL_RUN_SETTINGS;
  signedIn = true;
  shell = { OUTFITTER_API: API };
  dotenv = {};
  settings = {};
  shipped = {};
  voice = {};
  fetchImpl = (async () => { throw new Error("no network in this test"); }) as typeof fetch;
  setup();
});
afterEach(() => { _setAdminCentralDeps({}); _resetCentralConfig(); });

// ---------- precedence, per key ----------

/** Each personal key: two values, and how to put one in its legacy place. */
const KEYS: { key: string; a: unknown; b: unknown; c: unknown; legacy: (v: unknown) => void; legacyName: string }[] = [
  { key: "model.provider", a: "lmstudio", b: "openrouter", c: "litellm", legacy: (v) => { settings = { ...settings, defaultProvider: v, defaultModel: "m-legacy" }; }, legacyName: "settings.json defaultProvider" },
  { key: "model.default", a: "m-local", b: "m-account", c: "m-legacy", legacy: (v) => { settings = { ...settings, defaultProvider: "litellm", defaultModel: v }; }, legacyName: "settings.json defaultModel" },
  { key: "model.thinking", a: "high", b: "low", c: "minimal", legacy: (v) => { settings = { ...settings, defaultThinkingLevel: v }; }, legacyName: "settings.json defaultThinkingLevel" },
  { key: "compaction.summaryModel", a: "litellm/a", b: "litellm/b", c: "litellm/c", legacy: (v) => { settings = { ...settings, kernal: { compaction: { summaryModel: v } } }; }, legacyName: "settings.json kernal.compaction" },
  { key: "compaction.masking", a: false, b: true, c: false, legacy: (v) => { settings = { ...settings, kernal: { compaction: { masking: v } } }; }, legacyName: "settings.json kernal.compaction" },
  { key: "memory.mode", a: "off", b: "tool", c: "auto", legacy: (v) => { settings = { ...settings, kernal: { memory: v } }; }, legacyName: "settings.json kernal.memory" },
  { key: "voice.enabled", a: false, b: true, c: false, legacy: (v) => { voice = { voice: { enabled: v } }; }, legacyName: "pi-listen settings" },
  { key: "voice.language", a: "sl", b: "de", c: "fr", legacy: (v) => { voice = { voice: { language: v } }; }, legacyName: "pi-listen settings" },
];

describe("precedence (#437): this machine → account → legacy → fleet → default", () => {
  for (const k of KEYS) {
    test(k.key, () => {
      const fleetValue = k.key === "compaction.masking" || k.key === "voice.enabled" ? k.b : k.a;   // any valid value
      // the fleet alone
      writeCache(response({ [k.key]: { value: fleetValue, source: "fleet" } }));
      setup();
      assert.equal(resolve().values[k.key].source, "fleet");
      // a legacy value beats the fleet
      k.legacy(k.c);
      setup();
      assert.deepEqual([resolve().values[k.key].value, resolve().values[k.key].source, resolve().values[k.key].sourceName], [k.c, "legacy", k.legacyName]);
      assert.equal(describeSource(resolve().values[k.key]), `${k.legacyName} (legacy)`);
      // the account (user, profile, device) beats the legacy value
      for (const source of ["user", "profile", "device"]) {
        writeCache(response({ [k.key]: { value: k.b, source, ...(source === "profile" ? { sourceName: "work" } : {}) } }));
        setup();
        assert.deepEqual([resolve().values[k.key].value, resolve().values[k.key].source], [k.b, source], source);
      }
      // this machine beats the account
      writeLocal({ [k.key]: k.a });
      setup();
      assert.deepEqual(resolve().values[k.key], { value: k.a, source: "local", override: "any", locked: false });
      // the server forbids local values: the account again, and the legacy value is ignored too
      writeCache(response({ [k.key]: { value: k.b, source: "user", localAllowed: false } }));
      setup();
      assert.equal(resolve().values[k.key].source, "user");
    });
  }

  test("every personal key is accountFirst, and nothing else is", () => {
    assert.deepEqual(KNOWN_SETTINGS.filter((d) => d.accountFirst).map((d) => d.key).sort(), KEYS.map((k) => k.key).sort());
  });

  test("KERNAL_SUMMARY_MODEL is legacy: below the account, the shell above .env above settings.json", () => {
    settings = { kernal: { compaction: { summaryModel: "litellm/settings" } } };
    dotenv = { KERNAL_SUMMARY_MODEL: "litellm/dotenv" };
    shell = { OUTFITTER_API: API, KERNAL_SUMMARY_MODEL: "litellm/shell" };
    setup();
    assert.equal(resolve().values["compaction.summaryModel"].sourceName, "KERNAL_SUMMARY_MODEL in the shell");
    writeCache(response({ "compaction.summaryModel": { value: "litellm/account", source: "user" } }));
    setup();
    assert.equal(resolve().values["compaction.summaryModel"].value, "litellm/account");
  });

  test("a settings.json default model equal to the shipped one is the release's default, not legacy", () => {
    shipped = { defaultProvider: "litellm", defaultModel: "gpt-5.4-nano" };
    settings = { defaultProvider: "litellm", defaultModel: "gpt-5.4-nano" };
    writeCache(response({ "model.default": { value: "fleet-model", source: "fleet" } }));
    setup();
    assert.equal(resolve().values["model.default"].source, "fleet", "the fleet's default beats the release's");
    settings = { defaultProvider: "litellm", defaultModel: "my-pick" };
    setup();
    assert.equal(resolve().values["model.default"].source, "legacy", "the person's own pick beats the fleet");
    assert.equal(resolve().values["model.provider"].source, "legacy", "provider and model count as a pair");
  });

  test("combineAccountFirst: the default when nothing sets it", () => {
    const d = KNOWN_SETTINGS.find((x) => x.key === "voice.language")!;
    assert.deepEqual(combineAccountFirst(d, undefined, undefined, []), { value: "en", source: "default", override: "any", locked: false });
    assert.equal(combineAccountFirst(KNOWN_SETTINGS.find((x) => x.key === "model.default")!, undefined, undefined, []), undefined);
  });

  test("the start-up refresh takes over the personal keys' fresh values at once", async () => {
    writeCache(response({ "compaction.masking": { value: true, source: "user" } }));
    setup();
    assert.equal(resolve().values["compaction.masking"].value, true);
    fetchImpl = (async () => new Response(JSON.stringify(response({ "compaction.masking": { value: false, source: "user" }, "model.default": { value: "m2", source: "user" } })), { status: 200 })) as typeof fetch;
    const before = snapshot(resolve());
    await startBackgroundRefresh();
    assert.equal(resolve().values["compaction.masking"].value, false);
    const lines = describeChanges(before, resolve());
    assert.ok(lines.some((l) => /compaction\.masking → false \(your account\): applied now/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /model\.default → m2 .*next session.*keeps its model/.test(l)), lines.join("\n"));
  });
});

// ---------- a Drive ----------

describe("a Drive: KERNAL_RUN_SETTINGS (agentd) ranks with the fleet", () => {
  const run = (values: Record<string, unknown>, sources: Record<string, string> = {}) =>
    JSON.stringify({ schemaVersion: 2, profile: "work", values, sources });

  test("read only inside a sandbox; the tape's own env still wins", () => {
    signedIn = false;
    shell = { KERNAL_RUN_SETTINGS: run({ "compaction.summaryModel": "litellm/owner", "compaction.masking": false }, { "compaction.summaryModel": "profile", "compaction.masking": "user" }) };
    setup();
    assert.equal(resolve().values["compaction.masking"].source, "default", "not a sandbox: ignored");
    shell = { ...shell, KERNAL_SANDBOX: "1" };
    setup();
    assert.deepEqual(resolve().values["compaction.masking"], { value: false, source: "user", override: "any", locked: false });
    assert.equal(resolve().values["compaction.summaryModel"].sourceName, "work");
    assert.equal(resolve().profile, "work");
    shell = { ...shell, KERNAL_SUMMARY_MODEL: "litellm/tape" };
    setup();
    assert.equal(resolve().values["compaction.summaryModel"].value, "litellm/tape");
  });

  test("no model switch at session start in a Drive (agentd passes --model)", async () => {
    process.env.KERNAL_SANDBOX = "1";
    try {
      const pi = makePi();
      const r = await applyModelAtSessionStart(pi, { reason: "startup" }, makeCtx({ model: { provider: "litellm", id: "a", contextWindow: 1, maxTokens: 1 } }), { argv: [] });
      assert.match(r.skipped!, /Drive/);
      assert.equal(pi.setModelCalls.length, 0);
    } finally { delete process.env.KERNAL_SANDBOX; }
  });
});

// ---------- the effective file and bin/kernal ----------

describe("the effective file bin/kernal reads", () => {
  test("written signed in, non-secret, one value per line; per profile; not signed out", () => {
    writeCache(response({ "memory.mode": { value: "off", source: "user" }, "router.baseUrl": { value: "https://router.kernal.one/v1", source: "fleet" } }));
    setup();
    resolve();
    const text = readFileSync(effectivePath(undefined)!, "utf8");
    const j = JSON.parse(text);
    assert.equal(j.values["memory.mode"], "off");
    assert.equal(j.sources["memory.mode"], "user");
    assert.equal(j.values["router.key"], undefined, "no secrets");
    assert.match(text, /^ {4}"memory\.mode": "off",?$/m);
    assert.match(effectivePath("work")!, /effective\.work\.json$/);
    assert.equal(effectivePath("../x"), undefined);
    // this machine's save rewrites it
    setLocalOverride("memory.mode", "tool");
    assert.equal(JSON.parse(readFileSync(effectivePath(undefined)!, "utf8")).sources["memory.mode"], "local");
    rmSync(effectivePath(undefined)!);
    signedIn = false;
    setup();
    resolve();
    assert.equal(existsSync(effectivePath(undefined)!), false);
  });

  /** bin/kernal's pi_memory_env, run with `path` as PATH; prints whether pi-memory was turned off. */
  function memoryEnv(agentDir: string, path: string, extra: Record<string, string> = {}): string {
    const bin = readFileSync(join(import.meta.dirname, "..", "bin", "kernal"), "utf8");
    const start = bin.indexOf("pi_memory_env() {");
    const fn = bin.slice(start, bin.indexOf("\n}\n", start) + 3);
    return execFileSync("/bin/bash", ["-c", `${fn}\npi_memory_env\necho "off=\${KERNAL_PI_MEMORY_OFF:-}"`], {
      encoding: "utf8",
      env: { PATH: path, HOME: "/h", TMPDIR: agentDir, PI_CODING_AGENT_DIR: agentDir, KERNAL_HOME_DIR: home, KERNAL_AUTH_DIR: join(home, "auth"), ...extra },
    }).trim();
  }

  /** A PATH with the tools pi_memory_env needs, but no node. */
  function pathWithoutNode(): string {
    const dir = join(home, "bin-no-node");
    mkdirSync(dir, { recursive: true });
    for (const tool of ["sed", "head", "mkdir", "mktemp", "find", "rm"]) {
      const found = execFileSync("/bin/bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      if (!existsSync(join(dir, tool))) symlinkSync(found, join(dir, tool));
    }
    return dir;
  }

  for (const withNode of [true, false]) {
    test(`bin/kernal's memory mode follows central-config (${withNode ? "node" : "no node: sed"})`, () => {
      const agent = tmpAgentDir({ kernal: { memory: "auto" } });
      mkdirSync(join(home, "auth"), { recursive: true });
      writeFileSync(join(home, "auth", "accounts.json"), "{}");
      const path = withNode ? (process.env.PATH ?? "") : pathWithoutNode();
      settings = agent.read();
      // No effective file yet: settings.json's kernal.memory, as before.
      assert.equal(memoryEnv(agent.dir, path), "off=1");
      // The account turns memory off: it wins over kernal.memory.
      writeCache(response({ "memory.mode": { value: "off", source: "user" } }));
      setup();
      resolve();
      assert.equal(memoryEnv(agent.dir, path), "off=", "the account's off");
      // The fleet's off loses to kernal.memory.
      writeCache(response({ "memory.mode": { value: "off", source: "fleet" } }));
      setup();
      resolve();
      assert.equal(memoryEnv(agent.dir, path), "off=1", "kernal.memory beats the fleet");
      // ... and wins without it.
      writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({ kernal: {} }, null, 2));
      assert.equal(memoryEnv(agent.dir, path), "off=", "the fleet's off without a legacy value");
      // This machine's own choice wins over all.
      writeCache(response({ "memory.mode": { value: "off", source: "user" } }));
      setup();
      setLocalOverride("memory.mode", "tool");
      assert.equal(memoryEnv(agent.dir, path), "off=1");
      // Another profile's file is not this one's.
      assert.equal(memoryEnv(agent.dir, path, { KERNAL_PROFILE: "work" }), "off=1", "no effective.work.json: kernal.memory (unset) → auto");
      // Signed out (no accounts.json) the effective file is not read.
      rmSync(join(home, "auth", "accounts.json"));
      assert.equal(memoryEnv(agent.dir, path, { OUTFITTER_API: "x", OUTFITTER_TOKEN: "y" }), "off=1");
    });
  }

  test("laptop memory decides the same way (chosenMode)", () => {
    const v = (value: string, source: string, sourceName?: string) => ({ value, source: source as any, ...(sourceName ? { sourceName } : {}), override: "any" as const, locked: false });
    assert.equal(chosenMode({ memory: "auto" }, v("off", "user")).memory, "off");
    assert.equal(chosenMode({ memory: "auto" }, v("off", "local")).memory, "off");
    assert.equal(chosenMode({ memory: "auto" }, v("off", "fleet")).memory, "auto");
    assert.equal(chosenMode({}, v("off", "fleet")).memory, "off");
    assert.equal(chosenMode({ memory: "tool" }, v("auto", "legacy", "settings.json kernal.memory")).memory, "tool");
    assert.deepEqual(chosenMode({}, undefined), {});
    const pi = makePi();
    const { mode } = registerLaptopMemory(pi, fakeTransport().transport, { settings: { kernal: { memory: "auto" } }, env: {}, centralMode: () => v("off", "profile", "work") });
    assert.equal(mode, "off");
  });
});

// ---------- model and thinking at session start ----------

describe("model and thinking at session start", () => {
  const litellmA = { provider: "litellm", id: "model-a", contextWindow: 128_000, maxTokens: 8000 };
  const litellmB = { provider: "litellm", id: "model-b", contextWindow: 128_000, maxTokens: 8000 };
  const lmstudio = { provider: "lmstudio", id: "qwen", contextWindow: 32_000, maxTokens: 8000 };
  const piWithThinking = () => {
    const pi: any = makePi();
    pi.thinking = "off";
    pi.getThinkingLevel = () => pi.thinking;
    pi.setThinkingLevel = (l: string) => { pi.thinking = l; };
    return pi;
  };

  test("a new session switches once to the account's default model and thinking level", async () => {
    writeCache(response({ "model.default": { value: "model-b", source: "user" }, "model.thinking": { value: "high", source: "profile", sourceName: "work" } }));
    setup();
    const pi = piWithThinking();
    const ctx = makeCtx({ model: litellmA, models: [litellmA, litellmB] });
    const r = await applyModelAtSessionStart(pi, { reason: "startup" }, ctx, { argv: [], perModelThinking: () => undefined });
    assert.deepEqual(pi.setModelCalls.map((m: any) => m.id), ["model-b"]);
    assert.equal(pi.thinking, "high");
    assert.deepEqual(r, { model: "litellm/model-b", thinking: "high" });
  });

  test("never mid-conversation: a session with messages, a resume, a fork or a reload keeps its model", async () => {
    writeCache(response({ "model.default": { value: "model-b", source: "user" } }));
    setup();
    const pi = piWithThinking();
    const busy = makeCtx({ model: litellmA, models: [litellmA, litellmB], entries: [{ type: "message", message: { role: "user", content: "hi" } }] });
    assert.match((await applyModelAtSessionStart(pi, { reason: "startup" }, busy, { argv: [] })).skipped!, /conversation/);
    for (const reason of ["resume", "fork", "reload"]) {
      assert.match((await applyModelAtSessionStart(pi, { reason }, makeCtx({ model: litellmA, models: [litellmA, litellmB] }), { argv: [] })).skipped!, new RegExp(reason));
    }
    assert.equal(pi.setModelCalls.length, 0);
  });

  test("/config reload with a changed default model switches nothing; it says the next session", async () => {
    writeCache(response({ "model.default": { value: "model-a", source: "user" } }));
    setup();
    const pi = piWithThinking();
    configExtension(pi, { fetch: (async () => new Response(JSON.stringify(response({ "model.default": { value: "model-b", source: "user" } })), { status: 200 })) as typeof fetch, onRefresh: () => {} });
    const notes: string[] = [];
    await pi.commands.get("config")!.handler("reload", { ui: { notify: (m: string) => notes.push(m) } });
    assert.equal(pi.setModelCalls.length, 0);
    assert.match(notes[0], /model\.default → model-b \(your account\): applies at the next session/);
    assert.match(notes[0], /a running conversation never switches model/);
  });

  test("the command line wins: --model, --models, --provider, --thinking, --model x:high", async () => {
    assert.deepEqual(cliChoices(["node", "pi", "--model", "litellm/x"]), { model: true, thinking: false });
    assert.deepEqual(cliChoices(["--model=litellm/x:high"]), { model: true, thinking: true });
    assert.deepEqual(cliChoices(["--thinking", "low"]), { model: false, thinking: true });
    assert.deepEqual(cliChoices(["--models", "a,b"]), { model: true, thinking: false });
    assert.deepEqual(cliChoices(["-p", "hi"]), { model: false, thinking: false });
    writeCache(response({ "model.default": { value: "model-b", source: "user" }, "model.thinking": { value: "high", source: "user" } }));
    setup();
    const pi = piWithThinking();
    await applyModelAtSessionStart(pi, { reason: "startup" }, makeCtx({ model: litellmA, models: [litellmA, litellmB] }), { argv: ["--model", "litellm/model-a", "--thinking", "low"] });
    assert.equal(pi.setModelCalls.length, 0);
    assert.equal(pi.thinking, "off");
  });

  test("a legacy or default value is what pi started on already: nothing switches", async () => {
    settings = { defaultProvider: "litellm", defaultModel: "model-b", defaultThinkingLevel: "high" };
    setup();
    const pi = piWithThinking();
    const r = await applyModelAtSessionStart(pi, { reason: "startup" }, makeCtx({ model: litellmA, models: [litellmA, litellmB] }), { argv: [] });
    assert.deepEqual(r, {});
    assert.equal(pi.setModelCalls.length, 0);
    assert.equal(pi.thinking, "off");
  });

  test("this machine's provider alone moves to that backend; a missing model says so; pi's per-model level wins", async () => {
    writeLocal({ "model.provider": "lmstudio" });
    setup();
    const pi = piWithThinking();
    const r = await applyModelAtSessionStart(pi, { reason: "new" }, makeCtx({ model: litellmA, models: [litellmA, lmstudio] }), { argv: [] });
    assert.equal(r.model, "lmstudio/qwen");
    writeLocal({ "model.default": "gone", "model.thinking": "high" });
    setup();
    const pi2 = piWithThinking();
    const r2 = await applyModelAtSessionStart(pi2, { reason: "startup" }, makeCtx({ model: litellmA, models: [litellmA] }), { argv: [], perModelThinking: () => "off" });
    assert.match(r2.problem!, /litellm\/gone is not available here; staying on litellm\/model-a/);
    assert.equal(pi2.setModelCalls.length, 0);
    assert.equal(pi2.thinking, "off", "modelThinkingLevels for this model wins");
  });

  test("model.default may name its backend: provider/id", async () => {
    writeCache(response({ "model.default": { value: "lmstudio/qwen", source: "user" } }));
    setup();
    const pi = piWithThinking();
    assert.equal((await applyModelAtSessionStart(pi, { reason: "startup" }, makeCtx({ model: litellmA, models: [litellmA, lmstudio] }), { argv: [] })).model, "lmstudio/qwen");
  });
});

// ---------- voice ----------

describe("voice into pi-listen's settings", () => {
  test("the account's voice.enabled and voice.language are written; a legacy value is left alone", () => {
    const file = process.env.KERNAL_VOICE_SETTINGS!;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark", voice: { enabled: true, language: "en", backend: "local" } }));
    voice = JSON.parse(readFileSync(file, "utf8"));
    setup();
    assert.deepEqual(applyVoiceSettings(resolve()), [], "nothing central: unchanged");
    writeCache(response({ "voice.enabled": { value: false, source: "user" }, "voice.language": { value: "sl", source: "profile", sourceName: "work" } }));
    setup();
    assert.deepEqual(applyVoiceSettings(resolve()).sort(), ["voice.enabled", "voice.language"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { theme: "dark", voice: { enabled: false, language: "sl", backend: "local" } });
    assert.deepEqual(applyVoiceSettings(resolve()), [], "a second run changes nothing");
  });

  test("KERNAL_VOICE=off leaves pi-listen alone", () => {
    writeCache(response({ "voice.language": { value: "sl", source: "user" } }));
    setup();
    process.env.KERNAL_VOICE = "off";
    try { assert.deepEqual(applyVoiceSettings(resolve()), []); } finally { delete process.env.KERNAL_VOICE; }
    assert.equal(existsSync(process.env.KERNAL_VOICE_SETTINGS!), false);
  });
});

// ---------- compaction ----------

describe("compaction reads the resolution", () => {
  test("this machine or the account beat settings.json and KERNAL_SUMMARY_MODEL; the fleet loses to them", () => {
    const live = { value: "litellm/legacy", source: "KERNAL_SUMMARY_MODEL" };
    writeCache(response({ "compaction.summaryModel": { value: "litellm/acct", source: "user" }, "compaction.masking": { value: false, source: "user" } }));
    setup();
    assert.deepEqual(summarizerFrom(resolve(), live), { value: "litellm/acct", source: "your account" });
    assert.equal(maskingFrom(resolve(), true), false);
    writeCache(response({ "compaction.summaryModel": { value: "litellm/fleet", source: "fleet" }, "compaction.masking": { value: false, source: "fleet" } }));
    setup();
    assert.deepEqual(summarizerFrom(resolve(), live), live);
    assert.equal(maskingFrom(resolve(), true), true);
    assert.equal(maskingFrom(resolve(), undefined), false);
    assert.equal(summarizerFrom(resolve(), undefined).value, "litellm/fleet");
    signedIn = false;
    setup();
    assert.deepEqual(summarizerFrom(resolve(), undefined), { value: "litellm/gpt-5.4-nano", source: "default" });
    assert.equal(maskingFrom(resolve(), undefined), true);
  });

  test("the extension masks per the account, over settings.json", async () => {
    const mod = await import("../.pi/extensions/compaction/index.ts");
    tmpAgentDir({ kernal: { compaction: { masking: true } } });
    writeCache(response({ "compaction.masking": { value: false, source: "user" } }));
    setup();
    const pi = makePi();
    mod.default(pi as any);
    const big = "x".repeat(10_000);
    const tr = (t: string) => ({ role: "toolResult", toolName: "read", toolCallId: "c", content: [{ type: "text", text: t }] });
    const messages = [tr(big), tr(big), tr(big), tr(big), tr(big), tr(big), tr(big), tr(big), tr(big), tr(big)];
    const ctx = makeCtx({ model: { provider: "litellm", id: "m", contextWindow: 32_000, maxTokens: 1000 } });
    assert.equal(await pi.emit("context", { messages }, ctx), undefined, "masking off from the account");
  });
});

// ---------- /connect's save target ----------

describe("/connect: save to my account (profile X) or only this machine", () => {
  const routes = () => {
    const calls: { method: string; path: string; ifMatch?: string; body?: any }[] = [];
    fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method: init?.method ?? "GET", path: u.pathname, ifMatch: h["if-match"], body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, etag?: string) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });
      if (u.pathname === "/api/config") return json(response({}, { profile: "work", profiles: ["work"] }));
      if (u.pathname === "/api/config/profiles/work" && (init?.method ?? "GET") === "GET") return json({ values: {}, version: 5 }, 'W/"5"');
      if (u.pathname === "/api/config/profiles/work") return json({ version: 6 }, 'W/"6"');
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return calls;
  };

  async function start() {
    tmpAgentDir({});
    process.env.KERNAL_NO_DISCOVERY = "1";
    process.env.LITELLM_AGENT_KEY = "sk-test";
    const pi = makePi();
    await connect.default(pi as any);
    const models = [{ provider: "litellm", id: "claude-sonnet-5", contextWindow: 200_000, maxTokens: 8000 }];
    return { pi, ctx: makeCtx({ models }) };
  }
  afterEach(() => { delete process.env.LITELLM_AGENT_KEY; delete process.env.KERNAL_NO_DISCOVERY; });

  test("signed in, \"Only this machine\": config.local.json, and settings.json as before", async () => {
    writeCache(response({}, { profile: "work", profiles: ["work"] }), undefined);
    setup();
    const calls = routes();
    const { pi, ctx } = await start();
    ctx.answers.push("Only this machine");
    await pi.commands.get("connect")!.handler("litellm claude-sonnet-5", ctx);
    assert.deepEqual(JSON.parse(readFileSync(localOverridesPath(), "utf8")).values, { "model.provider": "litellm", "model.default": "claude-sonnet-5" });
    assert.equal(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8")).defaultModel, "claude-sonnet-5");
    assert.ok(!calls.some((c) => c.method === "PUT"));
    assert.match(ctx.notices.at(-1)!.msg, /this machine's default/);
  });

  test("signed in, \"Save to my account (profile work)\": the versioned PUT; this machine's own model.* is cleared", async () => {
    writeCache(response({}, { profile: "work", profiles: ["work"] }));
    writeLocal({ "model.default": "old-local" });
    setup();
    const calls = routes();
    const { pi, ctx } = await start();
    ctx.answers.push("Save to my account (profile work)");
    await pi.commands.get("connect")!.handler("litellm claude-sonnet-5", ctx);
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal(put.path, "/api/config/profiles/work");
    assert.equal(put.ifMatch, 'W/"5"');
    assert.deepEqual(put.body, { values: { "model.provider": "litellm", "model.default": "claude-sonnet-5" } });
    assert.deepEqual(JSON.parse(readFileSync(localOverridesPath(), "utf8")).values, {});
    assert.match(ctx.notices.at(-1)!.msg, /your account \(profile work\)/);
  });

  test("signed out, or without a UI: no question, settings.json only", async () => {
    signedIn = false;
    setup();
    const calls = routes();
    let { pi, ctx } = await start();
    await pi.commands.get("connect")!.handler("litellm claude-sonnet-5", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /saved as default/);
    assert.equal(existsSync(localOverridesPath()), false);
    signedIn = true;
    writeCache(response({ "model.default": { value: "acct-model", source: "user" } }));
    setup();
    ({ pi, ctx } = await start());
    (ctx as any).hasUI = false;
    await pi.commands.get("connect")!.handler("litellm claude-sonnet-5", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /your account sets acct-model, which the next session starts on/);
    assert.equal(calls.length, 0);
  });

  test("connect and the shared modules import nothing the Drive image removes (kernal-admin, kernal-voice, ...)", () => {
    const removed = /from "\.\.\/(kernal-admin|kernal-voice|kernal-update|kernal-codebase-index|kernal-chrome|kernal-html-preview|sentry)\//;
    for (const f of ["connect/index.ts", "kernal-config/index.ts", "compaction/index.ts", "outfitter-agentengine/laptop.ts", "_shared/central-config.ts", "_shared/central-apply.ts"]) {
      assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", ".pi", "extensions", f), "utf8"), removed, f);
    }
  });

  test("whenSaved says when each key applies", () => {
    assert.equal(whenSaved(["compaction.masking", "model.default", "memory.mode"]),
      "compaction.masking applies now; model.default at the next session (/new or a restart; a running conversation keeps its model); memory.mode at the next start.");
  });
});
