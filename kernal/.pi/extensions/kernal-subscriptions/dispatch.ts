/**
 * How the coordinator reaches the Claude runner (subscriptions.md §5).
 *
 * pi can block a tool call, not replace it. While a subscription switch is on, a `subagent` launch
 * of that vendor's builtin is blocked so pi-subagents cannot start it with an API key. The model
 * calls `subscription_worker` instead. Only Claude runs in this slice. An exhausted Claude result
 * names the rest of `subscriptions.prefer` and then the router. It does not spawn the next vendor
 * and it does not retry with an API key.
 */
import { subscriptionPlan, type SubscriptionRunResult } from "./runner.ts";
import { isVendor, type SubscriptionVendor } from "./vendors.ts";

/** Inspection actions. They name an agent and do not start it. */
const INSPECT = new Set(["list", "get", "models", "status", "guide", "capabilities"]);

export function subscriptionSystemNote(modes: { claude?: string; codex?: string }): string | undefined {
  const parts: string[] = [];
  if (modes.claude && modes.claude !== "off") {
    parts.push(
      "subscriptions.claude is on. For coding or review, call subscription_worker before the worker or reviewer subagents. " +
      "It runs this person's Claude plan, one shot, with no saved CLI session. Do not call the subagent agents claude-code or claude-code-writer. " +
      "Scout and researcher stay on the router. If subscription_worker says the plan window is spent, use a router subagent. Do not retry Claude with an API key.",
    );
  }
  if (modes.codex && modes.codex !== "off") {
    parts.push(
      "subscriptions.codex is on. Do not call the subagent agents codex-exec or codex-exec-writer. " +
      "This slice has no Codex runner, so that work stays on a router subagent.",
    );
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Existing append text, a blank line, then the note. With no note, the append is unchanged. */
export function withSubscriptionNote(append: string | undefined, note: string | undefined): string | undefined {
  if (!note) return append;
  return append ? `${append}\n\n${note}` : note;
}

function blockReason(agent: string): string {
  if (agent === "claude-code" || agent === "claude-code-writer") {
    return `${agent} is hidden while subscriptions.claude is on. Call subscription_worker with the task. That spends this person's Claude plan. Do not launch this builtin.`;
  }
  return `${agent} is hidden while subscriptions.codex is on. This slice has no Codex runner, so use a router subagent. Do not launch this builtin.`;
}

/** `agent: "claude-code"` inside a workflow script or its args. Quoted or bare key. */
function agentNamedIn(source: string, hidden: ReadonlySet<string>): string | undefined {
  const re = /(?:^|[^A-Za-z0-9_])["']?agent["']?\s*:\s*["']([a-z0-9-]+)["']/g;
  for (const match of source.matchAll(re)) {
    if (hidden.has(match[1])) return match[1];
  }
  return undefined;
}

function scriptSource(input: Record<string, unknown>): string {
  const script = typeof input.workflowScript === "string" ? input.workflowScript : "";
  if (input.args === undefined) return script;
  try {
    return `${script}\n${JSON.stringify(input.args)}`;
  } catch {
    return script;
  }
}

/**
 * Block a `subagent` call that would start a hidden builtin. List, get, models, status, and guide
 * still run; their text is rewritten elsewhere. An empty hide list blocks nothing.
 */
export function blockHiddenSubagent(
  input: unknown,
  hidden: readonly string[],
): { block: true; reason: string } | undefined {
  if (!hidden.length || !input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action.trim() : "";
  if (INSPECT.has(action)) return undefined;
  const hiddenSet = new Set(hidden);
  const direct = typeof record.agent === "string" ? record.agent.trim() : "";
  if (direct && hiddenSet.has(direct)) return { block: true, reason: blockReason(direct) };
  if (action) return undefined;
  const named = agentNamedIn(scriptSource(record), hiddenSet);
  if (named) return { block: true, reason: blockReason(named) };
  return undefined;
}

/** Merge `mcpServers` objects from mcp.json texts. A broken file contributes nothing. */
export function mcpServersFrom(jsonTexts: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const text of jsonTexts) {
    try {
      const parsed = JSON.parse(text) as { mcpServers?: unknown };
      const servers = parsed?.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
      Object.assign(out, servers);
    } catch {
      // missing or broken
    }
  }
  return out;
}

/** The rest of `prefer` after `vendor`, skipping `off`. The caller decides who is signed in. */
export function followAfter(
  vendor: SubscriptionVendor,
  prefer: string,
  modes: Partial<Record<SubscriptionVendor, string>>,
  signedIn: ReadonlySet<string>,
): { vendor: SubscriptionVendor; action: "run" | "connect" }[] {
  return subscriptionPlan(prefer, modes, signedIn).filter((step) => step.vendor !== vendor);
}

/** Text the model reads. `follow` is the prefer walk after an exhausted vendor. */
export function subscriptionToolText(
  result: SubscriptionRunResult,
  follow: readonly { vendor: SubscriptionVendor; action: "run" | "connect" }[] = [],
): { text: string; isError: boolean } {
  if (result.kind === "ok") return { text: result.text, isError: false };
  if (result.kind !== "exhausted") return { text: result.text, isError: true };
  const lines = [result.text, "Do not retry with an API key."];
  for (const step of follow) {
    if (step.action === "connect") {
      lines.push(`${step.vendor} is next in subscriptions.prefer and is not signed in. Ask this person to connect it.`);
    } else if (step.vendor === "claude") {
      lines.push("claude is next and signed in, and this window is already spent.");
    } else {
      lines.push(`${step.vendor} is next in subscriptions.prefer, but this slice has no ${step.vendor} runner.`);
    }
  }
  lines.push("Use a router subagent for this task.");
  return { text: lines.join(" "), isError: true };
}

export interface SubscriptionToolDeps {
  run?: (vendor: SubscriptionVendor, input: { prompt: string; cwd?: string; memoryBrief?: string; mcpServers?: Record<string, unknown> }) => Promise<SubscriptionRunResult>;
  cwd?: string;
  mcpServers?: Record<string, unknown>;
  /** Called only after an exhausted run. A throw becomes no follow-up. */
  follow?: (vendor: SubscriptionVendor) => Promise<{ vendor: SubscriptionVendor; action: "run" | "connect" }[]>;
}

/** The `subscription_worker` tool body. Vendor defaults to claude. */
export async function executeSubscriptionWorker(
  params: Record<string, unknown>,
  deps: SubscriptionToolDeps = {},
): Promise<{ text: string; isError: boolean }> {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) return { text: "subscription_worker needs a prompt.", isError: true };
  const vendorRaw = typeof params.vendor === "string" && params.vendor.trim() ? params.vendor.trim() : "claude";
  if (!isVendor(vendorRaw)) return { text: "vendor must be claude, grok, codex, or gemini.", isError: true };
  const memoryBrief = typeof params.memoryBrief === "string" ? params.memoryBrief : undefined;
  const run = deps.run;
  if (!run) return { text: "subscription_worker is not wired to a runner.", isError: true };
  const result = await run(vendorRaw, { prompt, cwd: deps.cwd, memoryBrief, mcpServers: deps.mcpServers });
  let follow: { vendor: SubscriptionVendor; action: "run" | "connect" }[] = [];
  if (result.kind === "exhausted" && deps.follow) {
    try {
      follow = await deps.follow(vendorRaw);
    } catch {
      follow = [];
    }
  }
  return subscriptionToolText(result, follow);
}
