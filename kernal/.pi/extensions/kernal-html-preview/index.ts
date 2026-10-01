/**
 * kernal HTML preview prompt (issue #132) — tells the model what HTML it writes for the transcript
 * may load. Exactly one paragraph is appended to pi's system prompt on every turn: the sealed one
 * (inline CSS only) by default, the external one (http and https stylesheets, scripts, images, and
 * fonts) when `kernal.allowExternalHtmlResources` is true in the agent settings.json. The text lives
 * in ../_shared/html-preview-prompt.ts.
 *
 * The setting is read once, when pi starts; changing it applies to the next start. The paragraph
 * goes in through `before_agent_start`'s `systemPromptOptions.appendSystemPrompt`, the same slot
 * `--append-system-prompt` and APPEND_SYSTEM.md fill, after whatever they put there (and onto the
 * end of a prompt an earlier handler already forced, see below). This extension
 * never reads or writes APPEND_SYSTEM.md: someone who also pasted a paragraph in there sees it twice,
 * which is harmless.
 *
 * Inside an Outfitter Drive, agentd appends the paragraph itself from the Tape's setting, so this
 * extension does nothing there (and image/Dockerfile leaves it out).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettings } from "../connect/settings.ts";
import { htmlPreviewPrompt } from "../_shared/html-preview-prompt.ts";
import { inSandbox } from "../_shared/env.ts";
import { playingHtmlExternal } from "../_shared/tape-env.ts";

/** `kernal.allowExternalHtmlResources` in the agent settings.json. Anything but `true` is off. */
export function allowExternalHtmlResources(settings: Record<string, unknown> = readSettings()): boolean {
  const kernal = settings.kernal as { allowExternalHtmlResources?: unknown } | undefined;
  return kernal?.allowExternalHtmlResources === true;
}

/** Existing append text, a blank line, then the paragraph. With nothing before it, the paragraph alone. */
export function withHtmlPreviewPrompt(appendSystemPrompt: string | undefined, allowExternal: boolean): string {
  const paragraph = htmlPreviewPrompt(allowExternal);
  return appendSystemPrompt ? `${appendSystemPrompt}\n\n${paragraph}` : paragraph;
}

export default function (pi: ExtensionAPI) {
  if (inSandbox()) return;
  // A tape being played (#354, kernal-tape) decides for its session, as it does in a Drive.
  const allowExternal = playingHtmlExternal() ?? allowExternalHtmlResources();
  pi.on("before_agent_start", async (event) => {
    // pi rebuilds these options from its base prompt for every turn, so this appends once per turn,
    // not once more each turn.
    const options = event.systemPromptOptions;
    options.appendSystemPrompt = withHtmlPreviewPrompt(options.appendSystemPrompt, allowExternal);
    // A handler that ran earlier may already have returned `systemPrompt` (pi-memory does, every
    // turn it has memory to add), and pi then sends that forced text as it is, so the paragraph
    // goes on its end too. A handler that forces after this one renders the options above, which
    // already carry it.
    if (options.forceSystemPrompt !== undefined) {
      options.forceSystemPrompt = withHtmlPreviewPrompt(options.forceSystemPrompt, allowExternal);
    }
  });
}
