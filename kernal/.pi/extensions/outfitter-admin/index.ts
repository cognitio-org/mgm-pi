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
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ADMIN_TOOLS, PROMPT_GUIDELINES, PROMPT_SNIPPET, runTool, type Confirm } from "./tools.ts";
import { adminTransport, type AdminTransport } from "./transport.ts";
import { SEARCH_TOOLS, runSessionSearch, runSessionTranscript, type SearchToolDeps } from "./search-tools.ts";
import { syncSessions } from "./sync.ts";

const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** A person is at the terminal (as kernal-github decides it): RPC mode has a UI that may have
 * nobody watching, and a Drive's approvals are the API's, not this dialog's. */
export function personHere(ctx: any): boolean {
  if (process.env.OUTFITTER_SESSION_ID) return false;
  return ctx?.mode === "tui";
}

/** The laptop's sessions directory; none inside a Drive, whose only local session is itself. */
function localSessionsDir(): string | undefined {
  if (process.env.OUTFITTER_SESSION_ID) return undefined;
  return process.env.KERNAL_SESSIONS_DIR || join(getAgentDir(), "sessions");
}

/** Tests pass `deps`; pi calls this with `pi` alone, and the environment decides. */
export default function (pi: ExtensionAPI, deps?: { transport?: AdminTransport; localDir?: string }) {
  const transport = deps ? deps.transport : adminTransport();
  const localDir = deps ? deps.localDir : localSessionsDir();
  registerSearch(pi, { transport, localDir });
  if (transport?.kind === "laptop") registerSync(pi, localDir);
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

/** session_search and session_transcript: whenever there is anything to search (cloud or local). */
function registerSearch(pi: ExtensionAPI, deps: SearchToolDeps) {
  if (!deps.transport && !deps.localDir) return;
  const run = { session_search: runSessionSearch, session_transcript: runSessionTranscript };
  for (const def of SEARCH_TOOLS) {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      execute: async (_id: string, params: any, signal: AbortSignal | undefined) => {
        try {
          return await run[def.name](params ?? {}, deps, signal);
        } catch (err) {
          return { content: [{ type: "text" as const, text: `${def.name}: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    } as any);
  }
}

/** `/sessions sync`: upload local sessions to Outfitter's search index, only when asked. */
function registerSync(pi: ExtensionAPI, localDir: string | undefined) {
  if (!localDir) return;
  pi.registerCommand("sessions", {
    description: "sessions sync [<id> | --since 7d] -- upload local sessions to Outfitter so session_search finds them",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] !== "sync") {
        ctx.ui.notify("usage: /sessions sync [<session id> | --since 7d]", "info");
        return;
      }
      const sinceAt = parts.indexOf("--since");
      const report = await syncSessions(localDir, { id: sinceAt < 0 ? parts[1] : undefined, since: sinceAt >= 0 ? parts[sinceAt + 1] : undefined });
      ctx.ui.notify(report, "info");
    },
  } as any);
  // KERNAL_SESSION_SYNC=1: the session just worked on goes up after each turn.
  if (process.env.KERNAL_SESSION_SYNC === "1") {
    pi.on("agent_end", async (_event: unknown, ctx: any) => {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string") await syncSessions(localDir, { id, quiet: true }).catch(() => {});
    });
  }
}
