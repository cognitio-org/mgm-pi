// Who a session is to Agent Engine memory (E9 §3.2, §5.4), and the keys its saves use.
//
// - A Drive: userId = sha256(ownerEmail, trimmed and lowercased) first 16 hex, so no email leaves
//   Outfitter; sessionId = the Outfitter session id.
// - A laptop (E9.9, laptopIdentity): the Dongle owner's hash, the same as their Drives; sessionId =
//   `laptop:<pi session id>`.
// - An A2A session (Session.origin === "a2a", set by PR5): userId = `a2a:<a2aTokenId>`, never the
//   owner's. A remote caller's prompts must not reach the owner's memory, and the owner's memory
//   must not reach a caller. So such a session gets no recordTurn, no org reads, and no shared or
//   taxonomic saves. Without a token id it gets no memory at all (fail closed).
//
// Labels and procedure names are unique per project (memory-server indexes), and saveSemantic
// upserts, so every key is namespaced `<owner>:<repo|_>:<slug>`. The model never sees the prefix
// (stripNamespaces).

import { createHash } from "node:crypto";
import type { Session } from "../store/types.ts";

export interface MemoryIdentity {
  userId: string;
  sessionId: string;
  /** True for an A2A session (see the module doc). */
  a2a: boolean;
  /** The first part of every namespaced key: the Drive's user hash, or `a2a-<hash of the key id>`. */
  owner: string;
  /** The session's repo, lowercased (`owner/name`), or undefined for a repo-less session. */
  repo?: string;
}

function sha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** sha256(email.trim().toLowerCase())[:16], the same as voice.ts's per-user Deepgram tag. */
export function memoryUserHash(email: string): string {
  return sha16(email.trim().toLowerCase());
}

export function memoryIdentity(session: Pick<Session, "id" | "ownerEmail" | "repo" | "origin" | "a2aTokenId">): MemoryIdentity | undefined {
  const repo = session.repo?.trim().toLowerCase() || undefined;
  // A token id without the marker counts as A2A too: a session that came from a key must never fall
  // back to the owner's identity because one field was lost (a fork, a restore, a store write).
  if (session.origin !== undefined || session.a2aTokenId !== undefined) {
    // Anything but "a2a" is a marker this code doesn't know: refuse rather than treat it as a Drive.
    if (session.origin !== "a2a") return undefined;
    const tokenId = session.a2aTokenId?.trim();
    if (!tokenId) return undefined;
    return { userId: `a2a:${tokenId}`, sessionId: session.id, a2a: true, owner: `a2a-${sha16(tokenId).slice(0, 12)}`, ...(repo ? { repo } : {}) };
  }
  const email = session.ownerEmail?.trim();
  if (!email) return undefined;
  const userId = memoryUserHash(email);
  return { userId, sessionId: session.id, a2a: false, owner: userId, ...(repo ? { repo } : {}) };
}

/** A laptop's `sessionId` (E9.9): `laptop:` and a pi session id (a UUID today). */
export const LAPTOP_SESSION = /^laptop:[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
/** A GitHub `owner/name`, lowercased: what a laptop may name as its repo. */
export const LAPTOP_REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

/**
 * A laptop's identity (E9.9): the Dongle owner's, the same hash their Drives use, so laptop and
 * cloud share one memory. The session id and repo come from the client, already validated
 * (routes/admin.ts): the session id only names the episodes and recorded turns, and the repo only
 * scopes reads within the owner's own memory, so neither can reach anyone else's.
 */
export function laptopIdentity(email: string, laptop: { sessionId: string; repo?: string }): MemoryIdentity | undefined {
  const clean = email?.trim();
  if (!clean || !LAPTOP_SESSION.test(laptop.sessionId)) return undefined;
  const repo = laptop.repo?.trim().toLowerCase() || undefined;
  if (repo && !LAPTOP_REPO.test(repo)) return undefined;
  const userId = memoryUserHash(clean);
  return { userId, sessionId: laptop.sessionId, a2a: false, owner: userId, ...(repo ? { repo } : {}) };
}

/** `owner/name` -> `owner~name` (GitHub names never hold `~` or `:`), or `_` without a repo. */
export function repoSlug(repo: string | undefined): string {
  return repo ? repo.replace(/\//g, "~") : "_";
}

/** Lowercase words joined by `-`, at most 60 characters. Empty when nothing usable is left. */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/**
 * The namespaced key for a label or procedure name: the model's label as a slug, or, without one,
 * the first words of the text plus a short hash of it (so two facts that start alike don't upsert
 * over each other). Undefined when neither gives a slug.
 */
export function namespacedKey(id: Pick<MemoryIdentity, "owner" | "repo">, label: string | undefined, text: string): string | undefined {
  let slug = label ? slugOf(label) : "";
  if (!slug) {
    const words = slugOf(text.split(/\s+/).slice(0, 8).join(" "));
    if (!words) return undefined;
    slug = `${words.slice(0, 50).replace(/-+$/g, "")}-${sha16(text).slice(0, 6)}`;
  }
  return `${id.owner}:${repoSlug(id.repo)}:${slug}`;
}

const NAMESPACE = /\b(?:[0-9a-f]{16}|a2a-[0-9a-f]{12}):([^\s:]+):(?=[a-z0-9])/g;

/** The repo part (`owner~name` or `_`) of every namespaced key in `text`. */
export function namespacedRepos(text: string): string[] {
  return [...text.matchAll(new RegExp(NAMESPACE.source, "g"))].map((m) => m[1]);
}

/** Takes the `<owner>:<repo>:` prefix off any key in recalled text. */
export function stripNamespaces(text: string): string {
  return text.replace(NAMESPACE, "");
}
