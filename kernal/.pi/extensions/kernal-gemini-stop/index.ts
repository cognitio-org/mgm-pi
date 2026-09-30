/**
 * Continue a Gemini thought-only STOP, twice at most, and leave a transcript marker either way.
 *
 * Pi refuses continue:true while the context still ends on an assistant message, so a
 * continuation is a display:false custom_message (Pi sends that to the model as a user message).
 * The third detection in the same stretch is a plain custom entry, which stays out of the
 * model context. Compaction also listens to turn_end and returns nothing, so it does not
 * replace this boundary result. Issue #283.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BranchEntry,
  CONTINUE_INSTRUCTION,
  GEMINI_EMPTY_STOP_TYPE,
  decideEmptyStop,
  emptyStopLogLine,
} from "./lib.ts";

export default function (pi: ExtensionAPI) {
  pi.on("turn_end", async (event, ctx) => {
    const branch = (ctx.sessionManager.getBranch?.() ?? []) as BranchEntry[];
    const decision = decideEmptyStop(event.message, event.toolResults, branch, event.messageEntryId);
    if (!decision) return;

    console.error(emptyStopLogLine(decision.details));
    const prior = event.entries ?? [];
    if (decision.action === "continue") {
      return {
        entries: [
          ...prior,
          {
            type: "custom_message" as const,
            customType: GEMINI_EMPTY_STOP_TYPE,
            content: CONTINUE_INSTRUCTION,
            display: false,
            details: decision.details,
          },
        ],
        continue: true,
      };
    }
    return {
      entries: [
        ...prior,
        { type: "custom" as const, customType: GEMINI_EMPTY_STOP_TYPE, data: decision.details },
      ],
      continue: false,
    };
  });
}
