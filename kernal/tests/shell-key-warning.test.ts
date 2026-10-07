/**
 * #432: signed in, a router or provider key exported by the shell (an oh-my-zsh dotenv plugin, an
 * old `export`) overrides this device's router key or the account's provider key. Kernal warns once
 * per process and /config and /admin show the source "shell". A value equal to a .env file's is the
 * .env one (bin/kernal exported it; it has its own deprecation warning), and connect's own
 * OPENROUTER_API_KEY write into process.env is never mistaken for the shell. Session and network are
 * fakes; nothing touches ~/.kernal or ~/.pi.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHELL_WATCHED, _resetCentralConfig, _setCentralConfigDeps, describeSource, fromShell, providerKeySource, refreshProviderKeys, resolve, shellOverrides, shellValue, takeShellWarnings,
} from "../.pi/extensions/_shared/central-config.ts";
import configExtension, { renderConfig } from "../.pi/extensions/kernal-config/index.ts";
import { makeCtx, makePi } from "./harness.ts";

const API = "https://link.outfitter.test";
const ACCOUNT = { api: API, email: "a@example.com", userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };
const DEVICE_KEY = "sk-device-abcd1234";
const ACCOUNT_OR = "sk-or-v1-account-9999";

let signedIn: boolean;
let deviceKey: string | undefined;
let accountKeys: Record<string, string>;
let warned: string[];

const fetchFake = (async (url: URL | string) => {
  const path = new URL(String(url)).pathname;
  if (path === "/api/device/provider-keys") return new Response(JSON.stringify({ keys: accountKeys }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function setup(env: NodeJS.ProcessEnv | undefined, dotenv: Record<string, string> = {}) {
  _resetCentralConfig();
  _setCentralConfigDeps({
    session: {
      loginState: () => (signedIn ? { signedIn: true, account: ACCOUNT } : { signedIn: false }),
      getAccessToken: async () => (signedIn ? "kda_test" : undefined),
      getRouterKey: () => (signedIn && deviceKey ? { key: deviceKey, baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x" } : undefined),
      setRouterKey: () => {},
    } as any,
    ...(env ? { env: () => ({ OUTFITTER_API: API, ...env }) } : {}),
    dotenv: () => dotenv,
    settings: () => ({}),
    fetch: fetchFake,
    warn: (line) => warned.push(line),
  });
}

const ROUTER_MSG = "LITELLM_AGENT_KEY from your shell overrides this device's own router key (spend isn't attributed to you). Unset it, or open a new terminal.";
const OR_MSG = "OPENROUTER_API_KEY from your shell overrides your account's OpenRouter key. Unset it, or open a new terminal.";

const saved: Record<string, string | undefined> = {};
const TOUCHED = ["OPENROUTER_API_KEY", "LITELLM_AGENT_KEY", "LITELLM_API_KEY", "KERNAL_SHELL_KEYS", "OUTFITTER_API"];

beforeEach(() => {
  for (const k of TOUCHED) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.KERNAL_HOME_DIR = mkdtempSync(join(tmpdir(), "kernal-shell-key-"));
  process.env.KERNAL_VOICE_SETTINGS = join(process.env.KERNAL_HOME_DIR, "pi-listen.json");
  signedIn = true;
  deviceKey = DEVICE_KEY;
  accountKeys = { openrouter: ACCOUNT_OR };
  warned = [];
});

afterEach(() => {
  for (const k of TOUCHED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _resetCentralConfig();
});

describe("fromShell", () => {
  test("set and unlike .env: the shell; equal to .env, unset or empty: not", () => {
    assert.equal(fromShell("LITELLM_AGENT_KEY", { LITELLM_AGENT_KEY: "sk-old" }, {}), true);
    assert.equal(fromShell("LITELLM_AGENT_KEY", { LITELLM_AGENT_KEY: "sk-old" }, { LITELLM_AGENT_KEY: "sk-old" }), false);
    assert.equal(fromShell("LITELLM_AGENT_KEY", {}, {}), false);
    assert.equal(fromShell("LITELLM_AGENT_KEY", { LITELLM_AGENT_KEY: "" }, {}), false);
  });

  test("bin/kernal's marker: a name it doesn't list came from a .env file it sourced", () => {
    assert.equal(fromShell("OPENROUTER_API_KEY", { OPENROUTER_API_KEY: "sk-x", KERNAL_SHELL_KEYS: "" }, {}), false);
    assert.equal(fromShell("OPENROUTER_API_KEY", { OPENROUTER_API_KEY: "sk-x", KERNAL_SHELL_KEYS: "LITELLM_AGENT_KEY OPENROUTER_API_KEY" }, {}), true);
    // Listed, but bin/kernal's .env export replaced it with the file's value: the .env one.
    assert.equal(fromShell("OPENROUTER_API_KEY", { OPENROUTER_API_KEY: "sk-x", KERNAL_SHELL_KEYS: "OPENROUTER_API_KEY" }, { OPENROUTER_API_KEY: "sk-x" }), false);
  });

  test("bin/kernal's marker lists exactly the watched names", () => {
    const script = readFileSync(join(import.meta.dirname, "..", "bin", "kernal"), "utf8");
    const loop = script.match(/^for _k in (.+); do$/m);
    assert.ok(loop, "bin/kernal records KERNAL_SHELL_KEYS");
    assert.deepEqual(loop[1].split(" ").sort(), [...SHELL_WATCHED].sort());
    assert.match(script, /^export KERNAL_SHELL_KEYS$/m);
    assert.ok(script.indexOf("export KERNAL_SHELL_KEYS") < script.indexOf('set -a; source "$ROOT/../.env"'), "before the .env files are exported");
  });
});

describe("the warning", () => {
  test("signed in, a shell router key: warned once, and /config shows the source shell", () => {
    setup({ LITELLM_AGENT_KEY: "sk-shared-old1" });
    assert.deepEqual(takeShellWarnings(), [ROUTER_MSG]);
    assert.deepEqual(takeShellWarnings(), [], "once per process");
    const v = resolve().values["router.key"]!;
    assert.equal(v.source, "env");
    assert.equal(describeSource(v), "shell (LITELLM_AGENT_KEY)");
    assert.match(renderConfig(resolve()), /router\.key = …old1 {2}\(shell \(LITELLM_AGENT_KEY\)\)/);
  });

  test("LITELLM_API_KEY from the shell is named as such", () => {
    setup({ LITELLM_API_KEY: "sk-shared-old2" });
    assert.deepEqual(shellOverrides().map((o) => o.name), ["LITELLM_API_KEY"]);
  });

  test("the same value as .env: no shell warning, only the legacy .env one", () => {
    setup({ LITELLM_AGENT_KEY: "sk-in-dotenv" }, { LITELLM_AGENT_KEY: "sk-in-dotenv" });
    assert.deepEqual(takeShellWarnings(), []);
    resolve();
    assert.deepEqual(warned, ["LITELLM_AGENT_KEY in .env is deprecated: /admin can save it to your account or this machine"]);
    assert.equal(resolve().values["router.key"]!.source, "dotenv");
  });

  test("signed out: nothing", async () => {
    signedIn = false;
    setup({ LITELLM_AGENT_KEY: "sk-shared-old1", OPENROUTER_API_KEY: "sk-or-shell" });
    await refreshProviderKeys();
    assert.deepEqual(shellOverrides(), []);
    assert.deepEqual(takeShellWarnings(), []);
  });

  test("no device key, no account key: nothing to override, nothing said", async () => {
    deviceKey = undefined;
    accountKeys = {};
    setup({ LITELLM_AGENT_KEY: "sk-shared-old1", OPENROUTER_API_KEY: "sk-or-shell" });
    await refreshProviderKeys();
    assert.deepEqual(takeShellWarnings(), []);
  });

  test("the shell holding the account's own key overrides nothing", async () => {
    setup({ OPENROUTER_API_KEY: ACCOUNT_OR, LITELLM_AGENT_KEY: DEVICE_KEY });
    await refreshProviderKeys();
    assert.deepEqual(takeShellWarnings(), []);
  });

  test("a shell provider key over the account's: warned once the account's keys arrive; /config shows shell", async () => {
    deviceKey = undefined;
    setup({ OPENROUTER_API_KEY: "sk-or-v1-shell-0001" });
    assert.deepEqual(takeShellWarnings(), [], "the account's keys are not known yet");
    await refreshProviderKeys();
    assert.deepEqual(takeShellWarnings(), [OR_MSG]);
    assert.deepEqual(providerKeySource("openrouter"), { value: "sk-or-v1-shell-0001", source: "shell (OPENROUTER_API_KEY)" });
    assert.match(renderConfig(resolve()), /Provider keys:\n {2}OPENROUTER_API_KEY = …0001 {2}\(shell \(OPENROUTER_API_KEY\)\)/);
  });

  test("connect's own OPENROUTER_API_KEY write into process.env is not the shell", async () => {
    deviceKey = undefined;
    setup(undefined);   // the real process.env, snapshotted now (as at extension load)
    await refreshProviderKeys();
    process.env.OPENROUTER_API_KEY = "sk-or-v1-cleaned-by-connect";   // connect's registerAll
    assert.equal(shellValue("OPENROUTER_API_KEY"), undefined);
    assert.deepEqual(takeShellWarnings(), []);
    assert.deepEqual(providerKeySource("openrouter"), { value: ACCOUNT_OR, source: "your account" });
  });

  test("a key the real process environment started with is the shell's", async () => {
    deviceKey = undefined;
    process.env.OPENROUTER_API_KEY = "sk-or-v1-from-shell";
    setup(undefined);
    await refreshProviderKeys();
    assert.deepEqual(takeShellWarnings(), [OR_MSG]);
  });
});

describe("kernal-config delivers it", () => {
  test("UI: a warning notice at session_start; the provider key's after the refresh brings it", async () => {
    setup({ LITELLM_AGENT_KEY: "sk-shared-old1", OPENROUTER_API_KEY: "sk-or-v1-shell-0001" });
    const pi = makePi();
    let refresh: Promise<void> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Hold the refresh until session_start has run, as at a real start (network after start-up).
    _setCentralConfigDeps({ fetch: (async (url: URL | string, init?: RequestInit) => { await gate; return fetchFake(url, init); }) as typeof fetch });
    configExtension(pi as any, { onRefresh: (p) => { refresh = p; } });
    const ctx = makeCtx();
    await pi.emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(ctx.notices.filter((n) => n.type === "warning").map((n) => n.msg), [ROUTER_MSG]);
    release();
    await refresh;
    assert.deepEqual(ctx.notices.filter((n) => n.type === "warning").map((n) => n.msg), [ROUTER_MSG, OR_MSG]);
    await pi.emit("session_start", { reason: "new" }, ctx);
    assert.equal(ctx.notices.filter((n) => n.type === "warning").length, 2, "once per process");
  });

  test("no UI: one stderr line", async () => {
    setup({ LITELLM_AGENT_KEY: "sk-shared-old1" });
    const pi = makePi();
    const lines: string[] = [];
    let refresh: Promise<void> | undefined;
    configExtension(pi as any, { stderr: (l) => lines.push(l), onRefresh: (p) => { refresh = p; } });
    await pi.emit("session_start", { reason: "startup" }, makeCtx({ hasUI: false }));
    await refresh;
    assert.deepEqual(lines, [ROUTER_MSG]);
  });
});
