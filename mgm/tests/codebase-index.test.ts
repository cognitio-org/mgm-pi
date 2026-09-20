/** mgm-codebase-index: how the indexer is loaded in each runtime, and the embedding defaults. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, defaultConfig, embeddingBaseUrl, shouldSeed, parseStatus, resultText, configView, panelRows, indexStatusLine, actions, SUBCOMMANDS, DEFAULT_EMBEDDING_MODEL, DEFAULT_DIMENSIONS } from "../.pi/extensions/mgm-codebase-index/lib.ts";
import { makePi, makeCtx } from "./harness.ts";

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
