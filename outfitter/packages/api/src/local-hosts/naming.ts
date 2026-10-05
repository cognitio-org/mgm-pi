// Local Host (epic #378, docs/specs/local-host.md §3.1, §2.2): every name derived from a host.
// Pure functions, so the registry (task A) and the router reconciliation (task B) compute the same
// values with no lookup.
//
// Spec-owned (local-host.md §9). Changing a derivation renames router models people have put in
// their Tapes, or orphans ngrok resources and LiteLLM entries, so it goes through the spec.

import { createHash, randomBytes } from "node:crypto";

const hex = (s: string, n: number) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);

/** Kernal's host id: `h_` + 24 lowercase hex (§4.4). */
export const HOST_ID_RE = /^h_[0-9a-f]{24}$/;
/** The api's id for a host: `lh_` + 24 lowercase hex. */
export const LOCAL_HOST_ID_RE = /^lh_[0-9a-f]{24}$/;

/** The api's id for (user, Kernal host id): one record per person per machine. Not secret. */
export function localHostId(userId: string, hostId: string): string {
  return `lh_${hex(`outfitter-local-host:${userId}:${hostId}`, 24)}`;
}

/** The DNS label of the host's ngrok internal endpoint: `lh` + the id's hex (26 characters). */
export function internalLabel(id: string): string {
  return id.replace(/^lh_/, "lh");
}

/** `https://<label>.internal`: what the laptop's agent binds. */
export function internalUrl(id: string): string {
  return `https://${internalLabel(id)}.internal`;
}

/** The only ACL the host's ngrok credential carries. */
export function credentialAcl(id: string): string[] {
  return [`bind:${internalLabel(id)}.internal`];
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A fresh, unguessable cloud endpoint label: `lh-` + 26 base32 characters (130 bits). */
export function newPublicSlug(bytes: Buffer = randomBytes(17)): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `lh-${out.slice(0, 26)}`;
}

/** Lowercase, runs of anything but [a-z0-9] to one hyphen, no hyphen at either end, at most `max`. */
export function slugify(input: string, max: number): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, max).replace(/-+$/, "");
}

/** The email's local part before any `+tag`, slugified, at most 16 characters; "user" if empty. */
export function userSlug(email: string): string {
  const local = email.trim().split("@")[0]?.split("+")[0] ?? "";
  return slugify(local, 16) || "user";
}

/** The host name without a `.local`/`.lan`/`.home`/`.localdomain` suffix, slugified, at most 20; "host" if empty. */
export function hostSlug(hostName: string): string {
  return slugify(hostName.trim().replace(/\.(local|lan|home|localdomain)$/i, ""), 20) || "host";
}

/**
 * The router prefix candidates for a new host, in order: `<user>-<host>`, then with 4 and then 8
 * hex characters of the id appended. The registry takes the first that is free under the spec's
 * user-aware rule (local-host.md §3.1: no record holds it, or only a tombstone of the same user)
 * and keeps it for the record's lifetime: renaming the machine does not rename its router models,
 * and a prefix never passes to another person.
 */
export function routerPrefixCandidates(email: string, hostName: string, id: string): string[] {
  const base = `${userSlug(email)}-${hostSlug(hostName)}`;
  const h = id.replace(/^lh_/, "");
  return [base, `${base}-${h.slice(0, 4)}`, `${base}-${h.slice(0, 8)}`];
}

/** A model id the router can carry verbatim: 1-160 of [A-Za-z0-9._:@+/-], no empty or dot-only path segment. */
export function routableModelId(id: string): boolean {
  if (!/^[A-Za-z0-9._:@+\/-]{1,160}$/.test(id)) return false;
  return id.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** `local/<routerPrefix>/<modelId>`, or undefined when the id isn't routable. */
export function routerModelName(routerPrefix: string, modelId: string): string | undefined {
  return routableModelId(modelId) ? `local/${routerPrefix}/${modelId}` : undefined;
}

/** The inverse of routerModelName for a `local/...` name (with or without Kernal's `litellm/`
 * provider prefix): the prefix and the model id, or undefined. */
export function parseRouterModelName(name: string): { routerPrefix: string; modelId: string } | undefined {
  const m = /^(?:litellm\/)?local\/([a-z0-9-]{1,48})\/(.+)$/.exec(name);
  if (!m || !routableModelId(m[2])) return undefined;
  return { routerPrefix: m[1], modelId: m[2] };
}

/** The LiteLLM deployment id (model_info.id) of one model on one host: deterministic, so a retry or
 * a second instance finds the entry instead of adding another. */
export function routerDeploymentId(id: string, modelId: string): string {
  return `${id.replace(/^lh_/, "lh-")}-${hex(`model:${modelId}`, 12)}`;
}

/** Secret Manager name of the host's bearer (§2.4). Within the `outfitter-` prefix the api may manage. */
export function bearerSecretName(id: string): string {
  return `outfitter-localhost-${id.replace(/^lh_/, "")}`;
}

/** A fresh per-host bearer: `lhb_` + 43 base64url characters (256 bits). Matches Kernal's
 * checkBearerToken pattern, so it can sit in a traffic policy expression. */
export function newBearer(bytes: Buffer = randomBytes(32)): string {
  return `lhb_${bytes.toString("base64url")}`;
}

/** sha256 hex of a bearer, the only form the api stores in Mongo. */
export function bearerHash(bearer: string): string {
  return createHash("sha256").update(bearer, "utf8").digest("hex");
}
