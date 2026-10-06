/**
 * How the coordinator reaches the Claude runner (subscriptions.md §5).
 *
 * pi can block a tool call, not replace it. While a subscription switch is on, a `subagent` launch
 * of that vendor's builtin is blocked so pi-subagents cannot start it with an API key. A workflow
 * script and `schedule.create` count: the schedule stores the script, and the later run does not
 * come back through this hook. The model calls `subscription_worker` instead. Only Claude runs in
 * this slice. An exhausted Claude result names the rest of `subscriptions.prefer` and then the
 * router. It does not spawn the next vendor and it does not retry with an API key.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { subscriptionPlan, type SubscriptionRunResult } from "./runner.ts";
import { isVendor, type SubscriptionVendor } from "./vendors.ts";

/** Inspection actions. They name an agent and do not start it. */
const INSPECT = new Set(["list", "get", "models", "status", "guide", "capabilities"]);

/** `validate` checks a script and does not start it. */
const VALIDATE = "validate";

/** Stores a script to run later. That later `runs.run` is not another `tool_call`. */
const SCHEDULE_CREATE = "schedule.create";

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

export interface HiddenSubagentIo {
  /** Coordinator cwd. `input.cwd` resolves against it, the same way pi-subagents does. */
  cwd?: string;
  /** Reads the absolute path `loadWorkflowScriptPath` would. Defaults to `readFileSync`. */
  readFile?: (absolutePath: string) => string;
}

/** `requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd`. */
function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
  return requestedCwd ? resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

function runtimeCwdOf(io: HiddenSubagentIo | undefined): string {
  return typeof io?.cwd === "string" && io.cwd.trim() ? io.cwd : process.cwd();
}

function withArgs(script: string, record: Record<string, unknown>): string | undefined {
  if (record.args === undefined) return script;
  try {
    return `${script}\n${JSON.stringify(record.args)}`;
  } catch {
    return undefined;
  }
}

/**
 * File text pi-subagents would run, or the inline script when there is no path.
 * An unreadable or empty file is not known-safe.
 */
function workflowSource(record: Record<string, unknown>, io: HiddenSubagentIo | undefined): string | undefined {
  const requested = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : undefined;
  if (typeof record.workflowScriptPath === "string") {
    const absolute = resolve(resolveRequestedCwd(runtimeCwdOf(io), requested), record.workflowScriptPath);
    try {
      const readFile = io?.readFile ?? ((file: string) => readFileSync(file, "utf8"));
      const text = readFile(absolute);
      if (!text.trim()) return undefined;
      return withArgs(text, record);
    } catch {
      return undefined;
    }
  }
  if (typeof record.workflowScript === "string") return withArgs(record.workflowScript, record);
  return undefined;
}

function unknownLaunchReason(hidden: readonly string[]): string {
  const claude = hidden.some((name) => name === "claude-code" || name === "claude-code-writer");
  const codex = hidden.some((name) => name === "codex-exec" || name === "codex-exec-writer");
  if (claude && codex) {
    return "This workflow may launch claude-code, claude-code-writer, codex-exec, or codex-exec-writer. Call subscription_worker for Claude. This slice has no Codex runner, so use a router subagent. Do not launch this builtin.";
  }
  if (claude) {
    return "This workflow may launch claude-code or claude-code-writer while subscriptions.claude is on. Call subscription_worker with the task. Do not launch this builtin.";
  }
  if (codex) {
    return "This workflow may launch codex-exec or codex-exec-writer while subscriptions.codex is on. This slice has no Codex runner, so use a router subagent. Do not launch this builtin.";
  }
  return blockReason(hidden[0] ?? "claude-code");
}

/** A hidden builtin named anywhere in the script or args, longest name first so a writer is not read as its prefix. */
function hiddenNameIn(source: string, hidden: ReadonlySet<string>): string | undefined {
  const names = [...hidden].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const body = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9_-])${body}(?![A-Za-z0-9_-])`).test(source)) return name;
  }
  return undefined;
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/**
 * An `agent:` value is safe only as one single- or double-quoted literal.
 * A variable, concatenation, or template is not proof the builtin stays hidden.
 * Returns the hidden literal it saw, and whether any value was not a quoted literal.
 */
function agentLaunchShape(source: string, hidden: ReadonlySet<string>): { literal?: string; dynamic: boolean } {
  let i = 0;
  let dynamic = false;
  let literal: string | undefined;
  const note = (value: string) => {
    const name = value.trim();
    if (!literal && hidden.has(name)) literal = name;
  };

  const skipIgnorable = () => {
    while (i < source.length) {
      const char = source[i];
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f") {
        i++;
        continue;
      }
      if (char === "/" && source[i + 1] === "/") {
        i += 2;
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (char === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i = Math.min(source.length, i + 2);
        continue;
      }
      break;
    }
  };

  const readQuoted = (): string | undefined => {
    const quote = source[i];
    if (quote !== "'" && quote !== '"') return undefined;
    i++;
    let value = "";
    while (i < source.length) {
      const char = source[i++];
      if (char === "\\") {
        if (i >= source.length) return undefined;
        const next = source[i++];
        if (next === "n") value += "\n";
        else if (next === "r") value += "\r";
        else if (next === "t") value += "\t";
        else if (next === "u" && /^[0-9a-fA-F]{4}/.test(source.slice(i, i + 4))) {
          value += String.fromCharCode(Number.parseInt(source.slice(i, i + 4), 16));
          i += 4;
        } else value += next;
        continue;
      }
      if (char === quote) return value;
      if (char === "\n") return undefined;
      value += char;
    }
    return undefined;
  };

  const followedByColon = (): boolean => {
    const saved = i;
    skipIgnorable();
    if (source[i] === ":") {
      i++;
      return true;
    }
    i = saved;
    return false;
  };

  const valueIsQuotedLiteral = (): boolean => {
    skipIgnorable();
    if (source[i] !== "'" && source[i] !== '"') return false;
    const value = readQuoted();
    if (value === undefined) return false;
    note(value);
    skipIgnorable();
    const next = source[i];
    return next === undefined || next === "," || next === "}" || next === ")" || next === "]" || next === ";";
  };

  const scanTemplate = (): void => {
    while (i < source.length) {
      const char = source[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "`") {
        i++;
        return;
      }
      if (char === "$" && source[i + 1] === "{") {
        i += 2;
        scanCode(true);
        if (source[i] === "}") i++;
        continue;
      }
      i++;
    }
  };

  const scanCode = (stopBrace: boolean): void => {
    let depth = 0;
    while (i < source.length) {
      skipIgnorable();
      if (i >= source.length) return;
      const char = source[i];
      if (char === "'" || char === '"') {
        const value = readQuoted();
        if (value === undefined) {
          dynamic = true;
          return;
        }
        if (value === "agent" && followedByColon() && !valueIsQuotedLiteral()) dynamic = true;
        continue;
      }
      if (char === "`") {
        i++;
        scanTemplate();
        continue;
      }
      if (char === "[") {
        const saved = i;
        i++;
        skipIgnorable();
        const key = source[i] === "'" || source[i] === '"' ? readQuoted() : undefined;
        skipIgnorable();
        if (key === "agent" && source[i] === "]") {
          i++;
          if (followedByColon() && !valueIsQuotedLiteral()) dynamic = true;
          continue;
        }
        i = saved + 1;
        continue;
      }
      if (char === "{") {
        depth++;
        i++;
        continue;
      }
      if (char === "}") {
        // Only a `${ ... }` expression ends at an unmatched brace. A loose `}` must not hide the rest of the script.
        if (stopBrace && depth === 0) return;
        if (depth > 0) depth--;
        i++;
        continue;
      }
      if (isIdentStart(char)) {
        const start = i;
        i++;
        while (i < source.length && isIdentPart(source[i])) i++;
        if (source.slice(start, i) === "agent" && followedByColon() && !valueIsQuotedLiteral()) dynamic = true;
        continue;
      }
      i++;
    }
  };

  scanCode(false);
  return { literal, dynamic };
}

/**
 * Block a `subagent` call that would start a hidden builtin. List, get, models, status, guide,
 * and capabilities still run. `validate` does not launch. An empty hide list blocks nothing.
 * A workflow script, a script path, or `schedule.create` launches unless the script is known
 * not to name a hidden builtin.
 */
export function blockHiddenSubagent(
  input: unknown,
  hidden: readonly string[],
  io?: HiddenSubagentIo,
): { block: true; reason: string } | undefined {
  if (!hidden.length || !input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action.trim() : "";
  if (INSPECT.has(action) || action === VALIDATE) return undefined;
  const hiddenSet = new Set(hidden);
  const direct = typeof record.agent === "string" ? record.agent.trim() : "";
  if (direct && hiddenSet.has(direct)) return { block: true, reason: blockReason(direct) };
  const hasScript = typeof record.workflowScript === "string";
  const hasPath = typeof record.workflowScriptPath === "string";
  if (!hasScript && !hasPath && action !== SCHEDULE_CREATE) return undefined;
  const source = workflowSource(record, io);
  if (source === undefined) return { block: true, reason: unknownLaunchReason(hidden) };
  const shape = agentLaunchShape(source, hiddenSet);
  const named = shape.literal ?? hiddenNameIn(source, hiddenSet);
  if (named) return { block: true, reason: blockReason(named) };
  if (shape.dynamic) return { block: true, reason: unknownLaunchReason(hidden) };
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
