// GA-3 (#493): gcloud is operator-only. It ships disabled with approval on, never reaches Claude
// children, and is switched on for a laptop only when the device's router key lists it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMcpServers } from "../.pi/extensions/kernal-subscriptions/runner.ts";
import { applyLaptopMcpGate } from "../.pi/extensions/_shared/mcp-gate.ts";

const root = new URL("..", import.meta.url).pathname;
const shipped = JSON.parse(readFileSync(`${root}.pi/mcp.json`, "utf8"));

test("the shipped gcloud entry is disabled and asks before every call", () => {
  assert.equal(shipped.mcpServers.gcloud.disabled, true);
  assert.equal(shipped.mcpServers.gcloud.approveTools, true);
});

test("Claude children never get gcloud, nor any disabled server", () => {
  const out = claudeMcpServers({
    gcloud: { url: "https://router.kernal.one/gcloud/mcp", headers: { "x-litellm-api-key": "Bearer x" } },
    off: { url: "https://x.test/mcp", disabled: true },
    on: { url: "https://y.test/mcp" },
  });
  assert.deepEqual(Object.keys(out), ["on"]);
  assert.equal("gcloud" in claudeMcpServers(shipped.mcpServers), false);
  // Even enabled (an operator's gate switched it on), the exclusion holds.
  assert.equal("gcloud" in claudeMcpServers({ gcloud: { url: "https://router.kernal.one/gcloud/mcp" } }), false);
});

function agentDir(): string {
  const base = mkdtempSync(join(tmpdir(), "gate-"));
  const dir = join(base, ".pi");
  mkdirSync(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(shipped));
  return dir;
}
const gcloudOf = (dir: string) => JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.gcloud;

test("a key that lists gcloud switches it on; nothing else changes; no temp files are left", () => {
  const dir = agentDir();
  assert.equal(applyLaptopMcpGate(dir, ["ce_knowledge_base", "gcloud"]), true);
  const after = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
  assert.equal(after.mcpServers.gcloud.disabled, undefined);
  assert.equal(after.mcpServers.gcloud.approveTools, true, "approval stays on");
  assert.deepEqual(after.mcpServers.sentry, shipped.mcpServers.sentry);
  assert.deepEqual(readdirSync(dir), ["mcp.json"]);
  assert.equal(applyLaptopMcpGate(dir, ["gcloud"]), false, "already on: no rewrite");
});

test("a non-operator key, an older Outfitter, or no key leaves gcloud off; an ex-operator's is switched off again", () => {
  const dir = agentDir();
  for (const admitted of [undefined, [], ["sentry"]]) {
    assert.equal(applyLaptopMcpGate(dir, admitted), false);
    assert.equal(gcloudOf(dir).disabled, true);
  }
  applyLaptopMcpGate(dir, ["gcloud"]);
  assert.equal(applyLaptopMcpGate(dir, []), true);
  assert.equal(gcloudOf(dir).disabled, true);
});

test("a source checkout (agent dir beside .git), a missing dir and a broken file are left alone and never throw", () => {
  const dir = agentDir();
  mkdirSync(join(dir, "..", ".git"));
  assert.equal(applyLaptopMcpGate(dir, ["gcloud"]), false);
  assert.equal(gcloudOf(dir).disabled, true);

  assert.equal(applyLaptopMcpGate(undefined, ["gcloud"]), false);
  const bad = join(mkdtempSync(join(tmpdir(), "gate-")), ".pi");
  mkdirSync(bad);
  writeFileSync(join(bad, "mcp.json"), "{nope");
  const logs: string[] = [];
  assert.equal(applyLaptopMcpGate(bad, ["gcloud"], (l) => logs.push(l)), false);
  assert.equal(logs.length, 1);
});
