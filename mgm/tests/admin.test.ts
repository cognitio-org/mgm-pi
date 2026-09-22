/** /admin: the request guards, the server, and the whole extension driven over real HTTP. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { makePi, makeCtx, tmpAgentDir } from "./harness.ts";
import { FIELDS, applyEmbeddingChoice, setReranking } from "../.pi/extensions/mgm-codebase-index/lib.ts";
import { busRequest, busServe } from "../.pi/extensions/connect/lib.ts";
import {
  hostAllowed, originAllowed, tokenMatches, redactSecrets, validateConnections, idleMs, indexFields, leaksSecret, secretValues, backendPill, connectionsView, DEFAULT_IDLE_MINUTES,
} from "../.pi/extensions/mgm-admin/lib.ts";
import { startAdminServer } from "../.pi/extensions/mgm-admin/server.ts";
import { APP_JS, APP_CSS, INDEX_HTML } from "../.pi/extensions/mgm-admin/app.ts";

/** Raw HTTP, so Host and Origin can be set to anything (fetch forbids both). */
function call(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: string; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, agent: false, method: opts.method ?? "GET", path: opts.path ?? "/", headers: { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) } }, (res) => {
      let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("admin request guards", () => {
  test("Host must be this server by one of its two names (DNS rebinding)", () => {
    assert.ok(hostAllowed("127.0.0.1:4000", 4000));
    assert.ok(hostAllowed("localhost:4000", 4000));
    assert.ok(hostAllowed("LOCALHOST:4000", 4000));
    assert.ok(!hostAllowed("127.0.0.1:4001", 4000), "another port");
    assert.ok(!hostAllowed("evil.example:4000", 4000), "a rebinding hostname");
    assert.ok(!hostAllowed("127.0.0.1", 4000), "no port");
    assert.ok(!hostAllowed(undefined, 4000));
  });

  test("Origin is absent (curl) or this server; anything else is cross-origin", () => {
    assert.ok(originAllowed(undefined, 4000));
    assert.ok(originAllowed("http://127.0.0.1:4000", 4000));
    assert.ok(originAllowed("http://localhost:4000", 4000));
    assert.ok(!originAllowed("https://evil.example", 4000));
    assert.ok(!originAllowed("http://127.0.0.1:4001", 4000));
    assert.ok(!originAllowed("null", 4000), "sandboxed frames and file:// send null");
  });

  test("the token compares in constant time and only exactly", () => {
    assert.ok(tokenMatches("abc123", "abc123"));
    assert.ok(!tokenMatches("abc124", "abc123"));
    assert.ok(!tokenMatches("abc12", "abc123"));
    assert.ok(!tokenMatches(undefined, "abc123"));
    assert.ok(!tokenMatches(["abc123"], "abc123"), "a repeated header is refused");
    assert.ok(!tokenMatches("", ""), "no token configured never matches");
  });

  test("idle timeout: 15 minutes unless MGM_ADMIN_IDLE_MINUTES says otherwise", () => {
    assert.equal(idleMs({}), DEFAULT_IDLE_MINUTES * 60_000);
    assert.equal(idleMs({ MGM_ADMIN_IDLE_MINUTES: "2" }), 120_000);
    assert.equal(idleMs({ MGM_ADMIN_IDLE_MINUTES: "nonsense" }), 15 * 60_000);
    assert.equal(idleMs({ MGM_ADMIN_IDLE_MINUTES: "-1" }), 15 * 60_000);
  });
});

describe("admin secrets", () => {
  const KEY = "sk-live-0123456789abcdef";
  test("anything named like a key is masked to its last four characters, at any depth", () => {
    const out = redactSecrets({ reranker: { apiKey: KEY, model: "voyage/rerank-3" }, list: [{ token: KEY }], plain: "x" });
    assert.equal(out.reranker.apiKey, "set (…cdef)");
    assert.equal(out.reranker.model, "voyage/rerank-3");
    assert.equal(out.list[0].token, "set (…cdef)");
    assert.ok(!JSON.stringify(out).includes(KEY));
  });

  test("the connections view carries no key in full", () => {
    const v = connectionsView({ LITELLM_AGENT_KEY: KEY, OPENROUTER_API_KEY: "sk-or-v1-zzzzzzzzzzzz9876", LITELLM_BASE_URL: "litellm.example.com" });
    assert.equal(v.LITELLM_AGENT_KEY, "set (…cdef)");
    assert.equal(v.OPENROUTER_API_KEY, "set (…9876)");
    assert.equal(v.LITELLM_BASE_URL, "https://litellm.example.com/v1", "normalizeBaseUrl, as connect shows it");
    assert.ok(!JSON.stringify(v).includes(KEY));
  });

  test("leak check finds any secret the agent holds, ignoring short values", () => {
    const secrets = secretValues({ OPENROUTER_API_KEY: KEY, SHORT_KEY: "abc", PATH: "/usr/bin" });
    assert.deepEqual(secrets, [KEY]);
    assert.ok(leaksSecret(`{"k":"${KEY}"}`, secrets));
    assert.ok(!leaksSecret(`{"k":"set (…cdef)"}`, secrets));
  });
});

describe("admin connection edits reuse connect's rules", () => {
  test("URLs go through normalizeBaseUrl and keys through cleanKey; a blank key keeps the saved one", () => {
    const r = validateConnections({ LMSTUDIO_BASE_URL: "localhost:9999", LITELLM_BASE_URL: "router.example.com/", OPENROUTER_API_KEY: "  Bearer \"sk-or-v1-abc\" ", LITELLM_AGENT_KEY: "" });
    assert.deepEqual(r.errors, {});
    assert.equal(r.values.LMSTUDIO_BASE_URL, "http://localhost:9999/v1");
    assert.equal(r.values.LITELLM_BASE_URL, "https://router.example.com/v1");
    assert.equal(r.values.OPENROUTER_API_KEY, "sk-or-v1-abc");
    assert.ok(!("LITELLM_AGENT_KEY" in r.values), "blank means keep");
  });

  test("bad values are refused per field, with a reason", () => {
    const r = validateConnections({ LITELLM_BASE_URL: "http://a b", OPENROUTER_API_KEY: "two words", MGM_USER: "a\nB=evil" });
    assert.match(r.errors.LITELLM_BASE_URL, /valid http/);
    assert.match(r.errors.OPENROUTER_API_KEY, /no spaces/);
    assert.match(r.errors.MGM_USER, /single line/, "a newline would inject a line into .env");
    assert.deepEqual(r.values, {});
  });

  test("an unusual OpenRouter key is saved with a warning; keys can be removed but nothing else", () => {
    const r = validateConnections({ OPENROUTER_API_KEY: "sk-abc123", clear: ["LITELLM_AGENT_KEY", "LMSTUDIO_BASE_URL"] });
    assert.equal(r.values.OPENROUTER_API_KEY, "sk-abc123");
    assert.match(r.warnings.OPENROUTER_API_KEY, /sk-or-v1-/);
    assert.equal(r.values.LITELLM_AGENT_KEY, "");
    assert.match(r.errors.LMSTUDIO_BASE_URL, /only a key/);
  });

  test("backend pills say what connect knows", () => {
    assert.equal(backendPill({ id: "openrouter", hasKey: false, registered: false, answered: false, models: [] }).text, "not configured");
    assert.equal(backendPill({ id: "openrouter", hasKey: true, registered: false, answered: false, rejected: "401: bad", models: [] }).pill, "error");
    assert.equal(backendPill({ id: "litellm", hasKey: true, registered: true, answered: false, models: ["a", "b"] }).detail, "2 models");
    assert.equal(backendPill({ id: "lmstudio", hasKey: true, registered: true, answered: false, models: [] }).text, "unreachable");
  });

  test("the index page offers every field /index edits", () => {
    const fields = indexFields({ search: { maxResults: 20 } });
    assert.deepEqual(fields.map((f) => f.id), FIELDS.map((f) => f.path.join(".")));
    assert.equal(fields.find((f) => f.id === "search.maxResults")!.value, 20);
    assert.ok(fields.every((f) => f.group !== "other"));
  });
});

describe("index rules shared by /index and /admin", () => {
  const router = { baseUrl: "https://r.example/v1", apiKey: "sk-router-key-0000" };
  test("setReranking: on needs the router and a model; off keeps the model", () => {
    assert.match(setReranking({}, true, {}).error!, /run \/setup/);
    assert.match(setReranking({}, true, router).error!, /Pick a rerank model/);
    const on = setReranking({ search: { maxResults: 5 } }, true, router, "voyage/rerank-3").config!;
    assert.deepEqual(on.reranker, { enabled: true, provider: "custom", baseUrl: router.baseUrl, model: "voyage/rerank-3", apiKey: router.apiKey });
    assert.equal(on.search.maxResults, 5, "other settings untouched");
    assert.equal(setReranking(on, true, router).config!.reranker.model, "voyage/rerank-3", "re-enabling reuses the stored model");
    const off = setReranking(on, false, router).config!;
    assert.deepEqual([off.reranker.enabled, off.reranker.model], [false, "voyage/rerank-3"]);
  });

  test("applyEmbeddingChoice: endpoint, size and key together, or a reason", () => {
    const router1 = applyEmbeddingChoice({}, { source: "router", id: "voyage/voyage-code-4", dimensions: 1024 }, { localUrl: "http://localhost:1234/v1", router }, undefined).config!;
    assert.deepEqual(router1.customProvider, { baseUrl: router.baseUrl, model: "voyage/voyage-code-4", dimensions: 1024, apiKey: router.apiKey });
    assert.equal(router1.embeddingProvider, "custom");
    const local = applyEmbeddingChoice({}, { source: "local", id: "nomic" }, { localUrl: "http://localhost:1234/v1", router }, 768).config!;
    assert.deepEqual(local.customProvider, { baseUrl: "http://localhost:1234/v1", model: "nomic", dimensions: 768 });
    assert.match(applyEmbeddingChoice({}, { source: "local", id: "nomic" }, { localUrl: "http://localhost:1234/v1" }, undefined).error!, /dimension count is unknown/);
    assert.match(applyEmbeddingChoice({}, { source: "router", id: "x", dimensions: 8 }, { localUrl: "http://l/v1", router: {} }, undefined).error!, /router URL is not set/);
  });
});

describe("event bus request/reply", () => {
  test("answers, errors, and nobody listening", async () => {
    const pi = makePi();
    assert.equal(await busRequest(pi.events, "nobody", {}), undefined, "no server: resolves at once");
    busServe(pi.events, "echo", (req) => ({ got: req.x }));
    assert.deepEqual(await busRequest(pi.events, "echo", { x: 1 }), { got: 1 });
    busServe(pi.events, "boom", () => { throw new Error("nope"); });
    await assert.rejects(busRequest(pi.events, "boom", {}), /nope/);
    assert.equal(await busRequest(undefined, "echo", {}), undefined, "no bus at all (older pi)");
  });
});

describe("the page", () => {
  test("script and stylesheet are same-origin files, the script parses, and it builds DOM without innerHTML of data", () => {
    assert.match(INDEX_HTML, /<script src="\/app.js"><\/script>/);
    assert.ok(!/<script>/.test(INDEX_HTML), "no inline script (the CSP forbids it)");
    const all = INDEX_HTML + APP_CSS + APP_JS;
    assert.ok(!/(src|href)=["']?(https?:)?\/\//i.test(all), "no CDN script or stylesheet");
    assert.ok(!/@import|url\(\s*["']?(https?:)?\/\//i.test(all), "no web font or remote image");
    assert.deepEqual([...APP_JS.matchAll(/fetch\(([^,]+),/g)].map((m) => m[1].trim()), ['"/api" + path'], "the only request the page makes is to its own API");
    assert.doesNotThrow(() => new Function(APP_JS));
    const innerHtml = APP_JS.match(/innerHTML\s*=/g) ?? [];
    assert.equal(innerHtml.length, 1, "only the static icon set is written as markup");
    assert.match(APP_CSS, /prefers-color-scheme: dark/);
    assert.match(APP_JS, /x-mgm-admin-token/);
  });
});

describe("admin server", () => {
  const TOKEN = "t".repeat(43);
  const start = (extra: any = {}) => startAdminServer({
    token: TOKEN, idleMs: 60_000,
    assets: { "/index.html": { type: "text/html", body: "<h1>shell</h1>" } },
    api: async (req) => ({ body: { path: req.path, method: req.method, body: req.body } }),
    ...extra,
  });

  test("binds 127.0.0.1 on a random port and serves the shell without the token", async () => {
    const s = await start();
    try {
      assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.ok(s.port > 0);
      const r = await call(s.port);
      assert.equal(r.status, 200);
      assert.equal(r.text, "<h1>shell</h1>");
      assert.match(r.headers["content-security-policy"], /script-src 'self'/);
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.equal(r.headers["cache-control"], "no-store");
    } finally { await s.stop(); }
  });

  test("every API request needs the token, as a header", async () => {
    const s = await start();
    try {
      assert.equal((await call(s.port, { path: "/api/overview" })).status, 401, "no token");
      assert.equal((await call(s.port, { path: "/api/overview", headers: { "x-mgm-admin-token": "wrong" } })).status, 401, "wrong token");
      assert.equal((await call(s.port, { path: `/api/overview?t=${TOKEN}` })).status, 401, "a query string does not count");
      assert.equal((await call(s.port, { path: "/api/overview", headers: { cookie: `x-mgm-admin-token=${TOKEN}` } })).status, 401, "a cookie does not count");
      const ok = await call(s.port, { path: "/api/overview", headers: { "x-mgm-admin-token": TOKEN } });
      assert.equal(ok.status, 200);
      assert.deepEqual(JSON.parse(ok.text).path, "/overview");
    } finally { await s.stop(); }
  });

  test("a foreign Host is refused before anything else (DNS rebinding), even with the token", async () => {
    const s = await start();
    try {
      for (const host of ["evil.example:" + s.port, "127.0.0.1:1", "attacker.localhost"]) {
        assert.equal((await call(s.port, { path: "/api/overview", headers: { host, "x-mgm-admin-token": TOKEN } })).status, 403, host);
        assert.equal((await call(s.port, { path: "/", headers: { host } })).status, 403, `${host}: not even the shell`);
      }
      assert.equal((await call(s.port, { path: "/api/overview", headers: { host: `localhost:${s.port}`, "x-mgm-admin-token": TOKEN } })).status, 200);
    } finally { await s.stop(); }
  });

  test("cross-origin writes are refused; same-origin and non-browser writes go through; writes must be JSON", async () => {
    const s = await start();
    const body = JSON.stringify({ a: 1 });
    const post = (headers: Record<string, string>) => call(s.port, { method: "POST", path: "/api/x", body, headers: { "x-mgm-admin-token": TOKEN, "content-type": "application/json", ...headers } });
    try {
      assert.equal((await post({ origin: "https://evil.example" })).status, 403);
      assert.equal((await post({ origin: "null" })).status, 403);
      assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
      assert.equal((await post({ origin: `http://127.0.0.1:${s.port}` })).status, 200);
      assert.equal((await post({})).status, 200, "curl sends no Origin; the token still has to be right");
      assert.equal((await post({ "content-type": "text/plain" })).status, 415, "a simple (preflight-free) request is refused");
      assert.equal((await call(s.port, { method: "POST", path: "/api/x", body: "{", headers: { "x-mgm-admin-token": TOKEN, "content-type": "application/json" } })).status, 400);
      assert.equal((await call(s.port, { method: "POST", path: "/api/x", body: "x".repeat(70_000), headers: { "x-mgm-admin-token": TOKEN, "content-type": "application/json" } })).status, 413);
      assert.equal((await call(s.port, { method: "DELETE", path: "/api/x", headers: { "x-mgm-admin-token": TOKEN } })).status, 405);
    } finally { await s.stop(); }
  });

  test("a response that would carry a secret in full is withheld", async () => {
    const s = await start({ api: async () => ({ body: { key: "sk-live-0123456789abcdef" } }), checkResponse: (t: string) => !t.includes("sk-live-0123456789abcdef") });
    try {
      const r = await call(s.port, { path: "/api/x", headers: { "x-mgm-admin-token": TOKEN } });
      assert.equal(r.status, 500);
      assert.ok(!r.text.includes("sk-live"));
    } finally { await s.stop(); }
  });

  test("stops after the idle timeout; background polls do not count as use", async () => {
    let reason = "";
    const s = await start({ idleMs: 300, onStop: (r: string) => { reason = r; } });
    for (let i = 0; i < 3; i++) { assert.equal((await call(s.port, { path: "/api/ping", headers: { "x-mgm-admin-token": TOKEN, "x-mgm-poll": "1" } })).status, 200); await sleep(70); }
    await sleep(250);
    assert.ok(s.stopped, "polls every 70 ms did not keep it alive past 300 ms");
    assert.equal(reason, "idle");
    await assert.rejects(call(s.port), /ECONNREFUSED/);
  });

  test("real use keeps it alive; stop() closes it at once", async () => {
    const s = await start({ idleMs: 300 });
    for (let i = 0; i < 5; i++) { await call(s.port, { path: "/api/x", headers: { "x-mgm-admin-token": TOKEN } }); await sleep(100); }
    assert.ok(!s.stopped, "requests every 100 ms keep a 300 ms idle timer from firing");
    await s.stop();
    assert.ok(s.stopped);
    await assert.rejects(call(s.port), /ECONNREFUSED/);
  });

  test("each start gets its own token and port", async () => {
    const a = await startAdminServer({ idleMs: 60_000, assets: {}, api: async () => ({ body: {} }) });
    const b = await startAdminServer({ idleMs: 60_000, assets: {}, api: async () => ({ body: {} }) });
    try {
      assert.notEqual(a.token, b.token);
      assert.notEqual(a.port, b.port);
      assert.ok(a.token.length >= 43, "32 random bytes");
    } finally { await a.stop(); await b.stop(); }
  });
});

describe("/admin end to end (real server, real extensions, fake pi)", async () => {
  const ROUTER_KEY = "sk-router-SECRET-11112222";
  const OR_KEY = "sk-or-v1-SECRET-33334444";
  const home = mkdtempSync(join(tmpdir(), "mgm-admin-home-"));
  process.env.HOME = home; process.chdir(home);
  process.env.MGM_NO_DISCOVERY = "1"; process.env.MGM_NO_BROWSER = "1";
  process.env.LITELLM_AGENT_KEY = ROUTER_KEY; process.env.LITELLM_BASE_URL = "https://router.invalid/v1"; process.env.OPENROUTER_API_KEY = OR_KEY;
  delete process.env.LITELLM_API_KEY; delete process.env.LMSTUDIO_BASE_URL;
  const indexConfig = join(home, "cbi", "config.json");
  process.env.MGM_INDEX_CONFIG = indexConfig;
  const store = tmpAgentDir({ defaultProvider: "litellm", defaultModel: "gpt-5.4-nano", subagents: { defaultModel: "litellm/gemini-3.8-flash", agentOverrides: { worker: { model: "litellm/claude-sonnet-5" } } } });

  const connect = await import("../.pi/extensions/connect/index.ts");
  const index = await import("../.pi/extensions/mgm-codebase-index/index.ts");
  const admin = await import("../.pi/extensions/mgm-admin/index.ts");
  const pi = makePi();
  let ctx: any; let port = 0; let token = "";
  const calls: string[] = [];

  before(async () => {
    await connect.default(pi as any);
    const tool = (name: string, text: string) => ({ name, label: name, description: "", parameters: {}, execute: async () => { calls.push(name); return { content: [{ type: "text", text }] }; } });
    await index.default(pi as any, { plan: { kind: "prebundled", entry: "fake" }, load: async () => ({ default: (p: any) => { p.registerTool(tool("index_status", "Indexed chunks: 1,615\nCurrent branch: main")); p.registerTool(tool("index_codebase", "done")); p.registerTool(tool("knowledge_base_list", "")); } }) });
    admin.default(pi as any);
    ctx = makeCtx({ models: pi.providers.flatMap((p) => p.config.models.map((m: any) => ({ ...m, provider: p.name }))), model: { provider: "litellm", id: "gpt-5.4-nano", contextWindow: 272_000, maxTokens: 64_000 } });
    ctx.cwd = home;
    await pi.commands.get("admin")!.handler("", ctx);
    const link = ctx.notices.at(-1).msg.match(/http:\/\/127\.0\.0\.1:(\d+)\/#t=([A-Za-z0-9_-]+)/);
    assert.ok(link, ctx.notices.at(-1).msg);
    port = Number(link[1]); token = link[2];
  });
  after(async () => { await pi.commands.get("admin")!.handler("stop", ctx); });

  const get = (path: string) => call(port, { path: `/api${path}`, headers: { "x-mgm-admin-token": token } });
  const post = (path: string, body: unknown) => call(port, { method: "POST", path: `/api${path}`, body: JSON.stringify(body), headers: { "x-mgm-admin-token": token, "content-type": "application/json", origin: `http://127.0.0.1:${port}` } });
  const noKeys = (text: string) => { for (const k of [ROUTER_KEY, OR_KEY, "sk-or-v1-fake-fake-fake-fake"]) assert.ok(!text.includes(k), `response carries a key: ${text.slice(0, 200)}`); };

  test("/admin starts the server, says where, and shows it in the status bar", () => {
    assert.ok(port > 0 && token.length >= 43);
    assert.equal(ctx.statuses.get("admin"), `◍ admin :${port}`);
  });

  test("overview reports the model, context, versions, connections and index, and no key", async () => {
    const r = await get("/overview");
    assert.equal(r.status, 200, r.text);
    noKeys(r.text);
    const d = JSON.parse(r.text);
    assert.deepEqual([d.model.provider, d.model.id], ["litellm", "gpt-5.4-nano"]);
    assert.equal(d.thinking, "off");
    assert.equal(d.index.chunks, 1615, "asked the index extension over the bus");
    assert.deepEqual(d.connections.map((c: any) => [c.id, c.text]), [["lmstudio", "unreachable"], ["litellm", "connected"], ["openrouter", "connected"]]);
    assert.equal(d.versions.mgm, "source checkout");
  });

  test("connections show keys masked, never in full", async () => {
    const r = await get("/connections");
    noKeys(r.text);
    const d = JSON.parse(r.text);
    assert.equal(d.values.LITELLM_AGENT_KEY, "set (…2222)");
    assert.equal(d.values.OPENROUTER_API_KEY, "set (…4444)");
  });

  test("a bad write lands nowhere and says why at the field", async () => {
    const r = await post("/connections", { LITELLM_BASE_URL: "http://a b", OPENROUTER_API_KEY: "x y" });
    assert.equal(r.status, 422);
    const d = JSON.parse(r.text);
    assert.ok(d.errors.LITELLM_BASE_URL && d.errors.OPENROUTER_API_KEY);
    assert.ok(!existsSync(join(store.root, ".env")), "nothing written");
  });

  test("a good write goes through writeEnvValues into .env, re-registers providers, and is not echoed", async () => {
    const before = pi.providers.length;
    const r = await post("/connections", { OPENROUTER_API_KEY: "Bearer sk-or-v1-fake-fake-fake-fake", LMSTUDIO_BASE_URL: "localhost:9999" });
    assert.equal(r.status, 200, r.text);
    noKeys(r.text);
    const env = store.env();
    assert.match(env, /^OPENROUTER_API_KEY=sk-or-v1-fake-fake-fake-fake$/m, "cleanKey stripped the Bearer prefix");
    assert.match(env, /^LMSTUDIO_BASE_URL=http:\/\/localhost:9999\/v1$/m, "normalizeBaseUrl added scheme and /v1");
    assert.equal(process.env.OPENROUTER_API_KEY, "sk-or-v1-fake-fake-fake-fake", "live in this process");
    assert.ok(pi.providers.length > before, "providers registered again, as after /setup");
    assert.equal(pi.providers.filter((p) => p.name === "openrouter").at(-1)!.config.apiKey, "sk-or-v1-fake-fake-fake-fake");
    assert.match(JSON.parse(r.text).message, /Saved 2 settings/);
  });

  test("test-connection reports the provider's own words and never the key", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: any) => String(url).includes("/auth/key")
      ? new Response(JSON.stringify({ error: { message: "User not found." } }), { status: 401 })
      : new Response("{}", { status: 404 })) as any;
    try {
      const r = await post("/connections/test", { backend: "openrouter", apiKey: "sk-or-v1-typed-but-unsaved-777" });
      const d = JSON.parse(r.text);
      assert.equal(d.state, "rejected");
      assert.equal(d.detail, "401: User not found.");
      assert.ok(!r.text.includes("typed-but-unsaved"));
    } finally { globalThis.fetch = real; }
  });

  test("switching the model goes through connect: pi.setModel and the saved default", async () => {
    const r = await post("/model", { provider: "litellm", id: "claude-sonnet-5" });
    assert.equal(r.status, 200, r.text);
    assert.equal(pi.setModelCalls.at(-1).id, "claude-sonnet-5");
    assert.deepEqual([store.read().defaultProvider, store.read().defaultModel], ["litellm", "claude-sonnet-5"]);
    const bad = await post("/model", { provider: "litellm", id: "no-such-model" });
    assert.equal(bad.status, 422);
    assert.match(JSON.parse(bad.text).error, /not found/);
  });

  test("index settings: applyEdit's validation, written with writeConfig", async () => {
    const tooMany = await post("/index", { edits: [{ id: "search.maxResults", value: "500" }] });
    assert.equal(tooMany.status, 422);
    assert.equal(JSON.parse(tooMany.text).errors["search.maxResults"], "Max results must be at most 200");
    const ok = await post("/index", { edits: [{ id: "search.maxResults", value: "30" }, { id: "indexing.watchFiles", value: false }, { id: "search.fusionStrategy", value: "weighted" }] });
    assert.equal(ok.status, 200, ok.text);
    const written = JSON.parse(readFileSync(indexConfig, "utf8"));
    assert.equal(written.search.maxResults, 30);
    assert.equal(written.search.fusionStrategy, "weighted");
    assert.equal(written.indexing.watchFiles, false);
    assert.match(JSON.parse(ok.text).notes.map((n: any) => n.text).join(" "), /restart mgm/, "says when a restart is needed");
  });

  test("reranking on stores the router key owner-only and never returns it", async () => {
    const r = await post("/index", { reranking: { enabled: true, model: "voyage/rerank-3" } });
    assert.equal(r.status, 200, r.text);
    noKeys(r.text);
    const written = JSON.parse(readFileSync(indexConfig, "utf8"));
    assert.deepEqual([written.reranker.enabled, written.reranker.model, written.reranker.apiKey], [true, "voyage/rerank-3", ROUTER_KEY]);
    assert.equal(statSync(indexConfig).mode & 0o777, 0o600);
    const view = await get("/index");
    noKeys(view.text);
    assert.equal(JSON.parse(view.text).fields.find((f: any) => f.id === "reranker.model").value, "voyage/rerank-3");
    const off = await post("/index", { reranking: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(JSON.parse(readFileSync(indexConfig, "utf8")).reranker.model, "voyage/rerank-3", "off keeps the model");
  });

  test("an index run is started through the index extension's own tool", async () => {
    const r = await post("/index/run", { op: "rebuild" });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).started, true);
    await sleep(20);
    assert.ok(calls.includes("index_codebase"));
  });

  // ---------- subagents: settings and agent definitions, through pi-subagents' own code ----------
  const pkgDir = join(import.meta.dirname, "..", ".pi", "npm", "node_modules", "pi-subagents");
  const noPkg = !existsSync(join(pkgDir, "src", "agents", "agents.js")) && "extension packages not installed (npm ci in .pi/npm)";
  const project = join(home, "proj");
  /** What the package itself resolves, independently of the admin: the ground truth for every write. */
  const discover = async () => {
    const m = await import(join(pkgDir, "src", "agents", "agents.js"));
    m.clearAgentDiscoveryCache();
    return new Map<string, any>(m.discoverAgents(project, "both", "litellm").agents.map((a: any) => [a.name, a]));
  };
  const agentBody = (over: Record<string, unknown> = {}) => ({
    mode: "create", scope: "user", name: "helper", description: "Finds things fast", tools: ["read", "grep"], model: "litellm/claude-sonnet-5", thinking: "high",
    prompt: "# Helper\n\nYou find things.\n\n```yaml\n---\nname: not-frontmatter\n---\n```\n\n- **Be brief**\n", ...over,
  });

  describe("subagents", { skip: noPkg }, () => {
    let cwdBefore = "";
    before(() => {
      process.env.MGM_SUBAGENTS_PKG = pkgDir;
      mkdirSync(join(project, ".pi"), { recursive: true });
      cwdBefore = ctx.cwd; ctx.cwd = project;
    });
    after(() => { ctx.cwd = cwdBefore; });

    test("lists every agent with its source, and the models from settings", async () => {
      const r = await get("/subagents");
      assert.equal(r.status, 200, r.text);
      const d = JSON.parse(r.text);
      assert.equal(d.settings.defaultModel, "litellm/gemini-3.8-flash");
      assert.equal(d.settings.overrides.worker.model, "litellm/claude-sonnet-5");
      const scout = d.agents.find((a: any) => a.name === "scout");
      assert.deepEqual([scout.source, scout.editable, scout.active, scout.model, scout.modelFrom], ["builtin", false, true, "litellm/gemini-3.8-flash", "subagents default"]);
      assert.equal(d.agents.find((a: any) => a.name === "worker").modelFrom, "override");
      assert.equal(d.dirs.user, join(store.dir, "agents"), "pi-subagents' user scope: $PI_CODING_AGENT_DIR/agents");
      assert.ok(d.tools.some((t: any) => t.name === "read" && t.from === "pi"));
      assert.ok(d.tools.some((t: any) => t.name === "contact_supervisor"), "tools builtin agents name are offered too");
    });

    test("create: written by the package, and the package resolves exactly what was sent", async () => {
      const r = await post("/subagents/agent", agentBody());
      assert.equal(r.status, 200, r.text);
      const d = JSON.parse(r.text);
      assert.deepEqual([d.resolved.source, d.resolved.model, d.resolved.thinking, d.resolved.tools], ["user", "litellm/claude-sonnet-5", "high", ["read", "grep"]]);
      const file = join(store.dir, "agents", "helper.md");
      assert.equal(d.resolved.file, file);
      const seen = (await discover()).get("helper");
      assert.equal(seen.source, "user");
      assert.equal(seen.description, "Finds things fast");
      assert.match(seen.systemPrompt, /```yaml\n---\nname: not-frontmatter\n---\n```/, "a fence holding frontmatter-like text survives as prompt text");
      const back = JSON.parse((await get("/subagents/agent?name=helper&source=user")).text);
      assert.deepEqual(back.fields.tools, ["read", "grep"]);
      assert.equal(back.fields.model, "litellm/claude-sonnet-5");
      assert.equal(back.prompt.trim(), agentBody().prompt.trim(), "the prompt round-trips unchanged");
    });

    test("update and rename: the old file goes, the package sees the new one", async () => {
      const r = await post("/subagents/agent", agentBody({ mode: "update", original: "helper", name: "finder", description: "Finds things, renamed", tools: null, model: "", thinking: "" }));
      assert.equal(r.status, 200, r.text);
      const seen = await discover();
      assert.ok(!seen.has("helper"));
      assert.equal(seen.get("finder").description, "Finds things, renamed");
      assert.equal(seen.get("finder").tools, undefined, "default tools: no allowlist");
      assert.equal(seen.get("finder").model, "litellm/gemini-3.8-flash", "no model of its own: the subagents default applies");
      assert.ok(!existsSync(join(store.dir, "agents", "helper.md")));
    });

    test("a change the package would silently ignore is rolled back, not saved", async () => {
      const before = readFileSync(join(store.dir, "agents", "finder.md"), "utf8");
      const r = await post("/subagents/agent", agentBody({ mode: "update", original: "finder", name: "finder", description: ">" }));
      assert.equal(r.status, 422, r.text);
      assert.match(JSON.parse(r.text).error, /^Not saved: pi-subagents does not find a user agent named finder after saving/);
      assert.equal(readFileSync(join(store.dir, "agents", "finder.md"), "utf8"), before, "the file is back as it was");
    });

    test("customise a builtin: an editable same-name copy that wins over the builtin", async () => {
      const r = await post("/subagents/customise", { name: "scout", scope: "user" });
      assert.equal(r.status, 200, r.text);
      assert.equal(JSON.parse(r.text).resolved.source, "user");
      assert.equal((await discover()).get("scout").filePath, join(store.dir, "agents", "scout.md"), "same-name user file overrides the builtin");
      const edit = await get("/subagents/agent?name=scout&source=user");
      const a = JSON.parse(edit.text);
      assert.equal(a.row.editable, true);
      const saved = await post("/subagents/agent", { mode: "update", scope: "user", original: "scout", ...a.fields, prompt: a.prompt + "\n\nAlways cite file paths.\n" });
      assert.equal(saved.status, 200, saved.text);
      assert.match((await discover()).get("scout").systemPrompt, /Always cite file paths\.$/);
      assert.equal((await post("/subagents/customise", { name: "scout", scope: "user" })).status, 409, "only one copy per scope");
      assert.equal((await post("/subagents/agent", { ...agentBody({ mode: "update", original: "scout", name: "scout" }), scope: "project" })).status, 404, "builtins are not edited in place");
    });

    test("delete: the file goes and the name falls back to the builtin", async () => {
      const r = await post("/subagents/delete", { name: "scout", scope: "user" });
      assert.equal(r.status, 200, r.text);
      assert.equal(JSON.parse(r.text).resolved.source, "builtin");
      assert.equal((await discover()).get("scout").source, "builtin");
      assert.equal((await post("/subagents/delete", { name: "scout", scope: "user" })).status, 404, "a builtin cannot be deleted");
    });

    test("project scope writes into the project's .pi/agents and wins over user", async () => {
      assert.equal((await post("/subagents/agent", agentBody({ name: "dup", scope: "user" }))).status, 200);
      const r = await post("/subagents/agent", agentBody({ name: "dup", scope: "project", description: "project copy" }));
      assert.equal(r.status, 200, r.text);
      assert.equal((await discover()).get("dup").filePath, join(project, ".pi", "agents", "dup.md"));
      const list = JSON.parse((await get("/subagents")).text).agents.filter((a: any) => a.name === "dup");
      assert.deepEqual(list.map((a: any) => [a.source, a.active, a.shadowedBy ?? null]), [["project", true, null], ["user", false, "project"]]);
    });

    test("model settings: written to settings.json, and the package resolves them", async () => {
      const r = await post("/subagents/settings", { defaultModel: "litellm/gemini-4-flash", overrides: { worker: { model: "litellm/claude-opus-5", thinking: "xhigh" }, oracle: { model: "" } } });
      assert.equal(r.status, 200, r.text);
      const s = store.read().subagents;
      assert.equal(s.defaultModel, "litellm/gemini-4-flash");
      assert.deepEqual(s.agentOverrides.worker, { model: "litellm/claude-opus-5", thinking: "xhigh" });
      assert.ok(!("oracle" in (s.agentOverrides ?? {})), "an emptied override is removed");
      const seen = await discover();
      assert.equal(seen.get("worker").model, "litellm/claude-opus-5");
      assert.equal(seen.get("scout").model, "litellm/gemini-4-flash");
      assert.equal(store.read().defaultModel, "claude-sonnet-5", "the rest of settings.json is untouched");
      const bad = await post("/subagents/settings", { defaultModel: "not a model", overrides: { worker: { thinking: "max" } } });
      assert.equal(bad.status, 422);
      assert.deepEqual(Object.keys(JSON.parse(bad.text).errors).sort(), ["defaultModel", "worker.thinking"]);
    });

    test("names become file names: a crafted name never writes outside the agents directory", async () => {
      const crafted = ["../../evil", "../evil", "..", "a/b", "a\\b", "/tmp/evil", "evil.md", "Evil", "e\u0000vil", "%2e%2e%2fevil", " ", ""];
      for (const name of crafted) {
        for (const r of [
          await post("/subagents/agent", agentBody({ name })),
          await post("/subagents/agent", agentBody({ mode: "update", original: name, name: "ok-name" })),
          await post("/subagents/customise", { name, scope: "user" }),
          await post("/subagents/delete", { name, scope: "user" }),
        ]) assert.ok(r.status === 400 || r.status === 422 || r.status === 404, `${JSON.stringify(name)} → ${r.status} ${r.text.slice(0, 120)}`);
      }
      for (const dir of [home, store.root, store.dir, dirname(home), "/tmp"]) assert.ok(!existsSync(join(dir, "evil.md")), `nothing written in ${dir}`);
      assert.equal((await post("/subagents/agent", agentBody({ name: "../../evil" }))).status, 422);
      assert.match(JSON.parse((await post("/subagents/agent", agentBody({ name: "../../evil" }))).text).errors.name, /slashes or dots/);
    });

    test("a symlink out of the agents directory is not editable and is never written through", async () => {
      const outside = join(home, "outside.md");
      writeFileSync(outside, "---\nname: sneaky\ndescription: lives elsewhere\n---\nhello\n");
      symlinkSync(outside, join(store.dir, "agents", "sneaky.md"));
      const row = JSON.parse((await get("/subagents")).text).agents.find((a: any) => a.name === "sneaky");
      assert.equal(row.editable, false);
      const r = await post("/subagents/agent", agentBody({ mode: "update", original: "sneaky", name: "sneaky", prompt: "overwritten" }));
      assert.equal(r.status, 403, r.text);
      assert.equal((await post("/subagents/delete", { name: "sneaky", scope: "user" })).status, 403);
      assert.match(readFileSync(outside, "utf8"), /hello/);
    });

    test("an agent file holding a key is never sent to the page, and a key is never saved into one", async () => {
      writeFileSync(join(store.dir, "agents", "leaky.md"), `---\nname: leaky\ndescription: has a key\n---\nUse ${ROUTER_KEY} for the router.\n`);
      const list = await get("/subagents");
      assert.equal(list.status, 200);
      noKeys(list.text);
      assert.equal(JSON.parse(list.text).agents.find((a: any) => a.name === "leaky").withheld, true);
      const one = await get("/subagents/agent?name=leaky&source=user");
      assert.equal(one.status, 200);
      noKeys(one.text);
      assert.equal(JSON.parse(one.text).withheld, true);
      const r = await post("/subagents/agent", agentBody({ name: "keyed", prompt: "call it with sk-or-v1-fake-fake-fake-fake" }));
      assert.equal(r.status, 422);
      assert.match(JSON.parse(r.text).errors.prompt, /key/);
      noKeys(r.text);
      assert.ok(!existsSync(join(store.dir, "agents", "keyed.md")));
    });

    test("the preview is markdownToHtml: escaped first, so a prompt cannot inject markup", async () => {
      const r = await post("/subagents/preview", { markdown: "## Title\n\n<script>alert(1)</script> **bold**" });
      const html = JSON.parse(r.text).html;
      assert.match(html, /<h3>Title<\/h3>/);
      assert.match(html, /&lt;script&gt;/);
      assert.match(html, /<strong>bold<\/strong>/);
    });

    test("every new write endpoint enforces the gate: token, origin, JSON", async () => {
      for (const path of ["/subagents/agent", "/subagents/customise", "/subagents/delete", "/subagents/settings", "/subagents/preview"]) {
        const body = JSON.stringify({ name: "x", scope: "user" });
        const hit = (headers: Record<string, string>) => call(port, { method: "POST", path: `/api${path}`, body, headers: { "content-type": "application/json", ...headers } });
        assert.equal((await hit({})).status, 401, `${path} without the token`);
        assert.equal((await hit({ "x-mgm-admin-token": "wrong".repeat(9) })).status, 401);
        assert.equal((await hit({ "x-mgm-admin-token": token, origin: "https://evil.example" })).status, 403, `${path} cross-origin`);
        assert.equal((await hit({ "x-mgm-admin-token": token, "content-type": "text/plain" })).status, 415, `${path} as a simple request`);
        assert.equal((await call(port, { method: "POST", path: `/api${path}`, body, headers: { "x-mgm-admin-token": token, "content-type": "application/json", host: "evil.example" } })).status, 403, `${path} rebinding`);
      }
      assert.equal((await call(port, { path: "/api/subagents/agent?name=finder&source=user" })).status, 401, "reads need the token too");
    });
  });

  test("/admin status and a second /admin reuse the running server", async () => {
    await pi.commands.get("admin")!.handler("status", ctx);
    assert.match(ctx.notices.at(-1).msg, new RegExp(`127\\.0\\.0\\.1:${port}`));
    await pi.commands.get("admin")!.handler("", ctx);
    assert.match(ctx.notices.at(-1).msg, new RegExp(`:${port}/#t=${token}`));
    await pi.commands.get("admin")!.handler("index", ctx);
    assert.match(ctx.notices.at(-1).msg, new RegExp(`#t=${token}&p=index`), "opens at a page");
    await pi.commands.get("admin")!.handler("bogus", ctx);
    assert.equal(ctx.notices.at(-1).type, "error");
  });

  test("session shutdown stops the server", async () => {
    await pi.emit("session_shutdown", {}, ctx);
    await assert.rejects(call(port, { path: "/" }), /ECONNREFUSED/);
    await pi.commands.get("admin")!.handler("stop", ctx);
    assert.match(ctx.notices.at(-1).msg, /not running/);
  });
});
