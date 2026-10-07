/**
 * Subagent model defaults. Children would otherwise inherit the chat default, the cheapest route on
 * the router, which is fine for chatting and useless for judgement. These checks run the package's
 * own discovery code, so they fail if a setting is misspelled or silently ignored.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

  const agentsModule = join(root, ".pi", "npm", "node_modules", "pi-subagents", "src", "agents", "agents.js");
  test("the package resolves each built-in role to the intended model", { skip: !existsSync(agentsModule) && "extension packages not installed (npm ci in .pi/npm)" }, async () => {
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

describe("command-line agents in the subagent tool's own output", () => {
  const mgmtModule = join(root, ".pi", "npm", "node_modules", "pi-subagents", "src", "agents", "agent-management.js");
  const skip = !existsSync(mgmtModule) && "extension packages not installed (npm ci in .pi/npm)";
  const run = async (params: any) => {
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi");
    const m = await import("../.pi/npm/node_modules/pi-subagents/src/agents/agent-management.js");
    const ctx = { cwd: root, model: { provider: "litellm" }, modelRegistry: { getAvailable: () => [] } };
    return m.handleManagementAction(params.action, params, ctx).content[0].text as string;
  };

  test("list: the router model is replaced with the tool's own, other agents are untouched", { skip }, async () => {
    const { annotateSubagentText, CLI_NOTE } = await import("../.pi/extensions/kernal-subagents/lib.ts");
    const raw = await run({ action: "list", capabilities: true });
    assert.match(raw, /- claude-code \(builtin, external-cli:claude[^)]*\):.*Model: litellm\//, "the package still prints the router model (if not, this fix can go)");
    const out = annotateSubagentText(raw);
    const line = (name: string) => out.split("\n").find((l) => l.startsWith(`- ${name} (`))!;
    assert.match(line("claude-code"), /Model: Claude Code's own \(set in Claude Code; Kernal's model settings do not apply\)/);
    assert.match(line("codex-exec-writer"), /Tools: Codex's own, as its adapter allows; Model: Codex's own/);
    assert.match(line("codex-exec-writer"), /Acceptance role: writer$/, "fields after the model are kept");
    assert.doesNotMatch(line("cursor-agent"), /litellm\/|Thinking:/);
    for (const name of ["scout", "worker", "oracle"]) {
      const before = raw.split("\n").find((l) => l.startsWith(`- ${name} (`));
      assert.equal(line(name), before, `${name} passes through unchanged`);
    }
    assert.equal(out.split("\n")[1], CLI_NOTE, "one note, right under the heading");
    assert.equal(annotateSubagentText(out), out, "running it again changes nothing");
  });

  test("plain list and get are corrected too; text without command-line agents is returned as is", { skip }, async () => {
    const { annotateSubagentText } = await import("../.pi/extensions/kernal-subagents/lib.ts");
    const list = annotateSubagentText(await run({ action: "list" }));
    assert.match(list, /- cursor-agent \(builtin, external-cli:cursor-agent\): .* \[runs the Cursor CLI with its own login and model\]/);
    const get = annotateSubagentText(await run({ action: "get", agent: "claude-code-writer" }));
    assert.match(get, /^Model: Claude Code's own/m);
    assert.match(get, /^Runner: external-cli claude \(the Claude Code CLI: its own login, model and tools\)$/m);
    const scout = await run({ action: "get", agent: "scout" });
    assert.equal(annotateSubagentText(scout), scout);
  });

  test("edge cases: idempotent, excludes, a description holding field names, a prompt holding a Runner line", async () => {
    const { annotateSubagentText } = await import("../.pi/extensions/kernal-subagents/lib.ts");
    const plain = "Executable agents:\n- claude-code (builtin, external-cli:claude): Read-only";
    assert.equal(annotateSubagentText(annotateSubagentText(plain)), annotateSubagentText(plain), "plain list: one suffix");
    const cap = "Executable agents (capabilities):\n- mine (user, external-cli:codex ✓): Description: says; Model: x; Tools: y; Tools: read, bash; excludes: write, edit; Model: litellm/a; Thinking: high; Acceptance role: writer";
    const line = annotateSubagentText(cap).split("\n").at(-1)!;
    assert.equal(line, "- mine (user, external-cli:codex ✓): Description: says; Model: x; Tools: y; Tools: Codex's own, as its adapter allows; Model: Codex's own (set in Codex; Kernal's model settings do not apply); Acceptance role: writer");
    const get = "Agent: docs (user)\nModel: litellm/a\nThinking: low\n\nSystem Prompt:\nRunner: external-cli claude\nexplains CLI agents";
    assert.equal(annotateSubagentText(get), get, "a Runner line inside the prompt is prompt text");
    const real = "Agent: cc (user)\nModel: litellm/a\nRunner: external-cli claude\n\nSystem Prompt:\nModel: keep this";
    const once = annotateSubagentText(real);
    assert.equal(annotateSubagentText(once), once, "get: one suffix");
    assert.match(once, /System Prompt:\nModel: keep this$/, "the prompt is never edited");
  });

  test("models: the tool's own model for command-line agents, from the package's discovery", { skip }, async () => {
    const { annotateSubagentText, discoverCliNames } = await import("../.pi/extensions/kernal-subagents/lib.ts");
    const cli = await discoverCliNames(root);
    assert.equal(cli?.get("codex-exec"), "codex");
    assert.ok(!cli?.has("scout"));
    const all = await run({ action: "models" });
    const out = annotateSubagentText(all, cli);
    assert.match(out, /\ncodex-exec\n  model:\n    Codex's own \(set in Codex; Kernal's model settings do not apply\)\n  source: the Codex CLI \(codex\)\n  thinking: Codex's own\n/);
    assert.match(out, /\nscout\n  model:\n    litellm\//, "normal agents keep their model");
    assert.equal(annotateSubagentText(out, cli), out);
    const one = annotateSubagentText(await run({ action: "models", agent: "claude-code" }), cli);
    assert.match(one, /Effective model:\n  Claude Code's own .*\nSource: the Claude Code CLI \(claude\)\nThinking: Claude Code's own/);
    assert.equal(annotateSubagentText(await run({ action: "models" })), all, "without discovery, models output is left alone");
  });

  test("the extension rewrites subagent list and get results only", async () => {
    const handlers: Function[] = [];
    const mod = await import("../.pi/extensions/kernal-subagents/index.ts");
    mod.default({ on: (ev: string, h: Function) => { if (ev === "tool_result") handlers.push(h); } } as any);
    assert.equal(handlers.length, 1);
    const text = "Executable agents:\nBuiltin agents\n- claude-code (builtin, external-cli:claude): Read-only";
    const ev = (over: any) => ({ toolName: "subagent", input: { action: "list" }, content: [{ type: "text", text }], isError: false, ...over });
    const r = await handlers[0](ev({}));
    assert.match(r.content[0].text, /runs the Claude Code CLI/);
    assert.equal(await handlers[0](ev({ toolName: "bash" })), undefined, "another tool");
    assert.equal(await handlers[0](ev({ input: { action: "run", agent: "claude-code" } })), undefined, "a run");
    assert.equal(await handlers[0](r), undefined, "an already corrected result");
    assert.equal(await handlers[0](ev({ isError: true })), undefined, "an error");
    assert.equal(await handlers[0](ev({ content: [{ type: "text", text: "- scout (builtin): recon" }] })), undefined, "nothing to correct");
  });

  test("a subscription that is not off hides that vendor's builtins; off leaves them", async () => {
    const { annotateSubagentText } = await import("../.pi/extensions/kernal-subagents/lib.ts");
    const { hiddenSubscriptionAgents } = await import("../.pi/extensions/kernal-subscriptions/vendors.ts");
    const text = [
      "Executable agents:",
      "- claude-code (builtin, external-cli:claude): Read-only",
      "- claude-code-writer (builtin, external-cli:claude): Writes",
      "- codex-exec (builtin, external-cli:codex): Read-only",
      "- codex-exec-writer (builtin, external-cli:codex): Writes",
      "- cursor-agent (builtin, external-cli:cursor-agent): Cursor",
      "- scout (builtin): recon",
    ].join("\n");
    const off = annotateSubagentText(text, undefined, hiddenSubscriptionAgents({ claude: "off", codex: "off" }));
    assert.match(off, /^- claude-code \(builtin/m);
    assert.match(off, /^- codex-exec-writer \(builtin/m);
    const claudeOn = annotateSubagentText(text, undefined, hiddenSubscriptionAgents({ claude: "sandboxed", codex: "off" }));
    assert.doesNotMatch(claudeOn, /^- claude-code /m);
    assert.doesNotMatch(claudeOn, /^- claude-code-writer /m);
    assert.match(claudeOn, /^- codex-exec \(builtin/m);
    assert.match(claudeOn, /^- codex-exec-writer \(builtin/m);
    assert.match(claudeOn, /^- cursor-agent \(builtin/m);
    assert.match(claudeOn, /^- scout \(builtin/m);
    const both = annotateSubagentText(text, undefined, hiddenSubscriptionAgents({ claude: "full", codex: "full" }));
    assert.doesNotMatch(both, /claude-code|codex-exec/);
    assert.match(both, /^- cursor-agent \(builtin/m);
    assert.equal(annotateSubagentText(both, undefined, hiddenSubscriptionAgents({ claude: "full", codex: "full" })), both);
    const models = "Subagent models\nclaude-code\n  model:\n    litellm/x\n  source: subagents default\ncodex-exec\n  model:\n    litellm/y\nscout\n  model:\n    litellm/z\n";
    const hiddenModels = annotateSubagentText(models, undefined, hiddenSubscriptionAgents({ claude: "full", codex: "sandboxed" }));
    assert.doesNotMatch(hiddenModels, /claude-code|codex-exec/);
    assert.match(hiddenModels, /^scout\n {2}model:\n {4}litellm\/z/m);
    const get = annotateSubagentText("Agent: claude-code-writer\nModel: litellm/a\nRunner: external-cli claude\n", undefined, ["claude-code-writer"]);
    assert.equal(get, "claude-code-writer is hidden while its subscription is on.");
    assert.deepEqual(hiddenSubscriptionAgents({}), []);
  });

  test("the extension applies that hide from the subscription settings", async () => {
    const { _resetCentralConfig, setLocalOverride } = await import("../.pi/extensions/_shared/central-config.ts");
    const handlers: Function[] = [];
    const mod = await import("../.pi/extensions/kernal-subagents/index.ts");
    mod.default({ on: (ev: string, h: Function) => { if (ev === "tool_result") handlers.push(h); } } as any);
    const text = "Executable agents:\n- claude-code (builtin, external-cli:claude): Read-only\n- codex-exec (builtin, external-cli:codex): Read-only\n- scout (builtin): recon";
    const ev = { toolName: "subagent", input: { action: "list" }, content: [{ type: "text", text }], isError: false };
    try {
      setLocalOverride("subscriptions.claude", "full");
      setLocalOverride("subscriptions.codex", "off");
      const r = await handlers[0](ev);
      assert.doesNotMatch(r.content[0].text, /^- claude-code /m);
      assert.match(r.content[0].text, /^- codex-exec /m);
      assert.match(r.content[0].text, /^- scout /m);
    } finally {
      setLocalOverride("subscriptions.claude", undefined);
      setLocalOverride("subscriptions.codex", undefined);
      _resetCentralConfig();
    }
  });
});
