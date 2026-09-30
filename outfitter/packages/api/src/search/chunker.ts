// Search chunks from pi entries (Sysop tools, #289): one short, redacted piece of text per entry
// that says something -- user and assistant words, tool calls with their arguments, the first part
// of each tool result (where errors show up), and summaries. Plus one chunk per session for its
// name, first prompt, tape and repo. The full transcript stays in `entries`; this is only what
// search matches on (Atlas Search and the auto-embedded vector index, deploy/atlas-search.sh).

import type { PiEntry, Session, SessionChunk } from "../store/types.ts";

export type { SessionChunk };
import { readableEntry, type EntryRole } from "./transcript.ts";
import { redact } from "./redact.ts";

/** How much of a tool's output is indexed: errors and their context, not whole file dumps. */
export const TOOL_OUTPUT_CHARS = 2_000;
/** Cap on any one chunk, which also bounds embedding cost per entry. */
export const CHUNK_CHARS = 4_000;


function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

type SessionMeta = Pick<Session, "id" | "guruId" | "ownerEmail" | "repo" | "name" | "prompt" | "createdAt">;

function base(session: SessionMeta) {
  return {
    sessionId: session.id,
    ownerEmail: session.ownerEmail?.toLowerCase(),
    guruId: session.guruId,
    ...(session.repo ? { repo: session.repo } : {}),
  };
}

/** The chunk for one entry, or undefined when the entry carries nothing worth searching. */
export function chunkEntry(session: SessionMeta, entry: PiEntry, fallbackTime?: string): SessionChunk | undefined {
  const parts = readableEntry(entry);
  if (!parts) return undefined;
  let text: string;
  if (parts.role === "tool") {
    text = `${parts.tool}${parts.isError ? " (error)" : ""}: ${cut(parts.text, TOOL_OUTPUT_CHARS)}`;
  } else {
    const calls = parts.calls.map((c) => `→ ${c.name}(${c.args})`).join("\n");
    text = [parts.text, calls, parts.failed ? `failed: ${parts.failed}` : ""].filter(Boolean).join("\n");
  }
  text = cut(redact(text).trim(), CHUNK_CHARS);
  if (!text) return undefined;
  return {
    id: `${session.id}:${entry.id}`,
    ...base(session),
    entryId: entry.id,
    role: parts.role,
    ...(parts.tool ? { tool: parts.tool } : {}),
    ...(parts.isError ? { isError: true } : {}),
    createdAt: parts.timestamp ?? fallbackTime ?? session.createdAt,
    text,
  };
}

/** The session chunk: what someone would call the session when looking for it. */
export function chunkSession(session: SessionMeta): SessionChunk {
  const text = [session.name, session.prompt, `tape ${session.guruId}`, session.repo ? `repo ${session.repo}` : ""].filter(Boolean).join("\n");
  return {
    id: `${session.id}:session`,
    ...base(session),
    entryId: "session",
    role: "session",
    createdAt: session.createdAt,
    text: cut(redact(text), CHUNK_CHARS),
  };
}
