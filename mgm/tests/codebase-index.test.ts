/** mgm-codebase-index: how the indexer is loaded in each runtime, and the embedding defaults. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, defaultConfig, embeddingBaseUrl, shouldSeed, DEFAULT_EMBEDDING_MODEL, DEFAULT_DIMENSIONS } from "../.pi/extensions/mgm-codebase-index/lib.ts";

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
