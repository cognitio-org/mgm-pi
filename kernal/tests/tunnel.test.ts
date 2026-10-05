/**
 * Local Host tunnels (_shared/tunnel/, #380 LH-2): the built-in ngrok traffic policy, the guard
 * proxy (allow-list, bearer gate, rate limit, SSE keep-alive), the ngrok provider driving a fake
 * agent program (tests/fixtures/fake-ngrok.mjs: start, stop, refusals, a hang, a crash), finding and
 * installing the agent with its checksum, unavailable runtimes, and `auto` selection. Nothing
 * contacts ngrok: the fake serves a loopback forwarder, the model server is a local stub, and the
 * download is a fetch stub.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ngrokTrafficPolicy } from "../.pi/extensions/_shared/tunnel/policy.ts";
import { endsEvent, slidingWindow, startGuardProxy } from "../.pi/extensions/_shared/tunnel/proxy.ts";
import { classifyNgrokLog, compareVersions, findNgrok, installNgrok, ngrokProvider, NGROK_PINNED } from "../.pi/extensions/_shared/tunnel/ngrok.ts";
import { cloudflareProvider } from "../.pi/extensions/_shared/tunnel/cloudflare.ts";
import {
  DEFAULT_ALLOW_PATHS, TunnelError, interimCredentialsFromEnv, openTunnel, parseTunnelChoice, selectProvider,
  type NgrokCredentials, type ProviderRegistry, type TunnelProvider,
} from "../.pi/extensions/_shared/tunnel/tunnel.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-ngrok.mjs");
const CREDS: NgrokCredentials = { provider: "ngrok", authtoken: "2fakeAuthToken_0123456789abcdef", url: "https://kernal-test.ngrok.app" };

// ---------- helpers ----------

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** A stand-in model server: records each request; /v1/chat/completions with stream=true answers
 * with one event, a silence, then a second event. */
async function modelServer(silenceMs = 0): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (body.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {\"a\":1}\n\n");
        setTimeout(() => { res.write("data: [DONE]\n\n"); res.end(); }, silenceMs);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

async function send(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(base + path, { method: init.method ?? "GET", headers: init.headers, body: init.body });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** A temp dir holding an executable `ngrok` that runs the fake with `behaviour`. */
function fakeNgrok(behaviour: { version?: string; mode?: string } = {}): { bin: string; dir: string; record: () => any } {
  const dir = mkdtempSync(join(tmpdir(), "kernal-fake-ngrok-"));
  const recordFile = join(dir, "record.json");
  const bFile = join(dir, "behaviour.json");
  writeFileSync(bFile, JSON.stringify({ mode: "ok", ...behaviour, record: recordFile }));
  const bin = join(dir, "ngrok");
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${FIXTURE}' '${bFile}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, dir, record: () => JSON.parse(readFileSync(recordFile, "utf8")) };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const emptyBinDir = () => mkdtempSync(join(tmpdir(), "kernal-bin-"));

// A developer's own ngrok (Homebrew) must never be found or run: PATH is the system dirs only, and
// KERNAL_NGROK_BIN is set per test.
const savedPath = process.env.PATH;
before(() => { process.env.PATH = "/usr/bin:/bin"; delete process.env.KERNAL_NGROK_BIN; });
after(() => { process.env.PATH = savedPath; delete process.env.KERNAL_NGROK_BIN; });

// ---------- the policy ----------

describe("ngrok traffic policy", () => {
  test("rate limit, then the allow-list, as one JSON policy", () => {
    const p = JSON.parse(ngrokTrafficPolicy());
    const [rate, paths] = p.on_http_request;
    assert.equal(rate.actions[0].type, "rate-limit");
    assert.deepEqual({ capacity: rate.actions[0].config.capacity, rate: rate.actions[0].config.rate }, { capacity: 120, rate: "60s" });
    assert.equal(paths.actions[0].type, "custom-response");
    assert.equal(paths.actions[0].config.status_code, 404);
    for (const path of DEFAULT_ALLOW_PATHS) assert.ok(paths.expressions[0].includes(`'${path}'`), path);
    assert.equal(p.on_http_request.length, 2);
  });

  test("a bearer token adds a 401 gate before the paths", () => {
    const p = JSON.parse(ngrokTrafficPolicy({ bearerToken: "tok_0123456789abcdef", rateLimit: { requests: 5, windowSeconds: 10 } }));
    assert.equal(p.on_http_request[0].actions[0].config.capacity, 5);
    assert.equal(p.on_http_request[1].actions[0].type, "deny");
    assert.ok(p.on_http_request[1].expressions[0].includes("'Bearer tok_0123456789abcdef'"));
  });

  test("values that could break out of a CEL string are refused", () => {
    assert.throws(() => ngrokTrafficPolicy({ allowPaths: ["/v1/models', 'x"] }), (e: any) => e instanceof TunnelError && e.kind === "credentials");
    assert.throws(() => ngrokTrafficPolicy({ allowPaths: ["/v1/../api"] }), TunnelError);
    assert.throws(() => ngrokTrafficPolicy({ allowPaths: [] }), TunnelError);
    assert.throws(() => ngrokTrafficPolicy({ bearerToken: "short" }), TunnelError);
    assert.throws(() => ngrokTrafficPolicy({ bearerToken: "abcdefghijklmnop' || true || '" }), TunnelError);
    assert.throws(() => ngrokTrafficPolicy({ rateLimit: { requests: 0, windowSeconds: 60 } }), TunnelError);
  });
});

// ---------- the guard proxy ----------

describe("guard proxy", () => {
  test("forwards allow-listed paths only, exactly as written", async () => {
    const model = await modelServer();
    const guard = await startGuardProxy({ upstream: model.url });
    try {
      const ok = await send(guard.url, "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(ok.status, 200);
      assert.equal((await send(guard.url, "/v1/models?x=1")).status, 200);
      for (const path of ["/api/v0/models", "/v1/models/../../api/v0/models", "/V1/models", "/%761/models", "/v1/models/", "//v1/models", "/"]) {
        const r = await send(guard.url, path);
        assert.equal(r.status, 404, path);
      }
      assert.equal((await send(guard.url, "/v1/models", { method: "DELETE" })).status, 405);
      assert.deepEqual(model.seen.map((s) => s.url), ["/v1/chat/completions", "/v1/models?x=1"]);
      assert.equal(model.seen[0].headers.host, new URL(model.url).host, "Host is the model server's own");
      assert.deepEqual(guard.stats().refused, { rate: 0, auth: 0, method: 1, path: 7 });
      assert.equal(guard.stats().forwarded, 2);
    } finally {
      await guard.close();
      await model.close();
    }
  });

  test("bearer gate: 401 without the token, and the token never reaches the model server", async () => {
    const model = await modelServer();
    const guard = await startGuardProxy({ upstream: model.url, bearerToken: "tok_0123456789abcdef" });
    try {
      assert.equal((await send(guard.url, "/v1/models")).status, 401);
      assert.equal((await send(guard.url, "/v1/models", { headers: { authorization: "Bearer tok_0123456789abcdeX" } })).status, 401);
      assert.equal((await send(guard.url, "/api/v0/models")).status, 401, "unauthenticated callers learn nothing about paths");
      assert.equal((await send(guard.url, "/v1/models", { headers: { authorization: "Bearer tok_0123456789abcdef" } })).status, 200);
      assert.equal(model.seen.length, 1);
      assert.equal(model.seen[0].headers.authorization, undefined);
    } finally {
      await guard.close();
      await model.close();
    }
  });

  test("rate limit: a sliding window, 429 with Retry-After, then room again", async () => {
    let now = 1_000_000;
    const model = await modelServer();
    const guard = await startGuardProxy({ upstream: model.url, rateLimit: { requests: 3, windowSeconds: 60 }, now: () => now });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await send(guard.url, "/v1/models")).status, 200);
      const limited = await send(guard.url, "/v1/models");
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
      now += 30_000;
      assert.equal((await send(guard.url, "/v1/models")).status, 429);
      now += 30_001;
      assert.equal((await send(guard.url, "/v1/models")).status, 200);
      assert.equal(guard.stats().refused.rate, 2);
      assert.equal(model.seen.length, 4);
    } finally {
      await guard.close();
      await model.close();
    }
  });

  test("slidingWindow on its own", () => {
    let t = 0;
    const w = slidingWindow({ requests: 2, windowSeconds: 1 }, () => t);
    assert.equal(w.take(), true);
    t = 500;
    assert.equal(w.take(), true);
    assert.equal(w.take(), false);
    assert.equal(w.retryAfterSeconds(), 1);
    t = 1000;
    assert.equal(w.take(), true, "the first hit has left the window");
    assert.equal(w.take(), false);
  });

  test("keeps a silent event stream alive with SSE comments between events", async () => {
    const model = await modelServer(400);
    const guard = await startGuardProxy({ upstream: model.url, keepAliveMs: 50 });
    try {
      const r = await send(guard.url, "/v1/chat/completions", { method: "POST", body: JSON.stringify({ stream: true }) });
      assert.equal(r.status, 200);
      assert.match(r.text, /^data: \{"a":1\}\n\n(: keep-alive\n\n)+data: \[DONE\]\n\n$/);
      assert.ok(guard.stats().keepAlives >= 1);
    } finally {
      await guard.close();
      await model.close();
    }
    assert.equal(endsEvent(Buffer.from("data: x\n\n")), true);
    assert.equal(endsEvent(Buffer.from("data: x\r\n\r\n")), true);
    assert.equal(endsEvent(Buffer.from("data: x\n")), false);
  });

  test("a model server that is down is a 502, not a crash", async () => {
    const guard = await startGuardProxy({ upstream: "http://127.0.0.1:9" });
    try {
      const r = await send(guard.url, "/v1/models");
      assert.equal(r.status, 502);
      assert.match(r.text, /unreachable/);
    } finally {
      await guard.close();
    }
  });

  test("only a plain-http model server on this machine", () => {
    assert.throws(() => startGuardProxy({ upstream: "https://127.0.0.1:1234" }), TunnelError);
    assert.throws(() => startGuardProxy({ upstream: "http://10.0.0.5:1234" }), TunnelError);
  });
});

// ---------- finding and installing ngrok ----------

describe("ngrok runtime", () => {
  test("versions and log lines", () => {
    assert.equal(compareVersions("3.39.11", "3.20.0"), 1);
    assert.equal(compareVersions("3.9.0", "3.20.0"), -1);
    assert.equal(compareVersions("3.20", "3.20.0"), 0);
    assert.deepEqual(classifyNgrokLog('{"msg":"started tunnel","url":"https://a.ngrok.app"}'), { started: true, url: "https://a.ngrok.app" });
    assert.deepEqual(classifyNgrokLog('{"lvl":"crit","err":"ERR_NGROK_105"}'), { error: "ERR_NGROK_105" });
    assert.equal(classifyNgrokLog('{"lvl":"info","msg":"update available"}'), undefined);
    assert.equal(classifyNgrokLog("not json"), undefined);
  });

  test("no ngrok anywhere: unavailable and installable, never a throw", async () => {
    const p = ngrokProvider({ binDir: emptyBinDir() });
    const s = await p.status(CREDS);
    assert.equal(s.available, false);
    assert.equal(s.installable, true);
    assert.match(s.reason!, /not installed/);
    await assert.rejects(p.start({ localUrl: "http://127.0.0.1:9", credentials: CREDS }), (e: any) => e instanceof TunnelError && e.kind === "unavailable");
  });

  test("a KERNAL_NGROK_BIN that is missing or too old is a reason, not a crash", async () => {
    process.env.KERNAL_NGROK_BIN = "/nonexistent/ngrok";
    try {
      const r = await findNgrok({ binDir: emptyBinDir() });
      assert.equal(r.found, undefined);
      assert.match((r as any).reason, /\/nonexistent\/ngrok does not run/);
      process.env.KERNAL_NGROK_BIN = fakeNgrok({ version: "3.3.1" }).bin;
      const old = await ngrokProvider({ binDir: emptyBinDir() }).status(CREDS);
      assert.equal(old.available, false);
      assert.match(old.reason!, /ngrok 3\.3\.1; Kernal needs 3\.20\.0/);
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });

  test("Kernal's own copy in its bin directory is found before PATH", async () => {
    const binDir = emptyBinDir();
    const fake = fakeNgrok();
    writeFileSync(join(binDir, "ngrok"), readFileSync(fake.bin));
    chmodSync(join(binDir, "ngrok"), 0o755);
    const r = await findNgrok({ binDir });
    assert.deepEqual(r.found, { path: join(binDir, "ngrok"), version: "3.39.11", source: "managed" });
  });

  test("bad credentials are unavailable with a reason", async () => {
    process.env.KERNAL_NGROK_BIN = fakeNgrok().bin;
    try {
      const p = ngrokProvider({ binDir: emptyBinDir() });
      assert.equal((await p.status()).available, true, "runtime alone");
      assert.match((await p.status({ ...CREDS, authtoken: "x" })).reason!, /authtoken/);
      assert.match((await p.status({ ...CREDS, url: "https://a.ngrok.app/path" })).reason!, /endpoint URL/);
      assert.match((await p.status({ provider: "cloudflare", tunnelToken: "t" })).reason!, /no ngrok credentials/);
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });

  /** A tar.gz holding one `ngrok` script, as ngrok's archives hold the one binary. */
  function archive(): Buffer {
    const dir = mkdtempSync(join(tmpdir(), "kernal-ngrok-archive-"));
    writeFileSync(join(dir, "ngrok"), "#!/bin/sh\necho 'ngrok version 3.39.11'\n");
    chmodSync(join(dir, "ngrok"), 0o755);
    execFileSync("tar", ["czf", join(dir, "a.tar.gz"), "-C", dir, "ngrok"]);
    return readFileSync(join(dir, "a.tar.gz"));
  }

  test("install: checksum verified, binary unpacked into Kernal's bin, runs", async () => {
    const data = archive();
    const binDir = join(emptyBinDir(), "bin");
    const urls: string[] = [];
    const pinned = { version: "3.39.11", assets: { ...NGROK_PINNED.assets, "linux-x64": { url: "https://example.test/ngrok.tgz", sha256: createHash("sha256").update(data).digest("hex") } } };
    const res = await installNgrok({ binDir, platform: "linux-x64", pinned, fetchBinary: async (u) => { urls.push(u); return data; } });
    assert.deepEqual(res, { ok: true, path: join(binDir, "ngrok"), version: "3.39.11" });
    assert.deepEqual(urls, ["https://example.test/ngrok.tgz"]);
    assert.equal(statSync(join(binDir, "ngrok")).mode & 0o777, 0o755);
  });

  test("install: a checksum mismatch installs nothing", async () => {
    const binDir = join(emptyBinDir(), "bin");
    const res = await installNgrok({ binDir, platform: "darwin-arm64", fetchBinary: async () => archive() });
    assert.equal(res.ok, false);
    assert.match((res as any).detail, /does not match its published checksum/);
    assert.equal(existsSync(join(binDir, "ngrok")), false);
  });

  test("install: a failed download or an unknown platform is a result", async () => {
    const res = await installNgrok({ binDir: emptyBinDir(), platform: "linux-arm64", fetchBinary: async () => { throw new Error("offline"); } });
    assert.deepEqual(res, { ok: false, detail: "offline" });
    const none = await installNgrok({ binDir: emptyBinDir(), platform: "plan9-mips" as any });
    assert.equal(none.ok, false);
  });

  test("the pinned release names every platform with a full sha256", () => {
    for (const [k, a] of Object.entries(NGROK_PINNED.assets)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/, k);
      assert.ok(a.url.startsWith("https://bin.equinox.io/") && a.url.includes(`ngrok-v3-${NGROK_PINNED.version}-`), k);
    }
  });
});

// ---------- the ngrok provider with the fake agent ----------

describe("ngrok provider", () => {
  test("start: authtoken only in a 0600 config, policy and URL passed, minimal env; stop cleans up", async () => {
    const fake = fakeNgrok();
    process.env.KERNAL_NGROK_BIN = fake.bin;
    process.env.LITELLM_AGENT_KEY_TEST_ONLY = "must-not-leak";
    try {
      const t = await ngrokProvider({ binDir: emptyBinDir() }).start({ localUrl: "http://127.0.0.1:41234", credentials: { ...CREDS, bearerToken: "tok_0123456789abcdef" } });
      assert.equal(t.publicUrl, CREDS.url);
      assert.equal(t.health().state, "up");
      const rec = fake.record();
      assert.ok(!rec.args.join(" ").includes(CREDS.authtoken), "no token on the command line");
      assert.ok(rec.args.includes("--url") && rec.args.includes(CREDS.url!));
      assert.equal(rec.args[1], "http://127.0.0.1:41234");
      assert.match(rec.config, /authtoken: "2fakeAuthToken_0123456789abcdef"/);
      assert.match(rec.config, /web_addr: false/);
      assert.match(rec.config, /remote_management: false/);
      const policy = JSON.parse(rec.policy);
      assert.equal(policy.on_http_request.length, 3, "rate limit, bearer, paths");
      assert.ok(!rec.envKeys.some((k: string) => /LITELLM|NGROK|KERNAL/.test(k)), rec.envKeys.join(","));
      const cfg = rec.args[rec.args.indexOf("--config") + 1];
      assert.equal(statSync(cfg).mode & 0o777, 0o600);
      await t.stop();
      await t.stop();
      assert.equal(t.health().state, "stopped");
      assert.equal(existsSync(cfg), false, "the config with the token is gone");
      assert.equal(alive(rec.pid), false);
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
      delete process.env.LITELLM_AGENT_KEY_TEST_ONLY;
    }
  });

  test("Outfitter's traffic policy is used as given; no URL takes the one ngrok reports", async () => {
    const fake = fakeNgrok();
    process.env.KERNAL_NGROK_BIN = fake.bin;
    try {
      const t = await ngrokProvider({ binDir: emptyBinDir() }).start({ localUrl: "http://127.0.0.1:1", credentials: { provider: "ngrok", authtoken: CREDS.authtoken, trafficPolicy: "on_http_request: []\n" } });
      const rec = fake.record();
      assert.equal(rec.policy, "on_http_request: []\n");
      assert.ok(!rec.args.includes("--url"));
      assert.equal(t.publicUrl, `https://fake-${rec.pid}.ngrok-free.app`);
      await t.stop();
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });

  test("a refused authtoken is a credentials error, and the agent is gone", async () => {
    const fake = fakeNgrok({ mode: "fail" });
    process.env.KERNAL_NGROK_BIN = fake.bin;
    try {
      await assert.rejects(ngrokProvider({ binDir: emptyBinDir() }).start({ localUrl: "http://127.0.0.1:1", credentials: CREDS }),
        (e: any) => e instanceof TunnelError && e.kind === "credentials" && /ERR_NGROK_105/.test(e.message));
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });

  test("an agent that never starts times out and is killed", async () => {
    const fake = fakeNgrok({ mode: "hang" });
    process.env.KERNAL_NGROK_BIN = fake.bin;
    try {
      await assert.rejects(ngrokProvider({ binDir: emptyBinDir(), startTimeoutMs: 1500 }).start({ localUrl: "http://127.0.0.1:1", credentials: CREDS }),
        (e: any) => e instanceof TunnelError && e.kind === "timeout");
      assert.equal(alive(fake.record().pid), false);
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });

  test("a started tunnel without a URL is a failure", async () => {
    process.env.KERNAL_NGROK_BIN = fakeNgrok({ mode: "no-url" }).bin;
    try {
      await assert.rejects(ngrokProvider({ binDir: emptyBinDir() }).start({ localUrl: "http://127.0.0.1:1", credentials: { provider: "ngrok", authtoken: CREDS.authtoken } }),
        (e: any) => e instanceof TunnelError && /without reporting its URL/.test(e.message));
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });

  test("an agent that dies after starting: onDown once, health down", async () => {
    process.env.KERNAL_NGROK_BIN = fakeNgrok({ mode: "die" }).bin;
    try {
      let downs = 0;
      let downed!: (why: string) => void;
      const down = new Promise<string>((r) => (downed = r));
      const t = await ngrokProvider({ binDir: emptyBinDir() }).start({ localUrl: "http://127.0.0.1:1", credentials: CREDS, onDown: (why) => { downs++; downed(why); } });
      assert.match(await down, /ngrok exited \(code 3/);
      assert.equal(t.health().state, "down");
      assert.match(t.health().reason!, /code 3/);
      await t.stop();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(downs, 1);
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });
});

// ---------- selection ----------

function stubProvider(id: "ngrok" | "cloudflare", available: boolean | "throw"): TunnelProvider {
  return {
    id,
    async status() {
      if (available === "throw") throw new Error("boom");
      return { provider: id, available, ...(available ? {} : { reason: `${id} stub unavailable` }) };
    },
    async start() {
      return { provider: id, publicUrl: `https://${id}.example`, health: () => ({ state: "up", since: "now" }), stop: async () => {} };
    },
  };
}

describe("provider selection", () => {
  test("parseTunnelChoice falls back to auto", () => {
    assert.equal(parseTunnelChoice("ngrok"), "ngrok");
    assert.equal(parseTunnelChoice("cloudflare"), "cloudflare");
    assert.equal(parseTunnelChoice("wireguard"), "auto");
    assert.equal(parseTunnelChoice(undefined), "auto");
  });

  test("auto picks ngrok when its runtime and credentials are present", async () => {
    process.env.KERNAL_NGROK_BIN = fakeNgrok().bin;
    try {
      const reg: ProviderRegistry = { ngrok: ngrokProvider({ binDir: emptyBinDir() }), cloudflare: cloudflareProvider() };
      const sel = await selectProvider("auto", [CREDS], reg);
      assert.equal(sel.ok, true);
      assert.equal(sel.ok && sel.provider.id, "ngrok");
      assert.match(sel.ok ? sel.status.runtime! : "", /ngrok 3\.39\.11/);
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
    }
  });

  test("auto with nothing usable: not ok, every provider's reason, no throw", async () => {
    const reg: ProviderRegistry = { ngrok: ngrokProvider({ binDir: emptyBinDir() }), cloudflare: cloudflareProvider() };
    const sel = await selectProvider("auto", [CREDS], reg);
    assert.equal(sel.ok, false);
    assert.match(sel.ok ? "" : sel.reason, /no tunnel provider can run here \(ngrok: the ngrok agent is not installed; cloudflare: Cloudflare Tunnel is not supported yet \(#386\)\)/);
    assert.equal(sel.statuses.length, 2);
  });

  test("auto skips a provider without credentials, or whose check throws, for the next", async () => {
    const reg: ProviderRegistry = { ngrok: stubProvider("ngrok", true), cloudflare: stubProvider("cloudflare", true) };
    const cf = { provider: "cloudflare" as const, tunnelToken: "t" };
    const sel = await selectProvider("auto", [cf], reg);
    assert.equal(sel.ok && sel.provider.id, "cloudflare");
    assert.match(sel.statuses[0].reason!, /no ngrok credentials/);
    const thrown = await selectProvider("auto", [CREDS, cf], { ngrok: stubProvider("ngrok", "throw"), cloudflare: stubProvider("cloudflare", true) });
    assert.equal(thrown.ok && thrown.provider.id, "cloudflare");
    assert.match(thrown.statuses[0].reason!, /status check failed: boom/);
  });

  test("a named provider is used only if it can run", async () => {
    const sel = await selectProvider("cloudflare", [{ provider: "cloudflare", tunnelToken: "t" }]);
    assert.equal(sel.ok, false);
    assert.match(sel.ok ? "" : sel.reason, /not supported yet/);
    const ng = await selectProvider("ngrok", [CREDS], { ngrok: stubProvider("ngrok", true), cloudflare: stubProvider("cloudflare", true) });
    assert.equal(ng.ok && ng.provider.id, "ngrok");
  });

  test("interim credentials from today's .env names", () => {
    assert.equal(interimCredentialsFromEnv({}), undefined);
    assert.deepEqual(interimCredentialsFromEnv({ NGROK_AUTHTOKEN: "abc_123456789", TUNNEL_DOMAIN_LMSTUDIO: "me.ngrok.app", LOCAL_TUNNEL_TOKEN: "tok_0123456789abcdef" }),
      { provider: "ngrok", authtoken: "abc_123456789", url: "https://me.ngrok.app", bearerToken: "tok_0123456789abcdef" });
  });
});

// ---------- end to end: guard proxy + fake agent + model server ----------

describe("openTunnel", () => {
  test("traffic through the tunnel meets the guard; stop closes both", async () => {
    const model = await modelServer();
    const fake = fakeNgrok();
    process.env.KERNAL_NGROK_BIN = fake.bin;
    try {
      const t = await openTunnel({
        choice: "auto",
        credentials: [{ ...CREDS, bearerToken: "tok_0123456789abcdef" }],
        localUrl: model.url,
        rateLimit: { requests: 50, windowSeconds: 60 },
        providers: { ngrok: ngrokProvider({ binDir: emptyBinDir() }), cloudflare: cloudflareProvider() },
      });
      assert.equal(t.provider, "ngrok");
      assert.equal(t.publicUrl, CREDS.url);
      const edge = fake.record().forwarderUrl as string;
      const auth = { authorization: "Bearer tok_0123456789abcdef" };
      assert.equal((await send(edge, "/v1/models", { headers: auth })).status, 200);
      assert.equal((await send(edge, "/api/v0/models/load", { method: "POST", headers: auth, body: "{}" })).status, 404);
      assert.equal((await send(edge, "/v1/models")).status, 401);
      assert.deepEqual(model.seen.map((s) => s.url), ["/v1/models"]);
      assert.deepEqual(t.guard().refused, { rate: 0, auth: 1, method: 0, path: 1 });
      const guardUrl = fake.record().args[1] as string;
      await t.stop();
      await assert.rejects(fetch(guardUrl + "/v1/models"), "the guard proxy is closed");
      assert.equal(alive(fake.record().pid), false);
    } finally {
      delete process.env.KERNAL_NGROK_BIN;
      await model.close();
    }
  });

  test("no provider: unavailable, and no guard proxy left listening", async () => {
    await assert.rejects(
      openTunnel({ choice: "auto", credentials: [], localUrl: "http://127.0.0.1:9", providers: { ngrok: ngrokProvider({ binDir: emptyBinDir() }), cloudflare: cloudflareProvider() } }),
      (e: any) => e instanceof TunnelError && e.kind === "unavailable",
    );
  });

  test("a provider that fails to start closes the guard proxy", async () => {
    let seenLocal = "";
    const failing: TunnelProvider = { ...stubProvider("ngrok", true), async start(o) { seenLocal = o.localUrl; throw new TunnelError("failed", "nope"); } };
    await assert.rejects(openTunnel({ choice: "ngrok", credentials: [CREDS], localUrl: "http://127.0.0.1:9", providers: { ngrok: failing, cloudflare: cloudflareProvider() } }), /nope/);
    assert.match(seenLocal, /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(fetch(seenLocal + "/v1/models"));
  });
});

