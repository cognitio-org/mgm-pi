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
  onLog?: (line: string) => void;
  /** E2.11: path to packages/agentd/pi-extension/outfitter-spend.ts (or its built equivalent), loaded
   * via `-e <path>` so pi reports LiteLLM spend headers and its own per-message cost estimate back to
   * agentd (OUTFITTER_SPEND_FILE) without every non-agentd pi run picking it up. Omitted outside
   * agentd (interactive/local pi never sets this). */
  spendExtensionPath?: string;
}

/** guru.env keys that would let a guru author plant persistent code-exec or credential leakage into
 * every future run of a guru other people also use (finding #6, docs/reports/security-review-pr1.md):
 * NODE_OPTIONS/LD_PRELOAD/LD_LIBRARY_PATH can load arbitrary code into the pi process, PATH can
 * shadow `git`/`gh`/etc with a malicious binary, GIT_* can hijack the auth-header env vars git.ts
 * sets per-invocation (see git.ts's module doc), and HOME can redirect where pi/git read config and
 * credentials from. LITELLM_BASE_URL/LITELLM_API_KEY/LITELLM_AGENT_KEY (finding #1,
 * docs/reports/security-review-pr15.md): outfitter-spend.ts sends the real per-run LiteLLM key as a
 * Bearer token to whatever LITELLM_BASE_URL is set, so a guru-controlled base URL is a credential
 * exfiltration + SSRF primitive. The API's POST/PUT /api/gurus routes reject these keys outright
 * (belt and suspenders); this list is agentd's own last line of defense in case a guru predating
 * that check, or written directly into the store, still has one set. run.ts also pins
 * LITELLM_BASE_URL itself in secretEnv, spread after this rendered env, so even a future denylist
 * gap here can't redirect the outbound call. */
const DENYLISTED_GURU_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_AGENT_KEY",
]);

function isDenylistedGuruEnvKey(key: string): boolean {
  return DENYLISTED_GURU_ENV_KEYS.has(key) || key.startsWith("GIT_");
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

  if (opts.spendExtensionPath) args.push("--extension", opts.spendExtensionPath);

  args.push("--model", renderModelArg(guru.model, guru.thinking));

  if (guru.systemPrompt) args.push("--system-prompt", guru.systemPrompt);
  if (guru.appendSystemPrompt) args.push("--append-system-prompt", guru.appendSystemPrompt);
  if (guru.tools && guru.tools.length > 0) args.push("--tools", guru.tools.join(","));
  if (guru.excludeTools && guru.excludeTools.length > 0) {
    args.push("--exclude-tools", guru.excludeTools.join(","));
  }

  const onLog = opts.onLog ?? (() => {});
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(guru.env ?? {})) {
    if (isDenylistedGuruEnvKey(key)) {
      onLog(`renderGuru: dropping guru.env key "${key}" (not allowed -- see denylist in guru.ts)`);
      continue;
    }
    env[key] = value;
  }
  if (guru.packages && guru.packages.length > 0) {
    env.OUTFITTER_GURU_PACKAGES = guru.packages.join(",");
  }

  return { args, env };
}
