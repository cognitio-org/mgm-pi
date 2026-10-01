// E9 §5.4: whose Agent Engine memory a session reads and writes. An A2A task's session never uses
// its key owner's identity, in either direction: a remote caller's prompt must not be extracted
// into the owner's long-term memory, and the owner's private memories must not be recalled into a
// session whose output goes back to the caller. Memory saved under one key stays with that key.
// PR3's agentengine/identity.ts follows the same rule (owner-agreed field names: Session.origin
// "a2a" and Session.a2aTokenId).

import { createHash } from "node:crypto";
import type { Session } from "../store/types.ts";

/** §3.2: a Drive's memory userId is the first 16 hex of sha256 of its owner's email, trimmed and
 * lowercased, so no email leaves Outfitter. */
export function ownerMemoryUserId(ownerEmail: string): string {
  return createHash("sha256").update(ownerEmail.trim().toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

/** The memory userId for a session: `a2a:<tokenId>` for an A2A task's session, the owner's hash
 * otherwise. Undefined (no memory) for an A2A session without its key id, or a session with no
 * owner: neither may fall back to someone else's memory. */
export function memoryUserId(session: Pick<Session, "origin" | "a2aTokenId" | "ownerEmail">): string | undefined {
  if (session.origin === "a2a") return session.a2aTokenId ? `a2a:${session.a2aTokenId}` : undefined;
  return session.ownerEmail ? ownerMemoryUserId(session.ownerEmail) : undefined;
}
