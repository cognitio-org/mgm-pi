/**
 * Opt-in upload of local sessions to Outfitter (outfitter/docs/specs/sysop-tools.md, "Opt-in upload
 * of local sessions"), through teleport's own import route, so they get Outfitter's semantic and
 * hybrid search. An uploaded session also appears in Outfitter's floppy list, like a teleported one.
 * Nothing is uploaded unless the person runs `/sessions sync` or sets KERNAL_SESSION_SYNC=1.
 */
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { OutfitterStore } from "../teleport/outfitter-store.ts";
import { loadAll, shortSid, sidMatches, type LocalSession } from "./local-sessions.ts";
import { sinceIso } from "./search-tools.ts";

type Put = Pick<OutfitterStore, "put">;

export interface SyncPick {
  id?: string;
  since?: string;
  /** Only sessions whose cwd is this one, unless `all`. */
  cwd?: string;
  all?: boolean;
}

/** Which local sessions a /sessions sync would upload, or why none. */
export async function pickSessions(dir: string, pick: SyncPick): Promise<LocalSession[] | { error: string }> {
  const all = await loadAll(dir);
  if (pick.id) {
    const matches = all.filter((s) => s.id === pick.id || sidMatches(s.id, pick.id!));
    if (matches.length > 1) return { error: `"${pick.id}" matches ${matches.length} sessions (${matches.slice(0, 5).map((s) => shortSid(s.id)).join(", ")}); use a longer id` };
    return matches.length ? matches : { error: "no matching local session" };
  }
  if (!pick.since) return { error: "name a session id or --since 7d" };
  const cutoff = sinceIso(pick.since);
  if (!cutoff) return { error: "--since takes 12h, 7d, 2w or an ISO date" };
  const picked = all.filter((s) => s.updatedAt >= cutoff && (pick.all || !pick.cwd || s.cwd === pick.cwd));
  return picked.length ? picked : { error: `no local sessions since ${pick.since}${pick.all ? "" : " in this directory (--all for every project)"}` };
}

/** The file up to its last full line: a live session may be mid-write. */
async function completeLines(file: string): Promise<string> {
  const raw = await readFile(file, "utf8");
  return raw.slice(0, raw.lastIndexOf("\n") + 1);
}

function storeOrError(store?: Put): Put | string {
  try {
    return store ?? new OutfitterStore();
  } catch (err) {
    return err instanceof Error ? err.message.replace(/^teleport: KERNAL_TELEPORT_STORE=outfitter requires/, "sessions sync needs") : String(err);
  }
}

export async function uploadSessions(sessions: LocalSession[], store?: Put): Promise<string> {
  const s = storeOrError(store);
  if (typeof s === "string") return s;
  let ok = 0;
  const failed: string[] = [];
  for (const session of sessions) {
    try {
      await s.put(session.id, await completeLines(session.file), { id: session.id, name: session.name, host: hostname(), cwd: session.cwd, pushedAt: new Date().toISOString() });
      ok++;
    } catch (err) {
      failed.push(`${shortSid(session.id)}: ${err instanceof Error ? err.message.replace(/^teleport: /, "").slice(0, 160) : String(err)}`);
    }
  }
  return [`synced ${ok} of ${sessions.length} session${sessions.length === 1 ? "" : "s"}`, ...failed].join("\n");
}

/** Pick, then upload. A report line for the person, never a throw. */
export async function syncSessions(dir: string, opts: SyncPick & { store?: Put } = {}): Promise<string> {
  const picked = await pickSessions(dir, opts);
  if ("error" in picked) return picked.error;
  return uploadSessions(picked, opts.store);
}

/**
 * KERNAL_SESSION_SYNC=1: the current session goes up after a turn, without holding the turn up, and
 * only when its file grew since the last upload. The first failure is reported once per process.
 */
export function autoSyncer(store?: Put, notify: (message: string) => void = () => {}) {
  const sent = new Map<string, number>();
  let warned = false;
  return (file: string | undefined, session: { id: string; name?: string; cwd: string }): void => {
    if (!file) return;
    void (async () => {
      try {
        const body = await completeLines(file);
        if (sent.get(file) === body.length) return;
        const s = storeOrError(store);
        if (typeof s === "string") throw new Error(s);
        await s.put(session.id, body, { id: session.id, name: session.name, host: hostname(), cwd: session.cwd, pushedAt: new Date().toISOString() });
        sent.set(file, body.length);
      } catch (err) {
        if (warned) return;
        warned = true;
        notify(`sessions sync: ${err instanceof Error ? err.message.replace(/^teleport: /, "").slice(0, 160) : String(err)}`);
      }
    })();
  };
}
