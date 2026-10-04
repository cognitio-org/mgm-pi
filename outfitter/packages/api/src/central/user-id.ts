// Central sign-in (#389, docs/specs/central-auth.md §1.1): the Outfitter user id. Users are keyed by
// email everywhere else in the store; the id is derived from it, so every instance, role and task
// computes the same value with no lookup and no migration. It names a person where an email must
// not appear: LiteLLM's `user_id` (CA-5) and the Secret Manager names of personal keys (CA-4).
//
// Spec-owned (central-auth.md §9): change it only through the spec. A different derivation would
// orphan every LiteLLM user and personal key already created.

import { createHash } from "node:crypto";

/** The trimmed, lowercased email the id is derived from (IAP emails are lowercase already). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `u_` + the first 24 hex characters of sha256("outfitter-user:" + normalized email). Stable and
 * not an email, though not a secret either: anyone holding a candidate email can compute it. */
export function userIdFor(email: string): string {
  return "u_" + createHash("sha256").update(`outfitter-user:${normalizeEmail(email)}`, "utf8").digest("hex").slice(0, 24);
}
