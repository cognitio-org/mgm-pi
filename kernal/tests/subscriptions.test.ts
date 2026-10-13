/**
 * Personal subscription workers (subscriptions.md §2 and §5): settings are covered in
 * central-config.test.ts. Here, the status command, the Claude setup-token upload, and the
 * one-shot runner. No network and no real `claude`: fetch and the spawner are fakes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../.pi/extensions/_shared/outfitter-session.ts";
import { binaryOnPath, localVendorLogin, usableClaudeCredentials } from "../.pi/extensions/kernal-subscriptions/local-login.ts";
import {
  extractSetupToken, formatStatus, main, redactSetupOutput, type SubscriptionIo,
} from "../.pi/extensions/kernal-subscriptions/commands.ts";
import {
  claudeArgs, claudeChildEnv, claudeMcpServers, looksLikePlanLimit, runClaudeWorker, runSubscriptionWorker, subscriptionPlan,
  type ClaudeSpawn, type ClaudeSpawnResult,
} from "../.pi/extensions/kernal-subscriptions/runner.ts";

const API = "https://link.outfitter.test";
const TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345";
const ACCOUNT_SECRET = "account-secret-value-0123456789abcdef";

type Call = { method: string; path: string; auth?: string; body?: unknown };

function outfitter(handle: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method: init.method ?? "GET", path, auth: headers.authorization, body };
    calls.push(call);
    if (path === "/api/device/code") {
      return new Response(JSON.stringify({
        device_code: "kdc_abc", user_code: "BCDF-GHJK", verification_uri: "https://app.outfitter.test/device",
        verification_uri_complete: "https://app.outfitter.test/device?code=BCDF-GHJK", expires_in: 600, interval: 0,
      }), { status: 200 });
    }
    if (path === "/api/device/token") {
      return new Response(JSON.stringify({
        token_type: "Bearer", access_token: "kda_1", expires_in: 3600, refresh_token: "kdr_1", refresh_expires_in: 2592000,
        device: { id: "dev_aaaaaaaaaaaaaaaa", name: "ci-box" }, account: { email: "a@example.com", userId: "u_123" },
        delivery: {}, problems: [],
      }), { status: 200 });
    }
    const answer = handle(call);
    // 204 has no body. Node's Response constructor rejects a 204 that carries one.
    if (answer.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function signedIn(handle: (call: Call) => { status: number; body?: unknown }) {
  const home = mkdtempSync(join(tmpdir(), "kernal-sub-"));
  const env = { HOME: home, OUTFITTER_API: API, KERNAL_AUTH_DIR: join(home, "auth"), KERNAL_AUTH_BACKEND: "file", PATH: "" };
  const server = outfitter(handle);
  await login({ api: API, env, fetch: server.fn, openBrowser: false, sleep: async () => {}, print: () => {} });
  server.calls.length = 0;
  return { env, server, home };
}

function io(extra: Partial<SubscriptionIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "kernal-sub-io-"));
  const env = { HOME: home, OUTFITTER_API: API, KERNAL_AUTH_DIR: join(home, "auth"), KERNAL_AUTH_BACKEND: "file", PATH: "", ...extra.env };
  const cli: SubscriptionIo = {
    out: (l) => out.push(l), err: (l) => err.push(l), env, home,
    which: () => false,
    localLogin: () => false,
    mode: () => "off",
    ...extra,
    env: extra.env ? { ...env, ...extra.env } : env,
  };
  return { out, err, cli, env: cli.env!, home };
}

const MCP = {
  litellm: { url: "https://router.kernal.one/mcp/", headers: { authorization: "Bearer router-key" } },
  google_admin: { url: "https://admin.example/mcp", auth: "oauth" },
  augment_admin: { url: "https://aug.example/mcp", auth: "oauth" },
  docs: { url: "https://docs.example/mcp" },
  local: { command: "node", args: ["srv.js"] },
  neither: { type: "sse" },
  blank: { url: "  ", command: "" },
};

function captureSpawn() {
  const calls: ClaudeSpawn[] = [];
  const spawn = async (req: ClaudeSpawn): Promise<ClaudeSpawnResult> => {
    calls.push(req);
    return { code: 0, stdout: "done\n", stderr: "" };
  };
  return { calls, spawn };
}

describe("status lines and local checks", () => {
  test("a line names the mode, the binary, the logins, and which API-key variables are set", () => {
    const line = formatStatus({ vendor: "claude", mode: "sandboxed", binary: true, localLogin: false, accountSecret: "yes", apiKeyVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] });
    assert.equal(line, "claude  mode=sandboxed  binary=yes  local-login=no  account-secret=yes  api-key=set:ANTHROPIC_API_KEY+ANTHROPIC_AUTH_TOKEN");
    assert.equal(formatStatus({ vendor: "gemini", mode: "off", binary: false, localLogin: false, accountSecret: "signed-out", apiKeyVars: [] }), "gemini  mode=off  binary=no  local-login=no  account-secret=signed-out  api-key=unset");
    assert.doesNotMatch(line, /sk-|Bearer/);
  });

  test("a stored credential only counts as a login when it can actually authenticate", () => {
    const at = (oauth: unknown) => JSON.stringify({ claudeAiOauth: oauth });
    // The false positive this guards against: the keychain item exists but holds nothing, so the
    // worker would spawn and fail with "OAuth session expired" instead of asking to connect.
    assert.equal(usableClaudeCredentials(at({ accessToken: "", refreshToken: "", expiresAt: 0 })), false, "empty item");
    assert.equal(usableClaudeCredentials(at({})), false, "no oauth block");
    assert.equal(usableClaudeCredentials(at(null)), false);
    assert.equal(usableClaudeCredentials("not json"), false);
    assert.equal(usableClaudeCredentials(at({ accessToken: "tok" })), true, "no expiry info is usable");
    assert.equal(usableClaudeCredentials(at({ accessToken: "tok", expiresAt: Date.now() + 3_600_000 })), true);
    assert.equal(usableClaudeCredentials(at({ accessToken: "tok", expiresAt: Date.now() - 1000, refreshToken: "ref" })), true, "expired but refreshable");
    assert.equal(usableClaudeCredentials(at({ accessToken: "tok", expiresAt: Date.now() - 1000 })), false, "expired with nothing to refresh it");
  });

  test("binaryOnPath checks PATH entries and not a path-shaped name", () => {
    const root = mkdtempSync(join(tmpdir(), "kernal-path-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "agy_acp_server"), "");
    const exists = (p: string) => p === join(bin, "agy_acp_server");
    assert.equal(binaryOnPath("agy_acp_server", { PATH: `${bin}:/missing` }, exists), true);
    assert.equal(binaryOnPath("claude", { PATH: bin }, exists), false);
    assert.equal(binaryOnPath("bin/claude", { PATH: bin }, exists), false);
  });

  test("local login is a file or a keychain item, and the check does not return the secret", () => {
    const home = mkdtempSync(join(tmpdir(), "kernal-login-file-"));
    const env = { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "" };
    assert.equal(localVendorLogin("claude", { env, home, keychain: () => false }), false);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: ACCOUNT_SECRET } }));
    assert.equal(localVendorLogin("claude", { env, home, keychain: () => false }), true);
    assert.equal(localVendorLogin("claude", { env: { CLAUDE_CODE_OAUTH_TOKEN: ACCOUNT_SECRET }, home: join(home, "empty"), keychain: () => false }), true);
    assert.equal(localVendorLogin("claude", { env, home: join(home, "empty"), keychain: () => true }), true);
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), "");
    assert.equal(localVendorLogin("grok", { env, home }), false);
    writeFileSync(join(home, ".grok", "auth.json"), "{\"x\":1}\n");
    assert.equal(localVendorLogin("grok", { env, home }), true);
    const codex = join(home, "codex-home");
    mkdirSync(codex);
    writeFileSync(join(codex, "auth.json"), "{}\n");
    assert.equal(localVendorLogin("codex", { env: { ...env, CODEX_HOME: codex }, home }), true);
    mkdirSync(join(home, ".gemini", "antigravity-acp"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-acp", "settings.json"), "{}\n");
    assert.equal(localVendorLogin("gemini", { env, home }), true);
  });

  test("setup-token: the token line is taken, a URL is not, and relay text hides the token", () => {
    const url = "https://claude.ai/oauth/authorize?code=short";
    assert.equal(extractSetupToken(`${url}\n${TOKEN}\n`), TOKEN);
    assert.equal(extractSetupToken("no token here\n"), undefined);
    assert.equal(extractSetupToken("Token: " + TOKEN), undefined, "a label on the same line is not the whole token");
    const shown = redactSetupOutput(`${url} ${TOKEN}`);
    assert.match(shown, /https:\/\/claude\.ai/);
    assert.doesNotMatch(shown, /sk-ant/);
  });
});

describe("kernal subscriptions", () => {
  test("signed out: every vendor, no request, and connect does not run claude", async () => {
    const a = io({ mode: (vendor) => (vendor === "grok" ? "full" : "off"), env: { ANTHROPIC_API_KEY: "sk-ant-api-should-stay-out", XAI_API_KEY: "" } });
    let spawned = false;
    a.cli.spawnSetup = async () => { spawned = true; return { code: 0, stdout: TOKEN, stderr: "" }; };
    a.cli.fetch = (async () => { throw new Error("no network"); }) as typeof fetch;
    assert.equal(await main(["subscriptions"], a.cli), 0);
    assert.equal(a.out.length, 4);
    assert.match(a.out[0], /^claude {2}mode=off {2}binary=no {2}local-login=no {2}account-secret=signed-out {2}api-key=set:ANTHROPIC_API_KEY$/);
    assert.match(a.out[1], /^grok {2}mode=full /);
    assert.match(a.out[3], /binary=no/);
    assert.doesNotMatch(a.out.join("\n") + a.err.join("\n"), /sk-ant-api-should-stay-out/);
    assert.equal(await main(["subscriptions", "connect", "claude"], a.cli), 1);
    assert.equal(spawned, false);
    assert.match(a.err.join("\n"), /kernal login/);
    assert.equal(await main(["subscriptions", "connect", "grok"], a.cli), 2);
    assert.equal(await main(["subscriptions", "disconnect"], a.cli), 2);
    assert.match(a.err.at(-1)!, /^Usage: kernal subscriptions/);
  });

  test("connect uploads the token and never prints it; a refusal does not echo the body", async () => {
    const { env, server } = await signedIn((call) => {
      if (call.method === "PUT" && call.path === "/api/me/subscription-secrets/claude") {
        return { status: 200, body: { vendor: "claude", last4: "wxyz", setAt: "t", value: TOKEN } };
      }
      return { status: 404, body: { error: "nope" } };
    });
    const out: string[] = [];
    const err: string[] = [];
    const cli: SubscriptionIo = {
      out: (l) => out.push(l), err: (l) => err.push(l), env, fetch: server.fn,
      spawnSetup: async () => ({ code: 0, stdout: `open https://claude.ai/login\n${TOKEN}\n`, stderr: "" }),
    };
    assert.equal(await main(["subscriptions", "connect", "claude"], cli), 0);
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].method, "PUT");
    assert.equal(server.calls[0].auth, "Bearer kda_1");
    assert.deepEqual(server.calls[0].body, { value: TOKEN });
    assert.doesNotMatch([...out, ...err].join("\n"), new RegExp(TOKEN));
    assert.match(err.join("\n"), /Saved the Claude subscription token/);

    server.calls.length = 0;
    const refused = outfitter(() => ({ status: 400, body: { error: "invalid_value", value: TOKEN } }));
    const err2: string[] = [];
    assert.equal(await main(["subscriptions", "connect", "claude"], {
      out: () => {}, err: (l) => err2.push(l), env, fetch: refused.fn,
      spawnSetup: async () => ({ code: 0, stdout: TOKEN, stderr: "" }),
    }), 1);
    assert.match(err2.join("\n"), /400: invalid_value/);
    assert.doesNotMatch(err2.join("\n"), new RegExp(TOKEN));
  });

  test("a failed setup-token is not uploaded, and its stdout is not printed", async () => {
    const { env, server } = await signedIn(() => ({ status: 500, body: { error: "nope", value: TOKEN } }));
    const err: string[] = [];
    assert.equal(await main(["subscriptions", "connect", "claude"], {
      out: () => {}, err: (l) => err.push(l), env, fetch: server.fn,
      spawnSetup: async () => ({ code: 1, stdout: TOKEN, stderr: "boom " + TOKEN }),
    }), 1);
    assert.equal(server.calls.length, 0);
    assert.doesNotMatch(err.join("\n"), new RegExp(TOKEN));
    assert.match(err.join("\n"), /exited 1/);
  });

  test("status reads the account list, and disconnect deletes one vendor", async () => {
    const { env, server } = await signedIn((call) => {
      if (call.method === "GET") return { status: 200, body: [{ vendor: "claude", last4: "abcd", setAt: "t", value: "super-secret-value" }, { vendor: "nope" }] };
      if (call.method === "DELETE" && call.path === "/api/me/subscription-secrets/grok") return { status: 204 };
      return { status: 404, body: { error: "missing" } };
    });
    const out: string[] = [];
    const err: string[] = [];
    const cli: SubscriptionIo = {
      out: (l) => out.push(l), err: (l) => err.push(l), env, fetch: server.fn,
      which: (bin) => bin === "claude",
      localLogin: (vendor) => vendor === "codex",
      mode: (vendor) => (vendor === "claude" ? "sandboxed" : "off"),
    };
    assert.equal(await main(["subscriptions"], cli), 0);
    assert.match(out[0], /^claude {2}mode=sandboxed {2}binary=yes {2}local-login=no {2}account-secret=yes /);
    assert.match(out[1], /account-secret=no/);
    assert.match(out[2], /local-login=yes/);
    assert.doesNotMatch(out.join("\n"), /super-secret-value|abcd/);
    assert.equal(await main(["subscriptions", "disconnect", "grok"], cli), 0);
    assert.equal(server.calls.at(-1)?.method, "DELETE");
    assert.equal(server.calls.at(-1)?.path, "/api/me/subscription-secrets/grok");
    assert.match(err.join("\n"), /Removed the grok subscription secret/);
    assert.equal(await main(["subscriptions", "disconnect", "cursor"], cli), 2);
  });
});

describe("Claude runner", () => {
  const parent = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-api-should-not-pass",
    ANTHROPIC_AUTH_TOKEN: "auth-token-should-not-pass",
    CLAUDE_CODE_OAUTH_TOKEN: "old-local-token",
  };

  test("sandboxed: one claude -p, plan mode, no shell, empty strict MCP, API keys dropped, secret only on the child", async () => {
    const cap = captureSpawn();
    let json = "";
    const result = await runClaudeWorker(
      { prompt: "read the file", cwd: "/work", memoryBrief: "memory brief", mcpServers: MCP },
      {
        spawn: cap.spawn, env: parent, mode: () => "sandboxed", localLogin: () => false,
        secret: { ok: true, value: ACCOUNT_SECRET }, readSettingsFile: () => undefined,
        writeMcpConfig: (text) => { json = text; return "/tmp/mcp.json"; },
      },
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") assert.equal(result.text, "done");
    assert.equal(cap.calls.length, 1);
    const req = cap.calls[0];
    assert.equal(req.command, "claude");
    assert.equal(req.cwd, "/work");
    assert.deepEqual(req.args, claudeArgs("sandboxed", "read the file", "/tmp/mcp.json"));
    assert.equal(req.args.at(-2), "-p");
    assert.equal(req.args.at(-1), "read the file", "a memory brief is not prepended when sandboxed");
    assert.equal(req.args.includes("--no-session-persistence") && req.args.indexOf("--no-session-persistence") < req.args.indexOf("-p"), true);
    assert.equal(req.args.includes("--resume"), false);
    assert.equal(req.args.includes("--dangerously-skip-permissions"), false);
    assert.equal(req.args.includes("--permission-mode") && req.args.includes("plan"), true);
    assert.ok(req.args.includes("--disallowedTools") && req.args.includes("Bash"));
    assert.ok(req.args.includes("--setting-sources") && req.args[req.args.indexOf("--setting-sources") + 1] === "user");
    assert.equal(json, "{\"mcpServers\":{}}");
    assert.equal(req.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(req.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(req.env.CLAUDE_CODE_OAUTH_TOKEN, ACCOUNT_SECRET);
    assert.equal(parent.ANTHROPIC_API_KEY, "sk-ant-api-should-not-pass");
    assert.equal(JSON.stringify(req.args).includes(ACCOUNT_SECRET), false);
    assert.equal(result.text.includes(ACCOUNT_SECRET), false);
  });

  test("full: user,project settings, filtered MCP, memory brief prepended, no skip-permissions", async () => {
    const cap = captureSpawn();
    let json = "";
    await runClaudeWorker(
      { prompt: "edit it", memoryBrief: "brief", mcpServers: MCP },
      {
        spawn: cap.spawn, env: parent, mode: () => "full",
        secret: { ok: true, value: ACCOUNT_SECRET }, readSettingsFile: () => undefined,
        writeMcpConfig: (text) => { json = text; return "/tmp/mcp.json"; },
      },
    );
    const args = cap.calls[0].args;
    assert.equal(args[args.indexOf("--setting-sources") + 1], "user,project");
    assert.equal(args.includes("--permission-mode"), false);
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.equal(args.at(-1), "brief\n\nedit it");
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { url?: string; command?: string }> };
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["docs", "local"]);
    assert.equal(parsed.mcpServers.docs.url, "https://docs.example/mcp");
    assert.equal(parsed.mcpServers.local.command, "node");
    assert.equal(JSON.stringify(parsed).includes("router-key"), false);
    assert.deepEqual(claudeMcpServers(MCP), parsed.mcpServers);
  });

  test("no secret and no local login does not spawn; off does not spawn; a lookup failure does not spawn", async () => {
    const cap = captureSpawn();
    const deps = { spawn: cap.spawn, env: parent, writeMcpConfig: () => "/tmp/mcp.json", readSettingsFile: () => undefined };
    const connect = await runClaudeWorker({ prompt: "x" }, { ...deps, mode: () => "full", localLogin: () => false, secret: { ok: true } });
    assert.equal(connect.kind, "connect");
    assert.match(connect.text, /connect Claude/);
    const off = await runClaudeWorker({ prompt: "x" }, { ...deps, mode: () => "off", secret: { ok: true, value: ACCOUNT_SECRET } });
    assert.equal(off.kind, "off");
    const down = await runClaudeWorker({ prompt: "x" }, { ...deps, mode: () => "sandboxed", secret: { ok: false, error: "could not read the account secret" } });
    assert.equal(down.kind, "error");
    assert.equal(cap.calls.length, 0);
    const local = await runClaudeWorker({ prompt: "x" }, { ...deps, mode: () => "sandboxed", localLogin: () => true, secret: { ok: true }, env: { PATH: "/usr/bin" } });
    assert.equal(local.kind, "ok");
    assert.equal(cap.calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(cap.calls[0].env.ANTHROPIC_API_KEY, undefined);
  });

  test("a plan-limit exit is exhausted and is not retried; other failures stay errors; stdout secrets are redacted", async () => {
    const calls: ClaudeSpawn[] = [];
    const script = async (result: ClaudeSpawnResult) => {
      const out = await runClaudeWorker({ prompt: "x" }, {
        env: parent, mode: () => "full", secret: { ok: true, value: ACCOUNT_SECRET }, writeMcpConfig: () => "/tmp/mcp.json", readSettingsFile: () => undefined,
        spawn: async (req) => { calls.push(req); return result; },
      });
      return out;
    };
    const spent = await script({ code: 1, stdout: "", stderr: "You've hit your usage limit. Your limit will reset at 17:00." });
    assert.equal(spent.kind, "exhausted");
    assert.match(spent.text, /plan window is spent/);
    assert.doesNotMatch(spent.text, /API key|ANTHROPIC/);
    const ok = await script({ code: 0, stdout: `mentions rate limit in the answer ${ACCOUNT_SECRET}`, stderr: "" });
    assert.equal(ok.kind, "ok");
    assert.equal(ok.text.includes(ACCOUNT_SECRET), false);
    assert.match(ok.text, /\[redacted\]/);
    const bad = await script({ code: 2, stdout: "", stderr: `no such file ${ACCOUNT_SECRET}` });
    assert.equal(bad.kind, "error");
    assert.match(bad.text, /exited 2/);
    assert.equal(bad.text.includes(ACCOUNT_SECRET), false);
    assert.equal(calls.length, 3, "each call is one spawn; exhausted is not retried");
    assert.equal(looksLikePlanLimit("the patch adds a quota check"), false);
  });

  test("only Claude has a runner; the prefer walk skips off and marks a signed-out vendor connect", async () => {
    let spawned = false;
    const grok = await runSubscriptionWorker("grok", { prompt: "x" }, { spawn: async () => { spawned = true; return { code: 0, stdout: "", stderr: "" }; }, mode: () => "full" });
    assert.equal(grok.kind, "unsupported");
    assert.equal(spawned, false);
    assert.deepEqual(subscriptionPlan("claude,grok,codex,gemini", {
      claude: "full", grok: "off", codex: "sandboxed", gemini: "full",
    }, new Set(["claude", "gemini"])), [
      { vendor: "claude", action: "run" },
      { vendor: "codex", action: "connect" },
      { vendor: "gemini", action: "run" },
    ]);
    assert.deepEqual(subscriptionPlan("claude,claude", {}, new Set()), []);
    assert.deepEqual(Object.keys(await import("../.pi/extensions/kernal-subscriptions/runner.ts").then((m) => m.SUBSCRIPTION_RUNNERS)), ["claude"]);
  });

  test("child env helper drops both Anthropic API variables and does not copy the secret elsewhere", () => {
    const env = claudeChildEnv(parent, ACCOUNT_SECRET);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, ACCOUNT_SECRET);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(parent.CLAUDE_CODE_OAUTH_TOKEN, "old-local-token");
  });
});

describe("the command is dispatched before pi", () => {
  test("bin/kernal execs the subscriptions CLI, which prints status without a network", async () => {
    const bin = readFileSync(new URL("../bin/kernal", import.meta.url), "utf8");
    assert.match(bin, /subscriptions\)[\s\S]*?exec node "\$ROOT\/\.pi\/extensions\/kernal-subscriptions\/cli\.ts" "\$@"/);
    const home = mkdtempSync(join(tmpdir(), "kernal-sub-cli-"));
    const child = spawn(process.execPath, [new URL("../.pi/extensions/kernal-subscriptions/cli.ts", import.meta.url).pathname, "subscriptions"], {
      env: { HOME: home, PATH: "", OUTFITTER_API: API, KERNAL_AUTH_DIR: join(home, "auth"), KERNAL_AUTH_BACKEND: "file", KERNAL_TEST_NO_KEYCHAIN: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^claude {2}mode=off {2}binary=no {2}local-login=no {2}account-secret=signed-out {2}api-key=unset/m);
    assert.match(stdout, /^gemini {2}mode=off {2}binary=no /m);
    assert.equal(stderr, "");
  });
});

describe("the coordinator uses the Claude runner", () => {
  test("a hidden builtin launch is blocked; inspection and other agents are not", async () => {
    const { blockHiddenSubagent, subscriptionSystemNote, withSubscriptionNote, mcpServersFrom, followAfter, subscriptionToolText, executeSubscriptionWorker } = await import("../.pi/extensions/kernal-subscriptions/dispatch.ts");
    const hidden = ["claude-code", "claude-code-writer", "codex-exec", "codex-exec-writer"];
    const claude = blockHiddenSubagent({ agent: "claude-code", task: "edit it" }, hidden);
    assert.equal(claude?.block, true);
    assert.match(claude?.reason ?? "", /subscription_worker/);
    assert.doesNotMatch(claude?.reason ?? "", /ANTHROPIC_API_KEY/);
    const codex = blockHiddenSubagent({ agent: "codex-exec-writer", task: "edit it" }, ["codex-exec-writer"]);
    assert.match(codex?.reason ?? "", /no Codex runner/);
    assert.equal(blockHiddenSubagent({ agent: "scout", task: "look" }, hidden), undefined);
    assert.equal(blockHiddenSubagent({ action: "get", agent: "claude-code" }, hidden), undefined);
    assert.equal(blockHiddenSubagent({ action: "list" }, hidden), undefined);
    assert.equal(blockHiddenSubagent({ agent: "claude-code" }, []), undefined);
    const script = blockHiddenSubagent({ workflowScript: 'return runs.run("k", { agent: "claude-code-writer", task: "x" })' }, hidden);
    assert.equal(script?.block, true);
    assert.match(script?.reason ?? "", /claude-code-writer/);
    assert.match(script?.reason ?? "", /subscription_worker/);
    assert.equal(subscriptionSystemNote({ claude: "off", codex: "off" }), undefined);
    const note = subscriptionSystemNote({ claude: "full", codex: "sandboxed" });
    assert.match(note ?? "", /subscription_worker/);
    assert.match(note ?? "", /codex-exec/);
    assert.equal(withSubscriptionNote("already", note), `already\n\n${note}`);
    assert.deepEqual(mcpServersFrom(['{"mcpServers":{"docs":{"url":"https://docs.example/mcp"}}}', "not json", '{"mcpServers":{"local":{"command":"node"}}}']), {
      docs: { url: "https://docs.example/mcp" },
      local: { command: "node" },
    });
    assert.deepEqual(followAfter("claude", "claude,grok,codex", { claude: "full", grok: "full", codex: "off" }, new Set(["claude"])), [
      { vendor: "grok", action: "connect" },
    ]);
    const spent = subscriptionToolText(
      { kind: "exhausted", vendor: "claude", text: "Claude's plan window is spent." },
      [{ vendor: "grok", action: "connect" }],
    );
    assert.equal(spent.isError, true);
    assert.match(spent.text, /plan window is spent/);
    assert.match(spent.text, /Do not retry with an API key/);
    assert.match(spent.text, /grok is next/);
    assert.match(spent.text, /router subagent/);
    // A settings refusal must not read like stray output: it says what happened and where to go.
    const refused = subscriptionToolText({ kind: "refused", vendor: "claude", text: "user settings set env.ANTHROPIC_API_KEY" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Claude refused to start/);
    assert.match(refused.text, /user settings set env\.ANTHROPIC_API_KEY/);
    assert.match(refused.text, /router subagent/);
    assert.notEqual(refused.text.trim(), "user settings set env.ANTHROPIC_API_KEY");
    const calls: string[] = [];
    const ran = await executeSubscriptionWorker({ prompt: "  edit it  ", memoryBrief: "brief" }, {
      cwd: "/work",
      mcpServers: { docs: { url: "https://docs.example/mcp" } },
      run: async (vendor, input) => {
        calls.push(`${vendor}:${input.prompt}:${input.cwd}:${input.memoryBrief}`);
        return { kind: "ok", vendor, text: "done" };
      },
    });
    assert.deepEqual(calls, ["claude:edit it:/work:brief"]);
    assert.equal(ran.isError, false);
    assert.equal(ran.text, "done");
    const other = await executeSubscriptionWorker({ prompt: "x", vendor: "grok" }, {
      run: async (vendor) => {
        calls.push(vendor);
        return { kind: "unsupported", vendor, text: "grok has no runner in this slice" };
      },
    });
    assert.equal(other.isError, true);
    assert.match(other.text, /no runner/);
    assert.equal((await executeSubscriptionWorker({ prompt: "  " }, { run: async () => { throw new Error("no"); } })).text, "subscription_worker needs a prompt.");
  });

  test("a workflow or schedule that can name a hidden builtin is blocked", async () => {
    const { blockHiddenSubagent } = await import("../.pi/extensions/kernal-subscriptions/dispatch.ts");
    const hidden = ["claude-code", "claude-code-writer", "codex-exec", "codex-exec-writer"];
    const scheduled = blockHiddenSubagent({
      action: "schedule.create",
      workflowScript: 'return runs.run("k", { agent: "claude-code", task: "x" })',
    }, hidden);
    assert.equal(scheduled?.block, true);
    assert.match(scheduled?.reason ?? "", /subscription_worker/);
    assert.equal(blockHiddenSubagent({
      action: "schedule.create",
      workflowScript: 'return runs.run("k", { agent: "scout", task: "look" })',
    }, hidden), undefined);
    assert.equal(blockHiddenSubagent({
      action: "schedule.create",
      workflowScript: 'return runs.run("k", { agent: args.name, task: "x" })',
    }, hidden)?.block, true);
    assert.equal(blockHiddenSubagent({
      action: "schedule.create",
      workflowScript: 'return runs.run("k", { agent: "scout" + args.extra, task: "x" })',
    }, hidden)?.block, true);
    assert.equal(blockHiddenSubagent({
      action: "schedule.create",
      workflowScript: "return runs.run('k', { agent: `scout`, task: 'look' })",
    }, hidden)?.block, true);
    assert.equal(blockHiddenSubagent({ action: "schedule.create" }, hidden)?.block, true);
    assert.equal(blockHiddenSubagent({
      workflowScript: 'return runs.all([runs.run("s", { agent: "scout", task: args.look }), runs.run("w", { agent: "worker", task: "edit" })])',
    }, hidden), undefined);
    assert.equal(blockHiddenSubagent({
      action: "validate",
      workflowScript: 'return runs.run("k", { agent: "claude-code", task: "x" })',
    }, hidden), undefined);
    assert.equal(blockHiddenSubagent({ workflow: "review" }, hidden), undefined);
    assert.equal(blockHiddenSubagent({ action: "capabilities", agent: "claude-code" }, hidden), undefined);
    const codex = blockHiddenSubagent({
      workflowScript: 'return runs.run("k", { agent: "codex-exec", task: "x" })',
    }, ["codex-exec", "codex-exec-writer"]);
    assert.match(codex?.reason ?? "", /no Codex runner/);
    assert.equal(blockHiddenSubagent({
      workflowScript: 'return runs.run("k", { agent: "scout", task: "look" })',
      args: { note: "claude-code" },
    }, hidden)?.block, true);

    const root = mkdtempSync(join(tmpdir(), "kernal-sub-wf-"));
    const proj = join(root, "proj");
    mkdirSync(proj);
    writeFileSync(join(proj, "bad.js"), 'return runs.run("k", { agent: "claude-code", task: "x" })\n');
    writeFileSync(join(proj, "scout.js"), 'return runs.run("k", { agent: "scout", task: "look" })\n');
    writeFileSync(join(proj, "empty.js"), " \n");
    const io = { cwd: root };
    const fromFile = blockHiddenSubagent({ workflowScriptPath: "bad.js", cwd: "proj" }, hidden, io);
    assert.equal(fromFile?.block, true);
    assert.match(fromFile?.reason ?? "", /subscription_worker/);
    assert.equal(blockHiddenSubagent({ workflowScriptPath: "scout.js", cwd: "proj" }, hidden, io), undefined);
    assert.equal(blockHiddenSubagent({ workflowScriptPath: join("proj", "scout.js") }, hidden, io), undefined);
    assert.equal(blockHiddenSubagent({ workflowScriptPath: "missing.js", cwd: "proj" }, hidden, io)?.block, true);
    assert.equal(blockHiddenSubagent({ workflowScriptPath: "empty.js", cwd: "proj" }, hidden, io)?.block, true);
    assert.equal(blockHiddenSubagent({
      action: "schedule.create",
      workflowScriptPath: "scout.js",
      cwd: "proj",
    }, hidden, io), undefined);
    assert.equal(blockHiddenSubagent({ workflowScriptPath: join(proj, "bad.js") }, hidden, { cwd: "/tmp" })?.block, true);
  });

  test("the extension registers the tool, blocks a hidden launch, and appends the note", async () => {
    const { _resetCentralConfig, setLocalOverride } = await import("../.pi/extensions/_shared/central-config.ts");
    const mod = await import("../.pi/extensions/kernal-subscriptions/index.ts");
    const tools: { name: string; execute: Function }[] = [];
    const handlers: Record<string, Function[]> = {};
    mod.default({
      registerTool: (tool: { name: string; execute: Function }) => { tools.push(tool); },
      on: (ev: string, h: Function) => { (handlers[ev] ??= []).push(h); },
    } as any);
    assert.equal(tools[0]?.name, "subscription_worker");
    assert.equal(handlers.tool_call?.length, 1);
    assert.equal(handlers.before_agent_start?.length, 1);
    try {
      setLocalOverride("subscriptions.claude", "full");
      setLocalOverride("subscriptions.codex", "off");
      const blocked = await handlers.tool_call[0]({ toolName: "subagent", input: { agent: "claude-code", task: "edit" } });
      assert.equal(blocked.block, true);
      assert.equal(await handlers.tool_call[0]({ toolName: "subagent", input: { agent: "scout", task: "look" } }), undefined);
      assert.equal(await handlers.tool_call[0]({ toolName: "bash", input: { command: "true" } }), undefined);
      const eventDir = mkdtempSync(join(tmpdir(), "kernal-sub-hook-event-"));
      const ctxDir = mkdtempSync(join(tmpdir(), "kernal-sub-hook-ctx-"));
      writeFileSync(join(eventDir, "use.js"), 'return runs.run("k", { agent: "claude-code", task: "x" })\n');
      writeFileSync(join(ctxDir, "use.js"), 'return runs.run("k", { agent: "scout", task: "look" })\n');
      const fromEvent = await handlers.tool_call[0](
        { toolName: "subagent", input: { workflowScriptPath: "use.js" }, cwd: eventDir },
        { cwd: ctxDir },
      );
      assert.equal(fromEvent.block, true);
      assert.equal(await handlers.tool_call[0](
        { toolName: "subagent", input: { workflowScriptPath: "use.js" } },
        { cwd: ctxDir },
      ), undefined);
      const event = { systemPromptOptions: { appendSystemPrompt: "base", forceSystemPrompt: undefined as string | undefined } };
      await handlers.before_agent_start[0](event);
      assert.match(event.systemPromptOptions.appendSystemPrompt, /subscription_worker/);
      assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
      const forced = { systemPromptOptions: { appendSystemPrompt: undefined as string | undefined, forceSystemPrompt: "forced" } };
      await handlers.before_agent_start[0](forced);
      assert.match(forced.systemPromptOptions.forceSystemPrompt, /^forced\n\nsubscriptions\.claude is on/);
    } finally {
      setLocalOverride("subscriptions.claude", undefined);
      setLocalOverride("subscriptions.codex", undefined);
      _resetCentralConfig();
    }
  });
});
