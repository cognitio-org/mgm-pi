/**
 * session_search and session_transcript (outfitter/docs/specs/sysop-tools.md, "Session search and
 * transcripts"): find past sessions and read them compactly, for debugging a Drive or mining
 * sessions to write a tape.
 *
 * - Cloud: the op registry's sessions.search (keyword by default; hybrid and semantic on request) and sessions.transcript, over the
 *   same transport as the admin tools.
 * - Laptop: also this machine's own sessions (local-sessions.ts), keyword only. With both, results
 *   come in two short sections, and a local session that is also in the cloud's results is shown once.
 */
import type { ToolResult } from "./tools.ts";
import type { AdminTransport } from "./transport.ts";
import { capText, loadAll, localTranscript, renderLocal, searchLocal, shortSid, sidMatches, type LocalSession } from "./local-sessions.ts";

export interface SearchToolDeps {
  transport?: AdminTransport;
  /** The laptop's sessions directory; undefined in a Drive. */
  localDir?: string;
}

const MODES = ["hybrid", "text", "semantic"] as const;

export const SEARCH_TOOLS = [
  {
    name: "session_search",
    label: "Session search",
    description: "Search past Outfitter and local sessions by meaning or words. Returns sessions with matching entry ids.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: MODES, description: "Cloud only; default text. hybrid/semantic match meaning." },
        scope: { type: "string", enum: ["all", "cloud", "local"] },
        owner: { type: "string", enum: ["me"] },
        tape: { type: "string" },
        repo: { type: "string", description: "owner/name" },
        since: { type: "string", description: "e.g. 7d or 2026-09-01" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "session_transcript",
    label: "Session transcript",
    description: "Read a session compactly. Start with outline; use around=<entry id> from a search hit, or from= to page.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Session id or 8+ char prefix." },
        view: { type: "string", enum: ["outline", "text"] },
        around: { type: "string" },
        window: { type: "integer" },
        from: { type: "string" },
        toolOutput: { type: "string", enum: ["none", "trimmed", "full"] },
        maxChars: { type: "integer" },
      },
    },
  },
] as const;

function text(t: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

/** `30m`, `12h`, `7d`, `2w`, or an ISO date, as an ISO time; undefined when it is none of these. The
 * same forms Outfitter accepts, and /sessions sync uses this too. */
export function sinceIso(value: unknown, now = Date.now()): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const rel = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (rel) return new Date(now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as "m"]).toISOString();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export async function runSessionSearch(p: Record<string, any>, deps: SearchToolDeps, signal?: AbortSignal): Promise<ToolResult> {
  const query = typeof p.query === "string" ? p.query.trim() : "";
  if (!query) return text("query is required", true);
  const scope = p.scope === "cloud" || p.scope === "local" ? p.scope : "all";
  const wantCloud = scope !== "local" && !!deps.transport;
  const wantLocal = scope !== "cloud" && !!deps.localDir;
  if (!wantCloud && !wantLocal) return text(scope === "local" ? "no local sessions here" : "no Outfitter connection: set OUTFITTER_API and OUTFITTER_TOKEN", true);
  const limit = typeof p.limit === "number" ? Math.min(Math.max(Math.floor(p.limit), 1), 25) : 10;
  const since = sinceIso(p.since);
  if (p.since !== undefined && !since) return text("since: use 7d, 12h or an ISO date", true);

  // The local scan runs while the cloud answers.
  const localSessions = wantLocal ? loadAll(deps.localDir!) : undefined;
  const cloud = wantCloud
    ? await deps.transport!.call(
        "sessions.search",
        { query, limit, ...(MODES.includes(p.mode) ? { mode: p.mode } : {}), ...(p.owner === "me" ? { owner: "me" } : {}), ...(p.tape ? { tape: p.tape } : {}), ...(p.repo ? { repo: p.repo } : {}), ...(p.since ? { since: p.since } : {}) },
        { signal },
      )
    : undefined;
  let local = "";
  if (localSessions) {
    // Sessions the cloud already listed (teleported or synced) are shown once, from the cloud. Both
    // sides print a UUID's random tail, so equal short ids are the same session.
    const shown = new Set<string>();
    if (cloud?.ok) for (const m of cloud.text.matchAll(/^(\S{8})\s/gm)) shown.add(m[1]);
    local = renderLocal(searchLocal(await localSessions, query, { limit, since, exclude: shown }), query);
  }
  if (!wantLocal) return cloud!.ok ? text(cloud!.text) : text(cloud!.error, true);
  if (!wantCloud) return text(local || "no matches");
  const parts: string[] = [];
  parts.push(cloud!.ok ? `cloud:\n${cloud!.text}` : `cloud: ${cloud!.error}`);
  parts.push(`local:\n${local || "no matches"}`);
  return text(capText(parts.join("\n")));
}

async function findLocal(dir: string | undefined, id: string): Promise<LocalSession | { error: string } | undefined> {
  if (!dir || id.length < 8) return undefined;
  const all = await loadAll(dir);
  const exact = all.find((s) => s.id === id);
  if (exact) return exact;
  const matches = all.filter((s) => sidMatches(s.id, id));
  if (matches.length > 1) return { error: `session "${id}" is ambiguous here: ${matches.slice(0, 5).map((s) => shortSid(s.id)).join(", ")}` };
  return matches[0];
}

export async function runSessionTranscript(p: Record<string, any>, deps: SearchToolDeps, signal?: AbortSignal): Promise<ToolResult> {
  const id = typeof p.id === "string" ? p.id.trim() : "";
  if (id.length < 8) return text("session id needs at least 8 characters", true);
  const opts = {
    view: p.view === "text" ? ("text" as const) : ("outline" as const),
    around: typeof p.around === "string" ? p.around : undefined,
    window: typeof p.window === "number" ? p.window : undefined,
    from: typeof p.from === "string" ? p.from : undefined,
    toolOutput: p.toolOutput === "none" || p.toolOutput === "full" ? p.toolOutput : ("trimmed" as const),
    maxChars: typeof p.maxChars === "number" ? p.maxChars : undefined,
  };
  const local = await findLocal(deps.localDir, id);
  if (local && "error" in local) return text(local.error, true);
  if (local) {
    const out = await localTranscript(local, opts);
    if (!("error" in out)) return text(out.text);
    // A teleported session goes on in the cloud: an entry the local copy lacks may be there.
    if (!deps.transport || !/^no entry /.test(out.error)) return text(out.error, true);
  }
  if (!deps.transport) return text(`no local session "${id}", and no Outfitter connection`, true);
  const res = await deps.transport.call("sessions.transcript", { id, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) }, { signal });
  return res.ok ? text(res.text) : text(res.error, true);
}
