/**
 * Pure rendering of a run.spec `guru` block into pi CLI flags and process env. No IO here so this
 * is fully unit-testable; see test/guru.test.ts.
 *
 * Deviation from protocol.md: `guru.packages` has no pi CLI equivalent (pi only reads `packages`
 * from .pi/settings.json at startup, see kernal/.pi/settings.json). v0 renders it into the
 * `OUTFITTER_GURU_PACKAGES` env var (comma-joined) so a future settings-patch step can pick it up,
 * but does not otherwise act on it. The image's baked .pi/settings.json packages list is what
 * actually loads. Flagged in the final report for the api side to match.
 */
import { htmlPreviewPrompt } from "./html-preview-prompt.js";
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
  /** E5.5: path to pi-extension/outfitter-mail.ts (or its built .js), which gives the model the
   * outfitter_send tool. Loaded the same way as the spend extension. */
  mailExtensionPath?: string;
  /** Chrome companion §13: path to pi-extension/outfitter-browser.ts (or its built .js). The
   * Drive-only `browser_capture` tool. Omitted outside a Drive, same as the mail extension. */
  browserExtensionPath?: string;
  /** Bug 8 (docs/reports/cloud-fixes.md): true when the restored session's own last-known model and
   * thinking level (session.ts's lastKnownModelState) already match `guru.model`/`guru.thinking` --
   * omit `--model` entirely rather than reassert an unchanged value, since pi logs a fresh
   * model_change/thinking_level_change entry for any explicit `--model` flag regardless of whether
   * it actually changes anything. Unset (or false) renders `--model` exactly as before -- the
   * default for a brand-new session, or a genuine change. */
  skipModelArg?: boolean;
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
  // A user Dongle. The Drive capture tool must not be able to present one, and a guru must not
  // be able to plant one in the sandbox either (chrome-companion.md §13).
  "OUTFITTER_TOKEN",
]);

function isDenylistedGuruEnvKey(key: string): boolean {
  return DENYLISTED_GURU_ENV_KEYS.has(key) || key.startsWith("GIT_");
}

/** `provider/id` (+ optional `:thinking`) pi model pattern, per pi 0.87's docs/usage.md: `--model
 * <pattern>` "supports `provider/id` and optional `:<thinking>`", where `<thinking>` is one of
 * `off, minimal, low, medium, high, xhigh, max` -- `off` is a real, explicit level in that list,
 * not the absence of one. Bug 5a (docs/reports/cloud-fixes.md): this used to special-case "off" as
 * "append nothing", so a Tape configured with `thinking: "off"` never told pi anything at all --
 * pi then fell back to its own startup default (`defaultThinkingLevel` in .pi/settings.json,
 * "medium" in this image), which is exactly the "header says thinking medium" symptom. `off` now
 * renders `:off` like every other level; only a genuinely *unset* guru.thinking renders nothing,
 * leaving pi's own default in place (the guru simply didn't ask for a level). */
export function renderModelArg(model: string, thinking?: string): string {
  if (!thinking) return model;
  // Avoid double-suffixing if the caller already embedded a thinking level in the model string
  // (also protects a colon-bearing model id with no thinking suffix at all, e.g. a Bedrock
  // inference-profile ARN).
  if (model.includes(":")) return model;
  return `${model}:${thinking}`;
}

/** The single `--append-system-prompt` value (issue #132): the guru's own append text, a blank line,
 * then the HTML preview paragraph `allowExternalHtmlResources` picks. Always present, so the model
 * is always told which kind of HTML the preview will show; with no append text it is the paragraph
 * alone. */
export function renderAppendSystemPrompt(guru: RunSpecGuru): string {
  const paragraph = htmlPreviewPrompt(guru.allowExternalHtmlResources);
  return guru.appendSystemPrompt ? `${guru.appendSystemPrompt}\n\n${paragraph}` : paragraph;
}

/** Renders `guru` into the argv (excluding the pi binary path itself) and env agentd should spawn
 * `pi --mode rpc -a --session <file> ...` with. */
export function renderGuru(guru: RunSpecGuru, opts: RenderOptions): RenderedPi {
  const args: string[] = ["--mode", "rpc", "-a", "--session", opts.sessionFile];

  if (opts.spendExtensionPath) args.push("--extension", opts.spendExtensionPath);
  if (opts.mailExtensionPath) args.push("--extension", opts.mailExtensionPath);
  if (opts.browserExtensionPath) args.push("--extension", opts.browserExtensionPath);

  if (!opts.skipModelArg) args.push("--model", renderModelArg(guru.model, guru.thinking));

  if (guru.systemPrompt) args.push("--system-prompt", guru.systemPrompt);
  args.push("--append-system-prompt", renderAppendSystemPrompt(guru));
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
