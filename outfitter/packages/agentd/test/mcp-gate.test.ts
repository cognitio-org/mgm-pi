// #493: the image ships `gcloud` disabled; agentd enables it only when run.spec.mcp lists it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMcpGate } from "../src/mcp-gate.js";

const IMAGE = {
  mcpServers: {
    litellm: { url: "https://router.test/mcp/" },
    sentry: { url: "https://router.test/sentry/mcp", auth: false },
    gcloud: { url: "https://router.test/gcloud/mcp", auth: false, disabled: true },
  },
};

async function dirWith(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-gate-"));
  await writeFile(join(dir, "mcp.json"), JSON.stringify(config));
  return dir;
}

async function servers(dir: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(join(dir, "mcp.json"), "utf8")).mcpServers;
}

test("enable: [gcloud] switches gcloud on and touches nothing else", async () => {
  const dir = await dirWith(IMAGE);
  const result = await applyMcpGate(dir, ["gcloud"]);
  assert.deepEqual(result, { enabled: ["gcloud"], disabled: [] });
  const s = await servers(dir);
  assert.equal(s.gcloud!.disabled, undefined);
  assert.equal(s.gcloud!.url, "https://router.test/gcloud/mcp");
  assert.deepEqual(s.sentry, IMAGE.mcpServers.sentry);
  assert.deepEqual(s.litellm, IMAGE.mcpServers.litellm);
});

test("no enable list (an older api, a non-operator run) leaves gcloud off and rewrites nothing", async () => {
  const dir = await dirWith(IMAGE);
  assert.equal(await applyMcpGate(dir, undefined), undefined);
  assert.equal(await applyMcpGate(dir, []), undefined);
  assert.equal((await servers(dir)).gcloud!.disabled, true);
});

test("a gated server found on is switched off again when the run doesn't list it", async () => {
  const dir = await dirWith({ mcpServers: { gcloud: { url: "https://router.test/gcloud/mcp" } } });
  assert.deepEqual(await applyMcpGate(dir, []), { enabled: [], disabled: ["gcloud"] });
  assert.equal((await servers(dir)).gcloud!.disabled, true);
});

test("names agentd doesn't gate are ignored, whatever run.spec says", async () => {
  const dir = await dirWith({ mcpServers: { ...IMAGE.mcpServers, secret: { url: "https://x.test", disabled: true } } });
  await applyMcpGate(dir, ["secret", "sentry"]);
  const s = await servers(dir);
  assert.equal(s.secret!.disabled, true);
  assert.equal(s.gcloud!.disabled, true);
});

test("a missing or broken mcp.json never throws", async () => {
  const logs: string[] = [];
  assert.equal(await applyMcpGate(undefined, ["gcloud"]), undefined);
  const empty = await mkdtemp(join(tmpdir(), "mcp-gate-"));
  assert.equal(await applyMcpGate(empty, ["gcloud"], (l) => logs.push(l)), undefined);
  const bad = await mkdtemp(join(tmpdir(), "mcp-gate-"));
  await writeFile(join(bad, "mcp.json"), "{nope");
  assert.equal(await applyMcpGate(bad, ["gcloud"], (l) => logs.push(l)), undefined);
  assert.equal(logs.length, 2);
});
