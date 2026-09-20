/**
 * Pure rendering of a run.spec `guru` block into pi CLI flags and process env. No IO here so this
 * is fully unit-testable; see test/guru.test.ts.
 *
 * Deviation from protocol.md: `guru.packages` has no pi CLI equivalent (pi only reads `packages`
 * from .pi/settings.json at startup, see mgm/.pi/settings.json). v0 renders it into the
 * `OUTFITTER_GURU_PACKAGES` env var (comma-joined) so a future settings-patch step can pick it up,
 * but does not otherwise act on it. The image's baked .pi/settings.json packages list is what
 * actually loads. Flagged in the final report for the api side to match.
 */
import type { RunSpecGuru } from "./protocol.js";

export interface RenderedPi {
  /** Full argv, not including the binary itself. */
  args: string[];
  /** Env vars to merge on top of the parent process env (secrets included; caller redacts logs). */
  env: Record<string, string>;
}

export interface RenderOptions {
  piBin: string;
  sessionFile: string;
  /** RPC mode is always on, `-a` (trust project files) is always on: fixed by the sandbox contract,
   * not chosen per-guru. */
}

/** `provider/id` (+ optional `:thinking`) pi model pattern, per rpc.md's `--model` flag. */
export function renderModelArg(model: string, thinking?: string): string {
  if (!thinking || thinking === "off") return model;
  // Avoid double-suffixing if the caller already embedded a thinking level in the model string.
  if (model.includes(":")) return model;
  return `${model}:${thinking}`;
}

/** Renders `guru` into the argv (excluding the pi binary path itself) and env agentd should spawn
 * `pi --mode rpc -a --session <file> ...` with. */
export function renderGuru(guru: RunSpecGuru, opts: RenderOptions): RenderedPi {
  const args: string[] = ["--mode", "rpc", "-a", "--session", opts.sessionFile];

  args.push("--model", renderModelArg(guru.model, guru.thinking));

  if (guru.systemPrompt) args.push("--system-prompt", guru.systemPrompt);
  if (guru.appendSystemPrompt) args.push("--append-system-prompt", guru.appendSystemPrompt);
  if (guru.tools && guru.tools.length > 0) args.push("--tools", guru.tools.join(","));
  if (guru.excludeTools && guru.excludeTools.length > 0) {
    args.push("--exclude-tools", guru.excludeTools.join(","));
  }

  const env: Record<string, string> = { ...(guru.env ?? {}) };
  if (guru.packages && guru.packages.length > 0) {
    env.OUTFITTER_GURU_PACKAGES = guru.packages.join(",");
  }

  return { args, env };
}
