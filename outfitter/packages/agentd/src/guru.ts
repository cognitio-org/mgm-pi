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
import { tapeEnv, tapePiArgs } from "./tape-args.js";

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
  /** The APPEND_SYSTEM.md pi would have found on its own (append-system.ts). Any
   * `--append-system-prompt` stops pi looking, so it is passed as its own flag, ahead of the guru's
   * text and the HTML preview paragraph. Only used when the guru has no append text, which is when
   * pi read the file before #132: a guru's own text has always replaced it. */
  appendSystemPromptFile?: string;
}

/** pi-memory's tools, `agentEngineMemoryOn` and `renderModelArg` (bug 5a: `off` renders `:off`) are
 * in tape-args.ts, the translation shared with laptop Kernal (#354). */
export { PI_MEMORY_TOOLS, agentEngineMemoryOn, renderModelArg } from "./tape-args.js";

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

  args.push(
    ...tapePiArgs(guru, {
      skipModelArg: opts.skipModelArg,
      appendSystemPromptFile: opts.appendSystemPromptFile,
      appendSystemPrompt: renderAppendSystemPrompt(guru),
    }),
  );

  const onLog = opts.onLog ?? (() => {});
  // guru.env keys that would let a guru author plant persistent code execution or credential leakage
  // into every future run of a guru other people also use (finding #6, docs/reports/security-review-
  // pr1.md; finding #1, docs/reports/security-review-pr15.md) are dropped: the denylist is
  // tape-args.ts's, shared with laptop Kernal (#354). The API's POST/PUT /api/gurus routes reject
  // them outright; this is agentd's own last line of defense for a guru predating that check, or
  // written directly into the store. run.ts also pins LITELLM_BASE_URL itself in secretEnv, spread
  // after this rendered env, so even a gap in the list can't redirect the outbound call.
  const env = tapeEnv(guru.env, (key) => onLog(`renderGuru: dropping guru.env key "${key}" (not allowed -- see the denylist in tape-args.ts)`));
  if (guru.packages && guru.packages.length > 0) {
    env.OUTFITTER_GURU_PACKAGES = guru.packages.join(",");
  }

  return { args, env };
}
