/** mgm-codebase-index: how the indexer is loaded in each runtime, and the embedding defaults. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, defaultConfig, embeddingBaseUrl, shouldSeed, parseStatus, resultText, configView, panelRows, indexStatusLine, actions, SUBCOMMANDS, FIELDS, getAt, setAt, applyEdit, fieldRow, invalidatesIndex, configFromView, maskSecret, rerankerProblem, rerankerBlock, routerFromEnv, refreshRouterKey, DEFAULT_EMBEDDING_MODEL, DEFAULT_DIMENSIONS } from "../.pi/extensions/mgm-codebase-index/lib.ts";
import { makePi, makeCtx, stubFetch } from "./harness.ts";

const STATUS_INDEXED = `Auto-index: disabled (state: idle)

Indexed chunks (all branches): 190
Location: /Users/x/proj/.codebase-index/index
Current branch: main
Active branch catalog chunks: 190`;
const STATUS_EMPTY = `Auto-index: disabled (state: idle)

Indexed chunks (all branches): 0
Location: /Users/x/proj/.codebase-index/index
Current branch: main
Codebase is not indexed. Run index_codebase to create an index.`;

const paths = { prebundledPath: "/pkg/dist/pi-extension.mgm.cjs", sourcePath: "/pkg/dist/pi-extension.js" };

describe("codebase index loading", () => {
  test("the pre-bundled CommonJS build wins wherever it exists: it is the only thing pi's compiled binary can load", () => {
    for (const isBun of [true, false]) {
      assert.deepEqual(loadPlan({ prebundled: true, source: true, isBun, ...paths }), { kind: "prebundled", entry: paths.prebundledPath });
    }
  });
  test("without it, Node imports the package's own entry and Bun declines with a reason", () => {
    assert.deepEqual(loadPlan({ prebundled: false, source: true, isBun: false, ...paths }), { kind: "source", entry: paths.sourcePath });
    const bun = loadPlan({ prebundled: false, source: true, isBun: true, ...paths });
    assert.equal(bun.kind, "none");
    assert.match((bun as any).reason, /pre-bundled build/);
  });
  test("a missing package is not an error", () => {
    const none = loadPlan({ prebundled: false, source: false, isBun: false, ...paths });
    assert.equal(none.kind, "none");
    assert.match((none as any).reason, /not installed/);
  });
});

describe("embedding defaults", () => {
  test("embeddings point at the local model server, with or without /v1 in the env", () => {
    assert.equal(embeddingBaseUrl({}), "http://localhost:1234/v1");
    assert.equal(embeddingBaseUrl({ LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1/" }), "http://127.0.0.1:1234/v1");
    assert.equal(embeddingBaseUrl({ LMSTUDIO_BASE_URL: "http://box:4321" }), "http://box:4321/v1");
  });
  test("defaults: local provider, no automatic indexing, overridable model", () => {
    const c = defaultConfig({});
    assert.equal(c.embeddingProvider, "custom");
    assert.deepEqual(c.customProvider, { baseUrl: "http://localhost:1234/v1", model: DEFAULT_EMBEDDING_MODEL, dimensions: DEFAULT_DIMENSIONS });
    assert.equal(c.indexing!.autoIndex, false, "indexing stays an explicit request");
    assert.equal(c.indexing!.watchFiles, true);
    const custom = defaultConfig({ MGM_EMBEDDING_MODEL: "nomic-embed-text-v2", MGM_EMBEDDING_DIMENSIONS: "1024" });
    assert.deepEqual(custom.customProvider, { baseUrl: "http://localhost:1234/v1", model: "nomic-embed-text-v2", dimensions: 1024 });
  });
  test("seeding never overwrites a config the user owns", () => {
    assert.equal(shouldSeed(undefined), true, "no file");
    assert.equal(shouldSeed("{}"), true, "empty object counts as unset");
    assert.equal(shouldSeed('{"embeddingProvider":"openai"}'), false);
    assert.equal(shouldSeed("not json"), false, "leave a file we cannot parse alone");
  });
});

describe("codebase index extension", async () => {
  const mod = await import("../.pi/extensions/mgm-codebase-index/index.ts");
  test("seedConfig writes the defaults once and then leaves them alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-"));
    const file = join(dir, "nested", "config.json");
    process.env.MGM_INDEX_CONFIG = file;
    try {
      assert.equal(mod.seedConfig(), file, "created");
      const written = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(written.customProvider.model, DEFAULT_EMBEDDING_MODEL);
      assert.equal(mod.seedConfig(), undefined, "second run leaves it alone");
      writeFileSync(file, '{"embeddingProvider":"google"}');
      assert.equal(mod.seedConfig(), undefined, "a config the user edited is never replaced");
      assert.equal(JSON.parse(readFileSync(file, "utf8")).embeddingProvider, "google");
    } finally { delete process.env.MGM_INDEX_CONFIG; }
  });
  test("an unwritable config path is not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-"));
    const blocker = join(dir, "blocker"); writeFileSync(blocker, "x");
    process.env.MGM_INDEX_CONFIG = join(blocker, "config.json");   // parent is a file
    try { assert.equal(mod.seedConfig(), undefined); } finally { delete process.env.MGM_INDEX_CONFIG; }
  });
  test("MGM_NO_CODEBASE_INDEX keeps the extension out of the way", async () => {
    process.env.MGM_NO_CODEBASE_INDEX = "1";
    const calls: string[] = [];
    try { await mod.default({ on: (e: string) => calls.push(e), registerCommand: () => calls.push("cmd") } as any); }
    finally { delete process.env.MGM_NO_CODEBASE_INDEX; }
    assert.deepEqual(calls, []);
  });
});

describe("index status and panel", () => {
  test("parseStatus reads the facts a panel needs and keeps the raw text", () => {
    const a = parseStatus(STATUS_INDEXED);
    assert.deepEqual([a.indexed, a.chunks, a.branch, a.autoIndex], [true, 190, "main", "disabled (state: idle)"]);
    assert.equal(a.location, "/Users/x/proj/.codebase-index/index");
    const b = parseStatus(STATUS_EMPTY);
    assert.deepEqual([b.indexed, b.chunks], [false, 0]);
    assert.ok(b.raw.includes("not indexed"));
    const junk = parseStatus("INTERNAL_ERROR: something broke");
    assert.deepEqual([junk.indexed, junk.chunks], [false, undefined]);
  });

  test("resultText flattens every tool-result shape", () => {
    assert.equal(resultText("plain"), "plain");
    assert.equal(resultText({ content: "str" }), "str");
    assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
    assert.equal(resultText({ output: "out" }), "out");
    assert.equal(resultText({ error: "bad" }), "bad");
    assert.equal(resultText(undefined), "");
  });

  test("configView prefers a project config, then the user's, then the built-in defaults", () => {
    const project = { file: "/proj/.codebase-index/config.json", scope: "project" as const, text: JSON.stringify({ embeddingProvider: "openai", search: { maxResults: 5 } }) };
    const user = { file: "/home/.config/codebase-index/config.json", scope: "user" as const, text: JSON.stringify({ embeddingProvider: "custom", customProvider: { baseUrl: "http://localhost:1234/v1", model: "m", dimensions: 768 } }) };
    assert.deepEqual([configView([project, user], {}).scope, configView([project, user], {}).provider, configView([project, user], {}).maxResults], ["project", "openai", 5]);
    assert.equal(configView([{ ...project, text: undefined }, user], {}).scope, "user");
    assert.equal(configView([{ ...project, text: "not json" }, user], {}).file, user.file, "an unparsable file is skipped, not fatal");
    const none = configView([], { LMSTUDIO_BASE_URL: "http://box:1234/v1" });
    assert.deepEqual([none.scope, none.baseUrl, none.model], ["defaults", "http://box:1234/v1", DEFAULT_EMBEDDING_MODEL]);
  });

  test("panelRows shows the index, the embedding state and where the settings came from", () => {
    const base = { config: configView([], {}), project: "/proj", toolCount: 19, knowledgeBases: [] };
    const flat = (rows: any[][]) => rows.map((r) => r.map(([t]: any) => t).join("")).join("\n");
    const ready = flat(panelRows({ ...base, status: parseStatus(STATUS_INDEXED), embeddings: { reachable: true, loaded: true } }));
    assert.match(ready, /190 chunks/); assert.match(ready, /branch main/); assert.match(ready, /ready/);
    assert.match(ready, new RegExp(DEFAULT_EMBEDDING_MODEL)); assert.match(ready, /768d/);
    assert.match(ready, /min score 0\.1/); assert.match(ready, /auto off · watch on/);
    assert.match(ready, /built-in defaults/); assert.match(ready, /no knowledge bases/); assert.match(ready, /19 available/);
    const cold = flat(panelRows({ ...base, status: parseStatus(STATUS_EMPTY), embeddings: { reachable: true, loaded: false } }));
    assert.match(cold, /not indexed/); assert.match(cold, /model not loaded yet/);
    const down = flat(panelRows({ ...base, status: parseStatus(STATUS_EMPTY), embeddings: { reachable: false } }));
    assert.match(down, /server unreachable/);
  });

  test("the status line and the first action follow whether an index exists", () => {
    assert.equal(indexStatusLine(parseStatus(STATUS_INDEXED)), "⌕ 190 chunks");
    assert.equal(indexStatusLine(parseStatus(STATUS_EMPTY)), "⌕ no index");
    assert.match(actions(parseStatus(STATUS_EMPTY))[0].label, /Index this codebase now/);
    assert.match(actions(parseStatus(STATUS_INDEXED))[0].label, /Update the index/);
    assert.deepEqual(actions(parseStatus(STATUS_INDEXED))[1].params, { force: true });
    assert.deepEqual(Object.keys(SUBCOMMANDS).filter(Boolean).sort(), ["bases", "estimate", "health", "logs", "metrics", "off", "reindex", "status", "update"]);
  });
});

describe("/index command", async () => {
  const mod = await import("../.pi/extensions/mgm-codebase-index/index.ts");

  /** A stand-in for the package: registers the tools /index drives, recording every call. */
  function fakePackage(statusText = STATUS_INDEXED) {
    const calls: { name: string; params: any }[] = [];
    const tool = (name: string, text: (p: any) => string) => ({
      name, label: name, description: "", parameters: {},
      execute: async (_id: string, params: any) => { calls.push({ name, params }); return { content: [{ type: "text", text: text(params) }] }; },
    });
    const pkg = async (pi: any) => {
      for (const t of [
        tool("index_status", () => statusText),
        tool("index_codebase", (p) => (p?.force ? "Rebuilt 190 chunks" : p?.estimateOnly ? "Would index 42 files" : "Updated 3 chunks")),
        tool("index_health_check", () => "healthy"),
        tool("index_metrics", () => "queries: 7"),
        tool("index_logs", () => "log line"),
        tool("knowledge_base_list", () => "/extra/docs"),
        tool("knowledge_base_add", (p) => `added ${p.path}`),
        tool("knowledge_base_remove", (p) => `removed ${p.path}`),
        tool("codebase_search", () => "hit"),
      ]) pi.registerTool(t);
    };
    return { calls, pkg };
  }
  const load = (pkg: any) => async () => ({ default: pkg });
  const start = async (statusText?: string) => {
    const { calls, pkg } = fakePackage(statusText);
    const pi = makePi();
    process.env.MGM_INDEX_CONFIG = "/nonexistent/mgm-test/config.json";   // nothing to seed, nothing written
    await mod.default(pi as any, { plan: { kind: "prebundled", entry: "fake" }, load: load(pkg) });
    delete process.env.MGM_INDEX_CONFIG;
    const ctx = makeCtx({ hasUI: true });
    (ctx as any).cwd = "/proj";
    return { pi, ctx, calls };
  };

  test("the package's tools are still registered for the model, and captured for the panel", async () => {
    const { pi } = await start();
    assert.ok(pi.tools.includes("codebase_search"), "the model keeps every tool");
    assert.ok(pi.commands.has("index"), "/index exists (the package registers no commands of its own)");
  });

  test("/index draws the panel, then each picked action runs its tool and the panel refreshes", async () => {
    const { pi, ctx, calls } = await start();
    ctx.answers.push("Rebuild from scratch", "Close panel");
    await pi.commands.get("index")!.handler("", ctx);
    assert.deepEqual(calls.filter((c) => c.name === "index_codebase"), [{ name: "index_codebase", params: { force: true } }]);
    assert.match(ctx.notices.map((n) => n.msg).join("\n"), /Rebuilt 190 chunks/);
    assert.equal(ctx.widgets.get("codebase-index"), undefined, "Close panel takes it down");
    assert.equal(ctx.statuses.get("index"), "⌕ 190 chunks");
    assert.ok(calls.filter((c) => c.name === "index_status").length >= 2, "status is re-read after the action");
  });

  test("knowledge bases are added and removed from the picker", async () => {
    const { pi, ctx, calls } = await start();
    ctx.answers.push("Add a knowledge base directory", "/extra/docs2", "Remove a knowledge base directory", "/extra/docs", "Close panel");
    await pi.commands.get("index")!.handler("", ctx);
    assert.deepEqual(calls.find((c) => c.name === "knowledge_base_add")?.params, { path: "/extra/docs2" });
    assert.deepEqual(calls.find((c) => c.name === "knowledge_base_remove")?.params, { path: "/extra/docs" });
  });

  test("subcommands work without the picker; unknown ones say what is valid; off clears the panel", async () => {
    const { pi, ctx, calls } = await start(STATUS_EMPTY);
    await pi.commands.get("index")!.handler("reindex", ctx);
    assert.deepEqual(calls[0], { name: "index_codebase", params: { force: true } });
    await pi.commands.get("index")!.handler("estimate", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /Would index 42 files/);
    await pi.commands.get("index")!.handler("bases", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /\/extra\/docs/);
    await pi.commands.get("index")!.handler("nope", ctx);
    assert.equal(ctx.notices.at(-1)!.type, "error");
    assert.match(ctx.notices.at(-1)!.msg, /status, update, reindex/);
    ctx.answers.push("Close panel");
    await pi.commands.get("index")!.handler("", ctx);
    await pi.commands.get("index")!.handler("off", ctx);
    assert.equal(ctx.widgets.get("codebase-index"), undefined);
    assert.equal(ctx.statuses.get("index"), undefined);
  });

  test("without a UI, /index prints the status instead of drawing anything", async () => {
    const { pi, calls } = await start();
    const ctx = makeCtx({ hasUI: false }); (ctx as any).cwd = "/proj";
    await pi.commands.get("index")!.handler("", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /Indexed chunks/);
    assert.equal(ctx.widgets.size, 0);
    assert.ok(calls.some((c) => c.name === "index_status"));
  });

  test("a tool that throws is reported, not fatal", async () => {
    const pi = makePi();
    const pkg = async (p: any) => p.registerTool({ name: "index_status", label: "s", description: "", parameters: {}, execute: async () => { throw new Error("engine down"); } });
    await mod.default(pi as any, { plan: { kind: "prebundled", entry: "fake" }, load: async () => ({ default: pkg }) });
    const ctx = makeCtx({ hasUI: false }); (ctx as any).cwd = "/proj";
    await pi.commands.get("index")!.handler("", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /index_status failed: engine down/);
  });
});

describe("settings editing", () => {
  const field = (label: string) => FIELDS.find((f) => f.label === label)!;
  const base = () => ({ embeddingProvider: "custom", customProvider: { baseUrl: "http://localhost:1234/v1", model: "m", dimensions: 768 }, indexing: { autoIndex: false, watchFiles: true }, search: { maxResults: 20, minScore: 0.1, fusionStrategy: "rrf" }, keepMe: { untouched: true } });

  test("setAt writes a nested value without disturbing its siblings or the original", () => {
    const before = base();
    const after = setAt(before, ["search", "maxResults"], 40);
    assert.equal(getAt(after, ["search", "maxResults"]), 40);
    assert.equal(getAt(after, ["search", "minScore"]), 0.1, "sibling kept");
    assert.deepEqual(getAt(after, ["keepMe"]), { untouched: true }, "unrelated keys kept");
    assert.equal(getAt(before, ["search", "maxResults"]), 20, "input not mutated");
    assert.equal(getAt(setAt({}, ["a", "b", "c"], 1), ["a", "b", "c"]), 1, "creates missing levels");
    assert.equal(getAt(base(), ["nope", "deep"]), undefined);
  });

  test("applyEdit validates every kind and reports why, instead of writing nonsense", () => {
    assert.equal(getAt(applyEdit(base(), field("Max results"), "40").config!, ["search", "maxResults"]), 40);
    assert.match(applyEdit(base(), field("Max results"), "0").error!, /at least 1/);
    assert.match(applyEdit(base(), field("Max results"), "abc").error!, /must be a number/);
    assert.match(applyEdit(base(), field("Min score"), "2").error!, /at most 1/);
    assert.match(applyEdit(base(), field("Dimensions"), "768.5").error!, /whole number/);
    assert.match(applyEdit(base(), field("Dimensions"), "4").error!, /at least 8/);
    assert.equal(getAt(applyEdit(base(), field("Embedding server"), "http://box:1234/v1/").config!, ["customProvider", "baseUrl"]), "http://box:1234/v1", "trailing slash trimmed");
    assert.match(applyEdit(base(), field("Embedding server"), "box:1234").error!, /http\(s\) URL/);
    assert.match(applyEdit(base(), field("Provider"), "azure").error!, /must be one of custom, auto/);
    assert.equal(getAt(applyEdit(base(), field("Provider"), "ollama").config!, ["embeddingProvider"]), "ollama");
    assert.equal(getAt(applyEdit(base(), field("Watch files"), false).config!, ["indexing", "watchFiles"]), false);
    assert.equal(getAt(applyEdit(base(), field("Semantic only"), "on").config!, ["indexing", "semanticOnly"]), true);
    assert.match(applyEdit(base(), field("Embedding model"), "   ").error!, /cannot be empty/);
  });

  test("only the fields that change how text is embedded force a rebuild", () => {
    for (const l of ["Embedding model", "Dimensions", "Embedding server", "Provider"]) assert.equal(invalidatesIndex(field(l)), true, l);
    for (const l of ["Max results", "Min score", "Watch files", "Fusion", "Rerank top N"]) assert.equal(invalidatesIndex(field(l)), false, l);
  });

  test("rows show the current value, and a fresh file starts from what is in effect", () => {
    assert.match(fieldRow(field("Max results"), base()), /^Max results +20$/);
    assert.match(fieldRow(field("Watch files"), base()), /on$/);
    assert.match(fieldRow(field("Dimensions"), {}), /—$/);
    const view = configView([], {});
    const fresh = configFromView(view);
    assert.equal(getAt(fresh, ["customProvider", "model"]), DEFAULT_EMBEDDING_MODEL);
    assert.equal(getAt(fresh, ["search", "fusionStrategy"]), "rrf");
  });
});

describe("/index settings dialog", async () => {
  const mod = await import("../.pi/extensions/mgm-codebase-index/index.ts");
  const STATUS = `Auto-index: disabled (state: idle)\n\nIndexed chunks (all branches): 190\nLocation: /proj/.codebase-index/index\nCurrent branch: main`;

  function start(dir: string) {
    const calls: { name: string; params: any }[] = [];
    const pkg = async (pi: any) => {
      const tool = (name: string, text: (p: any) => string) => ({ name, label: name, description: "", parameters: {}, execute: async (_i: string, params: any) => { calls.push({ name, params }); return { content: [{ type: "text", text: text(params) }] }; } });
      pi.registerTool(tool("index_status", () => STATUS));
      pi.registerTool(tool("index_codebase", () => "Rebuilt"));
      pi.registerTool(tool("knowledge_base_list", () => ""));
    };
    const userConfig = join(dir, "user", "config.json");
    process.env.MGM_INDEX_CONFIG = userConfig;
    const pi = makePi();
    const ctx: any = makeCtx({ hasUI: true });
    ctx.cwd = join(dir, "proj");
    mkdirSync(ctx.cwd, { recursive: true });
    return { pi, ctx, calls, userConfig, ready: mod.default(pi as any, { plan: { kind: "prebundled", entry: "fake" }, load: async () => ({ default: pkg }) }) };
  }
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

  test("changing a search setting writes the user config and keeps the rest of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-set-"));
    const { pi, ctx, userConfig, ready } = start(dir);
    await ready;
    ctx.answers.push("Settings", "Max results", "40", "Back", "Close panel");
    await pi.commands.get("index")!.handler("", ctx);
    const saved = read(userConfig);
    assert.equal(saved.search.maxResults, 40);
    assert.equal(saved.search.minScore, 0.1, "untouched settings survive");
    assert.equal(saved.customProvider.model, DEFAULT_EMBEDDING_MODEL);
    assert.match(ctx.notices.map((n: any) => n.msg).join("\n"), /Max results → 40/);
    delete process.env.MGM_INDEX_CONFIG;
  });

  test("a rejected value is explained and nothing is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-set-"));
    const { pi, ctx, userConfig, ready } = start(dir);
    await ready;
    const before = readFileSync(userConfig, "utf8");   // the extension seeds defaults when it loads
    ctx.answers.push("Settings", "Min score", "5", "Back", "Close panel");
    await pi.commands.get("index")!.handler("", ctx);
    assert.equal(ctx.notices.at(-1)!.type, "error");
    assert.match(ctx.notices.at(-1)!.msg, /at most 1/);
    assert.equal(readFileSync(userConfig, "utf8"), before, "a rejected edit changes nothing on disk");
    delete process.env.MGM_INDEX_CONFIG;
  });

  test("picking an embedding model lists the server's embedding models and offers the rebuild it needs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-set-"));
    const restore = stubFetch({
      "/api/v0/models": () => ({ data: [{ id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings" }, { id: "embeddinggemma-300m", type: "embeddings" }, { id: "qwen/qwen3.6-35b-a3b", type: "llm" }] }),
    });
    try {
      const { pi, ctx, calls, userConfig, ready } = start(dir);
      await ready;
      ctx.answers.push("Settings", "Embedding model", "embeddinggemma-300m", "Rebuild now", "Back", "Close panel");
      await pi.commands.get("index")!.handler("", ctx);
      assert.equal(read(userConfig).customProvider.model, "embeddinggemma-300m");
      assert.deepEqual(calls.filter((c) => c.name === "index_codebase"), [{ name: "index_codebase", params: { force: true } }], "rebuilt once, forced");
      assert.match(ctx.notices.map((n: any) => n.msg).join("\n"), /no longer match|Rebuilt/);
    } finally { restore(); delete process.env.MGM_INDEX_CONFIG; }
  });

  test("declining the rebuild warns that search is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-set-"));
    const restore = stubFetch({ "/api/v0/models": () => ({ data: [{ id: "other-embed", type: "embeddings" }] }) });
    try {
      const { pi, ctx, calls, ready } = start(dir);
      await ready;
      ctx.answers.push("Settings", "Embedding model", "other-embed", "Later", "Back", "Close panel");
      await pi.commands.get("index")!.handler("", ctx);
      assert.equal(calls.filter((c) => c.name === "index_codebase").length, 0, "nothing rebuilt");
      assert.match(ctx.notices.map((n: any) => n.msg).join("\n"), /stay stale until the index is rebuilt/);
    } finally { restore(); delete process.env.MGM_INDEX_CONFIG; }
  });

  test("dimensions can be measured from the server, and a dead server says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-set-"));
    let ok = true;
    const restore = stubFetch({
      "/embeddings": () => (ok ? { data: [{ embedding: new Array(1024).fill(0.1) }] } : new Error("connection refused")),
      "/api/v0/models": () => ({ data: [] }),
    });
    try {
      const { pi, ctx, userConfig, ready } = start(dir);
      await ready;
      // a new dimension count invalidates the stored vectors, so the rebuild prompt comes up too
      ctx.answers.push("Settings", "Dimensions", "Detect from the server", "Later", "Back", "Close panel");
      await pi.commands.get("index")!.handler("", ctx);
      assert.equal(read(userConfig).customProvider.dimensions, 1024);
      assert.match(ctx.notices.map((n: any) => n.msg).join("\n"), /returns 1024 dimensions/);
      ok = false;
      const again = start(dir); await again.ready;
      again.ctx.answers.push("Settings", "Dimensions", "Detect from the server", "Back", "Close panel");   // no prompt: nothing was saved
      await again.pi.commands.get("index")!.handler("", again.ctx);
      assert.match(again.ctx.notices.map((n: any) => n.msg).join("\n"), /Could not measure the embedding/);
    } finally { restore(); delete process.env.MGM_INDEX_CONFIG; }
  });

  test("settings can be copied into the project, which then overrides the user file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-set-"));
    const { pi, ctx, ready } = start(dir);
    await ready;
    ctx.answers.push("Settings", "Max results", "33", "Copy these settings into this project", "Back", "Close panel");
    await pi.commands.get("index")!.handler("", ctx);
    const projectFile = join(ctx.cwd, ".codebase-index", "config.json");
    assert.equal(read(projectFile).search.maxResults, 33);
    assert.match(ctx.notices.map((n: any) => n.msg).join("\n"), /now overrides your user settings/);
    delete process.env.MGM_INDEX_CONFIG;
  });
});

describe("reranking (router only)", () => {
  const field = (label: string) => FIELDS.find((f) => f.label === label)!;

  test("the dialog offers exactly two rerank fields: on/off and the model", () => {
    assert.deepEqual(FIELDS.filter((f) => f.path[0] === "reranker").map((f) => f.label), ["Reranking", "Rerank model"]);
    assert.equal(FIELDS.find((f) => f.label === "Rerank key"), undefined, "no key to type: the router key comes from the environment");
    assert.equal(FIELDS.find((f) => f.label === "Rerank provider"), undefined);
  });

  test("routerFromEnv prefers the agent key and trims the URL", () => {
    assert.deepEqual(routerFromEnv({ LITELLM_BASE_URL: "https://r/v1/", LITELLM_AGENT_KEY: "sk-agent", LITELLM_API_KEY: "sk-general" }), { baseUrl: "https://r/v1", apiKey: "sk-agent" });
    assert.deepEqual(routerFromEnv({ LITELLM_BASE_URL: "https://r/v1", LITELLM_API_KEY: "sk-general" }), { baseUrl: "https://r/v1", apiKey: "sk-general" });
    assert.deepEqual(routerFromEnv({}), { baseUrl: undefined, apiKey: undefined });
  });

  test("rerankerBlock is complete, so the package has everything it validates", () => {
    const block = rerankerBlock({ baseUrl: "https://r/v1", apiKey: "sk-k" }, "voyage/rerank-3-lite");
    assert.deepEqual(block, { enabled: true, provider: "custom", baseUrl: "https://r/v1", model: "voyage/rerank-3-lite", apiKey: "sk-k" });
    assert.equal(rerankerProblem({ reranker: block }, { baseUrl: "https://r/v1", apiKey: "sk-k" }), undefined);
  });

  test("rerankerProblem names what is missing, including a router that is not configured", () => {
    const router = { baseUrl: "https://r/v1", apiKey: "sk-k" };
    assert.equal(rerankerProblem({}, router), undefined, "off means nothing to check");
    assert.match(rerankerProblem({ reranker: { enabled: true } }, {})!, /needs the LiteLLM router; run \/setup/);
    assert.match(rerankerProblem({ reranker: { enabled: true } }, router)!, /no rerank model is chosen/);
    assert.match(rerankerProblem({ reranker: { enabled: true, model: "m" } }, router)!, /endpoint or key is missing/);
    assert.equal(rerankerProblem({ reranker: { enabled: true, provider: "cohere", model: "m", apiKey: "k" } }, router), undefined, "a hand-set hosted provider is left alone");
  });

  test("a stored block follows the environment, so rotating the router key needs no visit", () => {
    const stored = { reranker: { enabled: true, provider: "custom", baseUrl: "https://r/v1", model: "m", apiKey: "sk-old" } };
    const rotated = refreshRouterKey(stored, { baseUrl: "https://r/v1", apiKey: "sk-new" });
    assert.equal(rotated!.reranker.apiKey, "sk-new");
    assert.equal(rotated!.reranker.model, "m", "the model is left alone");
    assert.equal(refreshRouterKey(stored, { baseUrl: "https://r/v1", apiKey: "sk-old" }), undefined, "nothing to do when they match");
    assert.equal(refreshRouterKey({ reranker: { enabled: false } }, { baseUrl: "https://r/v1", apiKey: "sk-new" }), undefined, "off stays off");
    assert.equal(refreshRouterKey({ reranker: { enabled: true, provider: "cohere", apiKey: "own" } }, { baseUrl: "https://r/v1", apiKey: "sk-new" }), undefined, "a hosted provider's key is not overwritten");
    assert.equal(refreshRouterKey(stored, {}), undefined, "no router in the environment, nothing to copy");
  });

  test("a key is reported masked and reranking never invalidates the index", () => {
    assert.equal(maskSecret("sk-1234567890abcd"), "set (…abcd)");
    assert.equal(maskSecret(""), "—");
    for (const l of ["Reranking", "Rerank model", "Rerank top N"]) assert.equal(invalidatesIndex(field(l)), false, l);
  });
});

describe("/index reranking through the router", async () => {
  const mod = await import("../.pi/extensions/mgm-codebase-index/index.ts");
  const STATUS = `Indexed chunks (all branches): 190\nLocation: /proj/.codebase-index/index\nCurrent branch: main`;

  function start(dir: string, withRouter = true) {
    const pkg = async (pi: any) => {
      const tool = (name: string, text: string) => ({ name, label: name, description: "", parameters: {}, execute: async () => ({ content: [{ type: "text", text }] }) });
      pi.registerTool(tool("index_status", STATUS));
      pi.registerTool(tool("index_codebase", "Rebuilt"));
      pi.registerTool(tool("knowledge_base_list", ""));
    };
    process.env.MGM_INDEX_CONFIG = join(dir, "user", "config.json");
    if (withRouter) { process.env.LITELLM_BASE_URL = "https://litellm.example/v1"; process.env.LITELLM_AGENT_KEY = "sk-router-key-4321"; }
    else { delete process.env.LITELLM_BASE_URL; delete process.env.LITELLM_AGENT_KEY; }
    const pi = makePi();
    const ctx: any = makeCtx({ hasUI: true });
    ctx.cwd = join(dir, "proj"); mkdirSync(ctx.cwd, { recursive: true });
    return { pi, ctx, userConfig: process.env.MGM_INDEX_CONFIG, ready: mod.default(pi as any, { plan: { kind: "prebundled", entry: "fake" }, load: async () => ({ default: pkg }) }) };
  }
  const cleanup = () => { delete process.env.MGM_INDEX_CONFIG; delete process.env.LITELLM_BASE_URL; delete process.env.LITELLM_AGENT_KEY; };
  const ROUTER_MODELS = {
    // a router carries several deployments per alias, so names repeat in its listing
    "/model/info": () => ({ data: [
      { model_name: "voyage/rerank-3-lite", model_info: { mode: "rerank" } },
      { model_name: "voyage/rerank-3", model_info: { mode: "rerank" } },
      { model_name: "voyage/rerank-3-lite", model_info: { mode: "rerank" } },
      { model_name: "gpt-5.4-nano", model_info: { mode: "chat" } },
    ] }),
  };

  test("turning reranking on asks only for the model and writes the whole block from the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-rr-"));
    const restore = stubFetch(ROUTER_MODELS);
    try {
      const { pi, ctx, userConfig, ready } = start(dir);
      await ready;
      ctx.answers.push("Settings", "Reranking", "on", "voyage/rerank-3-lite", "Back", "Close panel");
      await pi.commands.get("index")!.handler("", ctx);
      const saved = JSON.parse(readFileSync(userConfig!, "utf8"));
      assert.deepEqual(saved.reranker, { enabled: true, provider: "custom", baseUrl: "https://litellm.example/v1", model: "voyage/rerank-3-lite", apiKey: "sk-router-key-4321" });
      assert.equal(statSync(userConfig!).mode & 0o777, 0o600, "a file holding a key is owner-only");
      const said = ctx.notices.map((n: any) => n.msg).join("\n");
      assert.match(said, /billed to the router key \(set \(…4321\)\)/);
      assert.ok(!said.includes("sk-router-key-4321"), "the key itself is never printed");
    } finally { restore(); cleanup(); }
  });

  test("only the router's rerank deployments are offered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-rr-"));
    const restore = stubFetch(ROUTER_MODELS);
    try {
      const { pi, ctx, ready } = start(dir);
      await ready;
      const seen: string[][] = [];
      const select = ctx.ui.select;
      ctx.ui.select = async (title: string, options: string[]) => { seen.push(options); return select(title, options); };
      ctx.answers.push("Settings", "Rerank model", "voyage/rerank-3", "Back", "Close panel");
      await pi.commands.get("index")!.handler("", ctx);
      const offered = seen.find((o) => o.includes("voyage/rerank-3"))!;
      assert.deepEqual(offered, ["voyage/rerank-3", "voyage/rerank-3-lite", "type another id"], "deduplicated, sorted, and chat models are not rerank models");
    } finally { restore(); cleanup(); }
  });

  test("switching reranking off keeps the model but stops the pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-rr-"));
    const restore = stubFetch(ROUTER_MODELS);
    try {
      const { pi, ctx, userConfig, ready } = start(dir);
      await ready;
      ctx.answers.push("Settings", "Reranking", "on", "voyage/rerank-3-lite", "Reranking", "off", "Back", "Close panel");
      await pi.commands.get("index")!.handler("", ctx);
      const saved = JSON.parse(readFileSync(userConfig!, "utf8"));
      assert.equal(saved.reranker.enabled, false);
      assert.equal(saved.reranker.model, "voyage/rerank-3-lite", "the choice is remembered for next time");
    } finally { restore(); cleanup(); }
  });

  test("without a router configured, reranking says what to do instead of writing anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-idx-rr-"));
    const { pi, ctx, userConfig, ready } = start(dir, false);
    await ready;
    const before = readFileSync(userConfig!, "utf8");
    ctx.answers.push("Settings", "Reranking", "on", "Back", "Close panel");
    await pi.commands.get("index")!.handler("", ctx);
    assert.equal(ctx.notices.at(-1)!.type, "error");
    assert.match(ctx.notices.at(-1)!.msg, /runs on the LiteLLM router; run \/setup/);
    assert.equal(readFileSync(userConfig!, "utf8"), before, "nothing written");
    cleanup();
  });
});
