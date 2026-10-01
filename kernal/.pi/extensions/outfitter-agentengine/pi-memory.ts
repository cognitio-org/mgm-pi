/**
 * pi-memory on a laptop with Agent Engine memory on (outfitter/docs/specs/atlas-agent-engine-and-
 * a2a.md §3.5): one memory, not two.
 *
 * - Its seven tools are taken out of the active set at session start (PI_MEMORY_TOOLS, the same list
 *   agentd excludes in a Drive).
 * - Its prompt injection and exit summary are off from the start: bin/kernal points PI_MEMORY_DIR at
 *   an empty directory and sets PI_MEMORY_EXIT_SUMMARY=0 before pi starts, because pi-memory reads
 *   its directory when it is imported, which may be before this extension runs. bin/kernal keeps the
 *   real directory in KERNAL_PI_MEMORY_SOURCE for the import below and sets KERNAL_PI_MEMORY_OFF=1.
 *   This extension also sets PI_MEMORY_EXIT_SUMMARY=0 itself (pi-memory reads that one at exit).
 * - A one-time import brings MEMORY.md's notes over as semantic memories: listed first, then saved
 *   on the person's yes. Each note's label is `pi-memory <hash of its text>`, which the API
 *   namespaces under the owner, so importing twice upserts the same memories instead of doubling
 *   them. Daily logs and the scratchpad stay where they are (they are running notes, not facts;
 *   Agent Engine extracts episodes from recorded turns instead).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi-memory 0.4's tools (agentd/src/guru.ts PI_MEMORY_TOOLS). */
export const PI_MEMORY_TOOLS = ["memory_write", "memory_read", "memory_search", "memory_forget", "memory_restore", "memory_status", "scratchpad"] as const;

/** The API's `memory.save` text limit. */
const MAX_NOTE = 4_000;
const MAX_NOTES = 300;

/** Where the person's pi-memory notes are: what bin/kernal saved, else pi-memory's own default. */
export function piMemorySource(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KERNAL_PI_MEMORY_SOURCE?.trim()) return env.KERNAL_PI_MEMORY_SOURCE.trim();
  if (env.PI_MEMORY_DIR?.trim() && env.KERNAL_PI_MEMORY_OFF !== "1") return env.PI_MEMORY_DIR.trim();
  return join(env.HOME || homedir(), ".pi", "agent", "memory");
}

/** True when bin/kernal turned pi-memory's prompt injection off for this process. */
export function piMemoryInjectionOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KERNAL_PI_MEMORY_OFF === "1";
}

/** The active tools without pi-memory's. */
export function withoutPiMemoryTools(active: readonly string[]): string[] {
  const drop = new Set<string>(PI_MEMORY_TOOLS);
  return active.filter((name) => !drop.has(name));
}

export interface ImportNote {
  text: string;
  label: string;
}

const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * MEMORY.md as notes: one per bullet (with its continuation lines) or paragraph, prefixed with the
 * heading it sits under; pi-memory's `<!-- timestamp [session] -->` stamps dropped; duplicates (by
 * text, ignoring case and spacing) dropped; each capped to the API's limit.
 */
export function parseMemoryFile(markdown: string): ImportNote[] {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "\n").split(/\r?\n/);
  const notes: string[] = [];
  let heading = "";
  let current: string[] = [];
  const flush = () => {
    const body = current.join(" ").replace(/\s+/g, " ").trim();
    current = [];
    if (body.replace(/[^A-Za-z0-9]/g, "").length < 3) return;
    notes.push(heading ? `${heading}: ${body}` : body);
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[1].replace(/#+\s*$/, "").trim();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const bullet = /^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      flush();
      current.push(bullet[1]);
      continue;
    }
    current.push(line.trim());
  }
  flush();
  const seen = new Set<string>();
  const out: ImportNote[] = [];
  for (const note of notes) {
    const text = note.length <= MAX_NOTE ? note : `${note.slice(0, MAX_NOTE - 1)}…`;
    const key = normal(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, label: `pi-memory ${createHash("sha256").update(key).digest("hex").slice(0, 10)}` });
    if (out.length >= MAX_NOTES) break;
  }
  return out;
}

/** The notes to import from `dir`'s MEMORY.md; none when it is missing or empty. */
export async function importPlan(dir: string): Promise<{ file: string; notes: ImportNote[] }> {
  const file = join(dir, "MEMORY.md");
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    // No MEMORY.md: nothing to import.
  }
  return { file, notes: parseMemoryFile(text) };
}
