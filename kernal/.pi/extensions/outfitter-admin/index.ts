/**
 * Sysop tools (outfitter/docs/specs/sysop-tools.md, epic #291): outfitter_tapes,
 * outfitter_environments and outfitter_sessions, so an agent can administer Outfitter -- build and
 * save a tape, check a session -- without working out the API.
 *
 * Registered only when there is a way in (transport.ts): the admin socket agentd opens in a Drive
 * whose tape has admin tools, or OUTFITTER_API plus OUTFITTER_TOKEN on a laptop. Otherwise the
 * tools would only cost prompt tokens and fail. The API enforces every rule; this side only asks
 * the person before a delete on a laptop.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ADMIN_TOOLS, PROMPT_GUIDELINES, PROMPT_SNIPPET, runTool, type Confirm } from "./tools.ts";
import { adminTransport, type AdminTransport } from "./transport.ts";

const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** A person is at the terminal (as kernal-github decides it): RPC mode has a UI that may have
 * nobody watching, and a Drive's approvals are the API's, not this dialog's. */
export function personHere(ctx: any): boolean {
  if (process.env.OUTFITTER_SESSION_ID) return false;
  return ctx?.mode === "tui";
}

export default function (pi: ExtensionAPI, transport: AdminTransport | undefined = adminTransport()) {
  if (!transport) return;
  ADMIN_TOOLS.forEach((def, i) => {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      // One snippet and one guideline for the whole set, on the first tool only.
      ...(i === 0 ? { promptSnippet: PROMPT_SNIPPET, promptGuidelines: PROMPT_GUIDELINES } : {}),
      parameters: def.parameters,
      execute: async (_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) => {
        const confirm: Confirm | undefined =
          personHere(ctx) && typeof ctx.ui?.confirm === "function"
            ? (title, message, signal) => ctx.ui.confirm(title, message, { signal, timeout: CONFIRM_TIMEOUT_MS })
            : undefined;
        try {
          return await runTool(def, params, transport, confirm, signal);
        } catch (err) {
          return { content: [{ type: "text" as const, text: `outfitter: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    } as any);
  });
}
