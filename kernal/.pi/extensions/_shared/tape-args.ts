/**
 * What a tape means to pi: the one translation of a tape's fields into pi CLI flags and process env,
 * shared by an Outfitter Drive (agentd's renderGuru) and a laptop playing the tape (kernal-tape), so
 * a tape means the same thing in both places (outfitter/docs/specs/atlas-agent-engine-and-a2a.md
 * §7.1, #354).
 *
 * outfitter/packages/agentd/src/tape-args.ts is a byte-for-byte copy of this file: agentd builds on
 * its own (image/Dockerfile's agentd-builder stage) and cannot import from kernal.
 * agentd's test/tape-args.test.ts fails if the two differ. Change both together. No imports, so the
 * one text compiles under agentd's tsc and runs under node's type stripping in Kernal.
 *
 * Only the pure part lives here. Each side adds its own frame: agentd its fixed `--mode rpc -a
 * --session` prefix, its `--extension` files and the HTML preview paragraph; Kernal its package
 * extensions and the laptop's memory and Agent Engine wiring.
 */

/** The tape fields the translation reads (a structural subset of agentd's RunSpecGuru and of the
 * tape Kernal fetches). */
export interface TapeArgsInput {
  model: string;
  thinking?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  excludeTools?: string[];
  memory?: "off" | "tool" | "auto";
  env?: Record<string, string>;
}

export interface TapeArgsOptions {
  /** Bug 8 (docs/reports/cloud-fixes.md): omit `--model` when the restored session already runs it. */
  skipModelArg?: boolean;
  /** The APPEND_SYSTEM.md pi would have found on its own, passed as its own flag first. Only used
   * when the tape has no append text, which is when pi would have read the file itself. */
  appendSystemPromptFile?: string;
  /** The `--append-system-prompt` text. Undefined passes none (and then no file either): pi finds
   * APPEND_SYSTEM.md itself. agentd always passes one (the tape's text and the HTML paragraph). */
  appendSystemPrompt?: string;
}

/** pi-memory's tools (kernal/.pi/settings.json loads the package). With Agent Engine memory on, a
 * tape gets one memory, not two: these are excluded, and the launcher points PI_MEMORY_DIR at an
 * empty directory (no prompt injection) with PI_MEMORY_EXIT_SUMMARY=0 (no exit summary). */
export const PI_MEMORY_TOOLS = ["memory_write", "memory_read", "memory_search", "memory_forget", "memory_restore", "memory_status", "scratchpad"] as const;

/** True when the tape has Agent Engine memory (`tool` or `auto`). */
export function agentEngineMemoryOn(tape: { memory?: string }): boolean {
  return tape.memory === "tool" || tape.memory === "auto";
}

/** Tape env keys that would let a tape author plant persistent code execution or credential
 * leakage into every run of a tape other people also use (security-review-pr1.md finding #6,
 * security-review-pr15.md finding #1): NODE_OPTIONS/LD_* load code into pi, PATH shadows git and
 * gh, GIT_* hijacks git's auth env, HOME moves where config and credentials are read, LITELLM_*
 * would redirect the real LiteLLM key, OUTFITTER_TOKEN is a Dongle. The API refuses these on write;
 * this is the last line of defence for a tape written before that check. */
export const DENYLISTED_TAPE_ENV_KEYS: readonly string[] = [
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_AGENT_KEY",
  "OUTFITTER_TOKEN",
];

export function isDenylistedTapeEnvKey(key: string): boolean {
  return DENYLISTED_TAPE_ENV_KEYS.includes(key) || key.startsWith("GIT_");
}

/** `provider/id` (+ optional `:thinking`) pi model pattern. `off` is a real level and renders
 * `:off` (bug 5a); only an unset thinking renders the bare model. A model that already carries a
 * colon (an embedded level, or an ARN) is left alone. */
export function renderModelArg(model: string, thinking?: string): string {
  if (!thinking) return model;
  if (model.includes(":")) return model;
  return `${model}:${thinking}`;
}

/** The tape's excludeTools, plus pi-memory's tools when Agent Engine memory is on, deduplicated in
 * order. pi drops an excluded tool even when --tools names it. */
export function tapeExcludeTools(tape: Pick<TapeArgsInput, "excludeTools" | "memory">): string[] {
  return [...new Set([...(tape.excludeTools ?? []), ...(agentEngineMemoryOn(tape) ? PI_MEMORY_TOOLS : [])])];
}

/** The tape's pi flags, in order: model, system prompt, append prompts, tools, excluded tools. */
export function tapePiArgs(tape: TapeArgsInput, opts: TapeArgsOptions = {}): string[] {
  const args: string[] = [];
  if (!opts.skipModelArg) args.push("--model", renderModelArg(tape.model, tape.thinking));
  if (tape.systemPrompt) args.push("--system-prompt", tape.systemPrompt);
  if (opts.appendSystemPrompt !== undefined) {
    if (opts.appendSystemPromptFile && !tape.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPromptFile);
    }
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  if (tape.tools && tape.tools.length > 0) args.push("--tools", tape.tools.join(","));
  const excludeTools = tapeExcludeTools(tape);
  if (excludeTools.length > 0) args.push("--exclude-tools", excludeTools.join(","));
  return args;
}

/** The tape's env with denylisted keys dropped (each one reported through `onDrop`). */
export function tapeEnv(env: Record<string, string> | undefined, onDrop?: (key: string) => void): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isDenylistedTapeEnvKey(key)) {
      onDrop?.(key);
      continue;
    }
    out[key] = value;
  }
  return out;
}
