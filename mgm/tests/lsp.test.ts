/** `.pi/agent/lsp.json` is data, not code: these cover the parts pi-lsp fails silently on. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, ".pi/agent/lsp.json"), "utf8"));
const launcher = readFileSync(join(root, "bin/mgm"), "utf8");
const packager = readFileSync(join(root, "scripts/package.sh"), "utf8");
const byId = new Map<string, any>(config.servers.map((s: any) => [s.id, s]));
// The only placeholders _shared/template.ts substitutes; anything else is left in the path verbatim.
const PLACEHOLDERS = /\{(workspace|root|file|relFile|dir|relDir|config|configDir)\}/g;

describe("pi-lsp configuration", () => {
  test("declares the three languages mgm works in, each with a stdio binary", () => {
    assert.equal(config.version, 1);
    assert.deepEqual([...byId.keys()], ["typescript", "python", "rust"]);
    assert.deepEqual(
      [...byId.values()].map((s) => [s.id, s.enabled, s.bin, (s.args ?? []).join(" ")]),
      [
        ["typescript", true, "typescript-language-server", "--stdio"],
        ["python", true, "pyright-langserver", "--stdio"],
        ["rust", true, "rust-analyzer", ""],
      ],
    );
  });

  test("every enabled server survives pi-lsp's parser and its cwd template", () => {
    for (const server of config.servers) {
      // parseLspItems() drops an enabled entry whose bin is empty, without a warning.
      assert.ok(typeof server.bin === "string" && server.bin.trim(), `${server.id}: bin`);
      assert.ok(Array.isArray(server.include) && server.include.length, `${server.id}: include`);
      assert.ok(Array.isArray(server.rootMarkers) && server.rootMarkers.length, `${server.id}: rootMarkers`);
      // An unknown placeholder is not expanded, so the server would start in a nonexistent directory.
      assert.equal(server.cwd.replace(PLACEHOLDERS, ""), "", `${server.id}: cwd placeholders`);
      assert.ok(server.startupTimeoutMs >= 30_000, `${server.id}: startupTimeoutMs`);
      assert.ok(server.diagnosticsWaitMs >= 1_500, `${server.id}: diagnosticsWaitMs`);
    }
    // rust-analyzer's diagnostics come from cargo check, which needs several seconds on a cold start.
    assert.ok(byId.get("rust").diagnosticsWaitMs >= 6_000, "rust waits for cargo check");
  });

  test("every extension the include globs match has a language id", () => {
    for (const server of config.servers) {
      const extensions = server.include.map((glob: string) => glob.replace(/^.*(\.[^.]+)$/, "$1"));
      for (const extension of extensions) {
        assert.ok(
          server.languageIdByExtension?.[extension],
          `${server.id}: ${extension} is included but has no languageId (pi-lsp would send "${extension.slice(1)}")`,
        );
      }
    }
  });

  test("the config is shipped and reachable: PI_AGENT_DIR in the launcher, lsp.json in the bundle", () => {
    // pi-lsp looks for its own config under $PI_AGENT_DIR (default ~/.pi/agent, which mgm does not
    // use). Pointing it at .pi/agent makes lsp.json the auto-trusted global layer, and keeps it out
    // of the walk-up for a project-local .pi/lsp.json, which needs trust and is refused in -p mode.
    assert.match(launcher, /^export PI_AGENT_DIR="\$ROOT\/\.pi\/agent"$/m);
    assert.match(packager, /cp "\$ROOT\/\.pi\/agent\/lsp\.json" "\$STAGE\/\.pi\/agent\/"/);
  });
});
