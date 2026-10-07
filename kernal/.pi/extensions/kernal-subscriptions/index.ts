/**
 * Personal subscription workers (subscriptions.md §5). Registers `subscription_worker` and, while
 * a switch is on, blocks `subagent` launches of the builtins that switch hides. pi loads this
 * file because it is `extensions/kernal-subscriptions/index.ts`. The CLI (`cli.ts`) stays a
 * separate entry that `kernal subscriptions` runs before pi starts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getValue } from "../_shared/central-config.ts";
import { listSubscriptionVendors } from "./client.ts";
import {
  blockHiddenSubagent, executeSubscriptionWorker, followAfter, mcpServersFrom, subscriptionSystemNote, withSubscriptionNote,
} from "./dispatch.ts";
import { localVendorLogin } from "./local-login.ts";
import { runSubscriptionWorker } from "./runner.ts";
import { hiddenSubscriptionAgents, SUBSCRIPTION_VENDORS, type SubscriptionVendor } from "./vendors.ts";

function modeOf(key: string): string {
  try {
    const value = getValue(key);
    return typeof value === "string" ? value : "off";
  } catch {
    return "off";
  }
}

function hiddenNow(): string[] {
  return hiddenSubscriptionAgents({ claude: modeOf("subscriptions.claude"), codex: modeOf("subscriptions.codex") });
}

function loadMcp(cwd: string | undefined): Record<string, unknown> {
  const texts: string[] = [];
  const agent = process.env.PI_CODING_AGENT_DIR;
  const files = [agent ? join(agent, "mcp.json") : "", cwd ? join(cwd, ".pi", "mcp.json") : ""];
  for (const file of files) {
    if (!file) continue;
    try {
      texts.push(readFileSync(file, "utf8"));
    } catch {
      // no file
    }
  }
  return mcpServersFrom(texts);
}

async function follow(vendor: SubscriptionVendor) {
  const prefer = getValue("subscriptions.prefer");
  const modes = {
    claude: modeOf("subscriptions.claude"),
    grok: modeOf("subscriptions.grok"),
    codex: modeOf("subscriptions.codex"),
    gemini: modeOf("subscriptions.gemini"),
  };
  const signed = new Set<string>();
  for (const id of SUBSCRIPTION_VENDORS) {
    if (localVendorLogin(id)) signed.add(id);
  }
  const list = await listSubscriptionVendors({});
  if (list.ok) {
    for (const id of list.vendors) signed.add(id);
  }
  return followAfter(vendor, typeof prefer === "string" ? prefer : "claude,grok,codex,gemini", modes, signed);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subscription_worker",
    label: "Subscription worker",
    description: "Run this person's Claude plan for one task. One shot: the CLI session is not saved. Use it for coding or review when subscriptions.claude is sandboxed or full, before the worker or reviewer subagents. Scout and researcher stay on the router. If the result says the plan window is spent, use a router subagent. Do not pass an API key. grok, codex, and gemini have no runner in this slice.",
    promptSnippet: "subscription_worker: this person's Claude plan, one shot, when subscriptions.claude is not off. Scout and researcher stay on the router.",
    parameters: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "The task. Project instructions are the CLI's when the mode is full." },
        vendor: { type: "string", enum: ["claude", "grok", "codex", "gemini"], description: "Defaults to claude. Other vendors answer that they have no runner." },
        memoryBrief: { type: "string", description: "Optional memory the coordinator already has. Prepended only in full mode. Not a credential." },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>, _signal: unknown, _update: unknown, ctx: { cwd?: string }) => {
      const out = await executeSubscriptionWorker(params ?? {}, {
        run: (vendor, input) => runSubscriptionWorker(vendor, input),
        cwd: ctx?.cwd,
        mcpServers: loadMcp(ctx?.cwd),
        follow,
      });
      return { content: [{ type: "text", text: out.text }], isError: out.isError };
    },
  } as any);

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const eventCwd = typeof (event as { cwd?: unknown }).cwd === "string" ? (event as { cwd: string }).cwd : "";
    const ctxCwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
    const cwd = eventCwd.trim() || ctxCwd.trim() || process.cwd();
    return blockHiddenSubagent(event.input, hiddenNow(), { cwd });
  });

  pi.on("before_agent_start", async (event) => {
    const note = subscriptionSystemNote({ claude: modeOf("subscriptions.claude"), codex: modeOf("subscriptions.codex") });
    if (!note) return;
    const options = event.systemPromptOptions;
    options.appendSystemPrompt = withSubscriptionNote(options.appendSystemPrompt, note);
    if (options.forceSystemPrompt !== undefined) {
      options.forceSystemPrompt = withSubscriptionNote(options.forceSystemPrompt, note);
    }
  });
}
