/**
 * Subagent model defaults. Children would otherwise inherit the chat default, the cheapest route on
 * the router, which is fine for chatting and useless for judgement. These checks run the package's
 * own discovery code, so they fail if a setting is misspelled or silently ignored.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const settings = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8"));

describe("subagent models", () => {
  test("every model is provider-qualified, so resolution cannot drift between providers", () => {
    const sub = settings.subagents;
    assert.ok(sub, "a subagents block exists");
    const models = [sub.defaultModel, ...Object.values(sub.agentOverrides ?? {}).map((o: any) => o.model)];
    for (const m of models) assert.match(m, /^litellm\//, `${m} names its provider`);
  });

  test("no child lands on the chat default", () => {
    const chat = `${settings.defaultProvider}/${settings.defaultModel}`;
    assert.notEqual(settings.subagents.defaultModel, chat);
  });

  test("the package resolves each built-in role to the intended model", async () => {
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi");
    const { discoverAgents } = await import("../.pi/npm/node_modules/pi-subagents/src/agents/agents.js");
    const found: any = discoverAgents(root, "both", "litellm");
    const byName = new Map<string, any>((found.agents ?? found).map((a: any) => [a.name, a]));
    const expect: Record<string, string> = {
      scout: settings.subagents.defaultModel,
      researcher: settings.subagents.defaultModel,
      delegate: settings.subagents.defaultModel,
      worker: "litellm/claude-sonnet-5",
      reviewer: "litellm/claude-sonnet-5",
      oracle: "litellm/claude-opus-5-high",
    };
    for (const [name, model] of Object.entries(expect)) {
      assert.equal(byName.get(name)?.model, model, `${name} resolves to ${model}`);
    }
  });
});
