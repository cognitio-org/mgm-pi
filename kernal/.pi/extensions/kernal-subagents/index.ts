/**
 * kernal-subagents: makes the `subagent` tool tell the truth about command-line agents.
 *
 * pi-subagents prints the router model next to agents that actually run Claude Code, Codex or Cursor,
 * so the model (and you) would think Kernal's model runs them. A `tool_result` handler rewrites the
 * text of `subagent` list, get and models results only; everything else, including the result details and
 * every other tool, passes through untouched. See lib.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { annotateSubagentText, discoverCliNames } from "./lib.ts";

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event?.toolName !== "subagent" || event.isError) return;
    const action = event.input?.action;
    if (action !== "list" && action !== "get" && action !== "models") return;
    if (!Array.isArray(event.content)) return;
    // models output never says which agents run another tool, so ask the package's discovery.
    const cli = action === "models" ? await discoverCliNames(ctx?.cwd ?? process.cwd()) : undefined;
    let changed = false;
    const content = event.content.map((part: any) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const text = annotateSubagentText(part.text, cli);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });
}
