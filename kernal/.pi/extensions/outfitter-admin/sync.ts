/**
 * Opt-in upload of local sessions to Outfitter (outfitter/docs/specs/sysop-tools.md, "Opt-in upload
 * of local sessions"), through teleport's own import route, so they get Outfitter's semantic and
 * hybrid search. An uploaded session also appears in Outfitter's floppy list, like a teleported one.
 * Nothing is uploaded unless the person runs `/sessions sync` or sets KERNAL_SESSION_SYNC=1.
 */
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { OutfitterStore } from "../teleport/outfitter-store.ts";
import { loadAll } from "./local-sessions.ts";

export async function syncSessions(dir: string, opts: { id?: string; since?: string; quiet?: boolean; store?: Pick<OutfitterStore, "put"> } = {}): Promise<string> {
  let store: Pick<OutfitterStore, "put">;
  try {
    store = opts.store ?? new OutfitterStore();
  } catch (err) {
    return err instanceof Error ? err.message.replace(/^teleport: KERNAL_TELEPORT_STORE=outfitter requires/, "sessions sync needs") : String(err);
  }
  const all = await loadAll(dir);
  let picked = all;
  if (opts.id) picked = all.filter((s) => s.id === opts.id || (opts.id!.length >= 8 && s.id.startsWith(opts.id!)));
  else if (opts.since) {
    const rel = /^(\d+)([hdw])$/.exec(opts.since);
    const ms = rel ? Number(rel[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2] as "h"] : NaN;
    if (!Number.isFinite(ms)) return "--since takes 12h, 7d or 2w";
    const cutoff = new Date(Date.now() - ms).toISOString();
    picked = all.filter((s) => s.updatedAt >= cutoff);
  } else return "name a session id or --since 7d";
  if (!picked.length) return "no matching local sessions";
  let ok = 0;
  const failed: string[] = [];
  for (const s of picked) {
    try {
      const jsonl = await readFile(s.file, "utf8");
      await store.put(s.id, jsonl, { id: s.id, name: s.name, host: hostname(), cwd: s.cwd, pushedAt: new Date().toISOString() });
      ok++;
    } catch (err) {
      failed.push(`${s.id.slice(0, 8)}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
  return [`synced ${ok} of ${picked.length} session${picked.length === 1 ? "" : "s"}`, ...failed].join("\n");
}
