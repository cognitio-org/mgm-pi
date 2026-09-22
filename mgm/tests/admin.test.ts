/** /admin: the request guards, the server, and the whole extension driven over real HTTP. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const noKeys = (text: string) => { for (const k of [ROUTER_KEY, OR_KEY, "sk-or-v1-NEW-KEY-55556666"]) assert.ok(!text.includes(k), `response carries a key: ${text.slice(0, 200)}`); };

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
    const r = await post("/connections", { OPENROUTER_API_KEY: "Bearer sk-or-v1-NEW-KEY-55556666", LMSTUDIO_BASE_URL: "localhost:9999" });
    assert.equal(r.status, 200, r.text);
    noKeys(r.text);
    const env = store.env();
    assert.match(env, /^OPENROUTER_API_KEY=sk-or-v1-NEW-KEY-55556666$/m, "cleanKey stripped the Bearer prefix");
    assert.match(env, /^LMSTUDIO_BASE_URL=http:\/\/localhost:9999\/v1$/m, "normalizeBaseUrl added scheme and /v1");
    assert.equal(process.env.OPENROUTER_API_KEY, "sk-or-v1-NEW-KEY-55556666", "live in this process");
    assert.ok(pi.providers.length > before, "providers registered again, as after /setup");
    assert.equal(pi.providers.filter((p) => p.name === "openrouter").at(-1)!.config.apiKey, "sk-or-v1-NEW-KEY-55556666");
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

  test("subagents are shown read-only from the agent's settings", async () => {
    const d = JSON.parse((await get("/subagents")).text);
    assert.equal(d.subagents.defaultModel, "litellm/gemini-3.8-flash");
    assert.equal(d.subagents.agentOverrides.worker.model, "litellm/claude-sonnet-5");
    assert.equal((await post("/subagents", {})).status, 404, "no write endpoint yet");
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
