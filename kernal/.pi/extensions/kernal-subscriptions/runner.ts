/**
 * Kernal's one-shot Claude worker (subscriptions.md §5). Not the pi-subagents adapter: one
 * `claude -p`, no `--resume`, no session id, and the Anthropic API keys never reach the child.
 * The account secret is set only as `CLAUDE_CODE_OAUTH_TOKEN` on that child. It is not sent to
 * pi's model client or the router.
 *
 * Grok, Codex, and agy_acp_server implement `SubscriptionRunner` later and register in
 * `SUBSCRIPTION_RUNNERS`. Full-on-a-Drive (shell off, file tools only) is also a later slice;
 * `full` here is the laptop: project settings and the CLI's own approval prompts.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValue, subscriptionPrefer } from "../_shared/central-config.ts";
import { loadSubscriptionSecret, type SecretLookup } from "./client.ts";
import { localVendorLogin } from "./local-login.ts";
import { isVendor, type SubscriptionMode, type SubscriptionVendor } from "./vendors.ts";

/** Router MCP and the two OAuth admin servers. They are not handed to Claude. */
export const EXCLUDED_MCP = new Set(["litellm", "google_admin", "augment_admin"]);

export type SubscriptionRunResult =
  | { kind: "ok"; vendor: SubscriptionVendor; text: string }
  | { kind: "off"; vendor: SubscriptionVendor; text: string }
  | { kind: "connect"; vendor: SubscriptionVendor; text: string }
  | { kind: "exhausted"; vendor: SubscriptionVendor; text: string }
  | { kind: "error"; vendor: SubscriptionVendor; text: string }
  | { kind: "unsupported"; vendor: SubscriptionVendor; text: string };

export interface WorkerInput {
  prompt: string;
  cwd?: string;
  /** Text the coordinator already has. Prepended for `full` only. Not Outfitter credentials. */
  memoryBrief?: string;
  /** Parsed MCP servers (pi's mcp.json shape). Tests inject this; a missing value loads nothing. */
  mcpServers?: Record<string, unknown>;
}

export interface ClaudeSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ClaudeSpawnResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface WorkerDeps {
  spawn?: (req: ClaudeSpawn) => Promise<ClaudeSpawnResult>;
  env?: NodeJS.ProcessEnv;
  mode?: () => SubscriptionMode;
  localLogin?: () => boolean;
  /** When set, the runner does not call Outfitter. */
  secret?: SecretLookup;
  loadAccountSecret?: () => Promise<SecretLookup>;
  /** Writes the generated MCP config and returns its path. Tests capture the JSON. */
  writeMcpConfig?: (json: string) => string;
}

/** What a later runner implements. `deps` is the Claude runner's seam; another vendor can ignore it. */
export interface SubscriptionRunner {
  vendor: SubscriptionVendor;
  run(input: WorkerInput, deps?: WorkerDeps): Promise<SubscriptionRunResult>;
}

const CONNECT_CLAUDE = "Claude is not connected. Ask this person to connect Claude (`kernal subscriptions connect claude`).";
const EXHAUSTED_CLAUDE = "Claude's plan window is spent.";

/** Non-zero output that means the plan window is spent, not a generic failure. */
const PLAN_LIMIT = /usage limit|plan limit|rate limit|hit your (?:usage |rate )?limit|out of (?:extra )?usage|limit will reset|quota exceeded|you'?ve reached your|extra usage is exhausted/i;

export function looksLikePlanLimit(text: string): boolean {
  return PLAN_LIMIT.test(text);
}

/** URL or local-command servers, minus the router MCP and the OAuth admin servers. */
export function claudeMcpServers(servers: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if (EXCLUDED_MCP.has(name) || !cfg || typeof cfg !== "object") continue;
    const c = cfg as { url?: unknown; command?: unknown };
    const url = typeof c.url === "string" && c.url.trim() !== "";
    const command = typeof c.command === "string" && c.command.trim() !== "";
    if (url || command) out[name] = cfg;
  }
  return out;
}

export function claudeArgs(mode: "sandboxed" | "full", prompt: string, mcpPath: string): string[] {
  const args = ["--strict-mcp-config", "--mcp-config", mcpPath];
  if (mode === "sandboxed") args.push("--permission-mode", "plan", "--setting-sources", "user", "--disallowedTools", "Bash");
  else args.push("--setting-sources", "user,project");
  // `-p` is last so a flag isn't read as the prompt. No `--resume`, no skip-permissions.
  args.push("-p", prompt);
  return args;
}

/** The child environment: API keys dropped; the account secret only as Claude's OAuth token. */
export function claudeChildEnv(parent: NodeJS.ProcessEnv, secret?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (secret) env.CLAUDE_CODE_OAUTH_TOKEN = secret;
  return env;
}

function promptFor(mode: "sandboxed" | "full", prompt: string, memoryBrief?: string): string {
  if (mode === "full" && memoryBrief?.trim()) return `${memoryBrief.trim()}\n\n${prompt}`;
  return prompt;
}

function publicText(text: string, secret?: string): string {
  let out = text;
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/sk-ant-[!-~]+/g, "[redacted]");
}

function defaultWriteMcp(json: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kernal-claude-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, json, { mode: 0o600 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function spawnClaude(req: ClaudeSpawn): Promise<ClaudeSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(req.command, req.args, { cwd: req.cwd, env: req.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { stdout += c; });
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function readMode(): SubscriptionMode {
  const v = getValue("subscriptions.claude");
  return v === "sandboxed" || v === "full" ? v : "off";
}

/**
 * Vendors in `prefer` that are not off, in that order. `run` is signed in (account secret or a
 * local login). `connect` is on but not signed in: ask the person; do not fall through to an API key.
 * An exhausted runner is skipped by the coordinator, which then takes the next `run` and, with none
 * left, the router. This does not call a runner.
 */
export function subscriptionPlan(
  prefer: string,
  modes: Partial<Record<SubscriptionVendor, string>>,
  signedIn: ReadonlySet<string>,
): { vendor: SubscriptionVendor; action: "run" | "connect" }[] {
  const list = subscriptionPrefer(prefer);
  if (!list) return [];
  const out: { vendor: SubscriptionVendor; action: "run" | "connect" }[] = [];
  for (const id of list.split(",")) {
    if (!isVendor(id)) continue;
    const mode = modes[id];
    if (!mode || mode === "off") continue;
    out.push({ vendor: id, action: signedIn.has(id) ? "run" : "connect" });
  }
  return out;
}

export async function runClaudeWorker(input: WorkerInput, deps: WorkerDeps = {}): Promise<SubscriptionRunResult> {
  const mode = deps.mode ? deps.mode() : readMode();
  if (mode === "off") return { kind: "off", vendor: "claude", text: "subscriptions.claude is off" };
  const secret = deps.secret ?? await (deps.loadAccountSecret ?? (() => loadSubscriptionSecret("claude", { env: deps.env })))();
  if (!secret.ok) return { kind: "error", vendor: "claude", text: publicText(secret.error) };
  const local = secret.value ? false : (deps.localLogin ? deps.localLogin() : localVendorLogin("claude", { env: deps.env }));
  if (!secret.value && !local) return { kind: "connect", vendor: "claude", text: CONNECT_CLAUDE };

  const prompt = promptFor(mode, input.prompt, input.memoryBrief);
  const servers = mode === "sandboxed" ? {} : claudeMcpServers(input.mcpServers);
  const json = JSON.stringify({ mcpServers: servers });
  const written = deps.writeMcpConfig ? { path: deps.writeMcpConfig(json), cleanup: () => {} } : defaultWriteMcp(json);
  try {
    const parent = deps.env ?? process.env;
    const env = claudeChildEnv(parent, secret.value);
    const run = deps.spawn ?? spawnClaude;
    let child: ClaudeSpawnResult;
    try {
      child = await run({ command: "claude", args: claudeArgs(mode, prompt, written.path), env, cwd: input.cwd });
    } catch {
      return { kind: "error", vendor: "claude", text: "could not start claude" };
    }
    const combined = `${child.stdout}\n${child.stderr}`;
    if (child.code !== 0 && looksLikePlanLimit(combined)) {
      return { kind: "exhausted", vendor: "claude", text: publicText(EXHAUSTED_CLAUDE, secret.value) };
    }
    if (child.code !== 0) {
      const detail = publicText(child.stderr.trim() || child.stdout.trim(), secret.value).slice(0, 400);
      return { kind: "error", vendor: "claude", text: detail ? `claude exited ${child.code}: ${detail}` : `claude exited ${child.code}` };
    }
    return { kind: "ok", vendor: "claude", text: publicText(child.stdout, secret.value).trim() };
  } finally {
    written.cleanup();
  }
}

export const claudeRunner: SubscriptionRunner = { vendor: "claude", run: runClaudeWorker };

/** Claude only. A later slice adds grok, codex, and gemini beside it. */
export const SUBSCRIPTION_RUNNERS: Partial<Record<SubscriptionVendor, SubscriptionRunner>> = {
  claude: claudeRunner,
};

export async function runSubscriptionWorker(vendor: SubscriptionVendor, input: WorkerInput, deps?: WorkerDeps): Promise<SubscriptionRunResult> {
  const runner = SUBSCRIPTION_RUNNERS[vendor];
  if (!runner) return { kind: "unsupported", vendor, text: `${vendor} has no runner in this slice` };
  return runner.run(input, deps);
}
