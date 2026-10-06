// Personal subscription workers (docs/specs/subscriptions.md §3): a write-only secret per vendor,
// sibling of provider keys, not a provider id. Claude is one line of printable ASCII. Grok, Codex
// and Gemini are UTF-8 file contents. The list shows last4 and the Secret Manager version; only a
// device token receives the value. routes/keys.ts serves it.

import { createHash } from "node:crypto";
import type { SecretAdmin } from "../secrets.ts";
import type { SubscriptionSecretMeta, SubscriptionSecretsCollection } from "../store/keys.ts";
import { SUBSCRIPTION_VENDORS, type SubscriptionVendor } from "./settings-schema.ts";

export function isSubscriptionVendor(value: unknown): value is SubscriptionVendor {
  return typeof value === "string" && (SUBSCRIPTION_VENDORS as readonly string[]).includes(value);
}

/** `outfitter-user-<userId>-subscription-<vendor>`: the user id keeps emails out of Secret Manager names. */
export function subscriptionSecretName(userId: string, vendor: SubscriptionVendor): string {
  return `outfitter-user-${userId}-subscription-${vendor}`;
}

/** `<userId>:subscription:<vendor>`. */
export function subscriptionSecretId(userId: string, vendor: SubscriptionVendor): string {
  return `${userId}:subscription:${vendor}`;
}

const CLAUDE_SECRET_RE = /^[\x21-\x7e]{20,4096}$/;
const MAX_FILE_BYTES = 262144;

/** Claude: one line, 20–4096 printable ASCII, no whitespace. The others: UTF-8, 1–262144 bytes, no NUL. */
export function isValidSubscriptionValue(vendor: SubscriptionVendor, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (vendor === "claude") return CLAUDE_SECRET_RE.test(value);
  if (value.length === 0 || value.includes("\0")) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 1 && bytes <= MAX_FILE_BYTES;
}

/** Last 4 hex digits of sha256 of the exact stored bytes. Not a tail of the value. */
export function subscriptionLast4(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(-4);
}

/** What GET /api/me/subscription-secrets lists: never the value. */
export interface SubscriptionSecretView {
  vendor: string;
  last4: string;
  setAt: string;
  version: number;
}

export function subscriptionSecretView(meta: SubscriptionSecretMeta): SubscriptionSecretView {
  return { vendor: meta.vendor, last4: meta.last4, setAt: meta.setAt, version: meta.version };
}

export interface SubscriptionSecretDeps {
  subscriptionSecrets: SubscriptionSecretsCollection;
  secrets: Pick<SecretAdmin, "addVersion" | "disableAllEnabled" | "disableVersion" | "accessVersion">;
  log?: (msg: string, err?: unknown) => void;
}

export async function listSubscriptionSecrets(deps: SubscriptionSecretDeps, userId: string): Promise<SubscriptionSecretView[]> {
  return (await deps.subscriptionSecrets.listForUser(userId)).map(subscriptionSecretView);
}

export type SetSubscriptionSecretResult =
  | { ok: true; view: SubscriptionSecretView }
  | { ok: false; error: "version_conflict"; version: number | null };

/** Stores a new value. When `ifVersion` is set and it is not the stored version, nothing is written
 * (no Secret Manager version). A lost metadata compare-and-swap disables only the version just
 * added. `version` on a conflict is the stored version, or null when no secret is stored yet. */
export async function setSubscriptionSecret(
  deps: SubscriptionSecretDeps,
  args: { userId: string; vendor: SubscriptionVendor; value: string; setBy: string; ifVersion?: number; now?: Date },
): Promise<SetSubscriptionSecretResult> {
  const id = subscriptionSecretId(args.userId, args.vendor);
  if (args.ifVersion !== undefined) {
    const current = await deps.subscriptionSecrets.get(id);
    if (current?.version !== args.ifVersion) return { ok: false, error: "version_conflict", version: current?.version ?? null };
  }
  const secretName = subscriptionSecretName(args.userId, args.vendor);
  const version = await deps.secrets.addVersion(secretName, args.value);
  const meta: SubscriptionSecretMeta = {
    id,
    userId: args.userId,
    vendor: args.vendor,
    secretName,
    version,
    last4: subscriptionLast4(args.value),
    setAt: (args.now ?? new Date()).toISOString(),
    setBy: args.setBy,
  };
  try {
    const held = await holdSubscriptionVersion(deps, meta, args.ifVersion);
    if (!held.ok) {
      const stored = await deps.subscriptionSecrets.get(id);
      // Same version number is the Secret Manager version metadata already names.
      if (stored?.version !== version) await deps.secrets.disableVersion(secretName, version);
      return { ok: false, error: "version_conflict", version: stored?.version ?? null };
    }
    return held;
  } catch (err) {
    await deps.secrets.disableVersion(secretName, version);
    throw err;
  }
}

/** Publishes `meta` without moving the stored version backward. `ifVersion` is a single attempt:
 * retrying would publish bytes the caller did not condition on. Without it, the higher Secret
 * Manager version wins, and a lower one that already lost to a higher stored version does not. */
async function holdSubscriptionVersion(
  deps: SubscriptionSecretDeps,
  meta: SubscriptionSecretMeta,
  ifVersion: number | undefined,
): Promise<SetSubscriptionSecretResult> {
  if (ifVersion !== undefined) {
    const won = await deps.subscriptionSecrets.compareAndSwap(meta, ifVersion);
    if (won) return { ok: true, view: subscriptionSecretView(meta) };
    const current = await deps.subscriptionSecrets.get(meta.id);
    return { ok: false, error: "version_conflict", version: current?.version ?? null };
  }
  for (;;) {
    const current = await deps.subscriptionSecrets.get(meta.id);
    const expected = current?.version ?? null;
    if (expected !== null && expected >= meta.version) return { ok: false, error: "version_conflict", version: expected };
    const won = await deps.subscriptionSecrets.compareAndSwap(meta, expected);
    if (won) return { ok: true, view: subscriptionSecretView(meta) };
    const again = await deps.subscriptionSecrets.get(meta.id);
    if ((again?.version ?? null) === expected) return { ok: false, error: "version_conflict", version: again?.version ?? null };
  }
}

/** Disables every version and drops the metadata. Idempotent: removing a secret that isn't set is fine. */
export async function deleteSubscriptionSecret(deps: SubscriptionSecretDeps, args: { userId: string; vendor: SubscriptionVendor }): Promise<void> {
  await deps.secrets.disableAllEnabled(subscriptionSecretName(args.userId, args.vendor));
  await deps.subscriptionSecrets.delete(subscriptionSecretId(args.userId, args.vendor));
}

export interface DeliveredSubscriptionSecret {
  value: string;
  version: number;
}

/** Every stored secret's value, for the user's own Kernal (POST /api/device/subscription-secrets).
 * The bytes are the Secret Manager version recorded in metadata, not whichever is latest.
 * One that can't be read is left out (and logged without its value) rather than failing the rest. */
export async function deliverSubscriptionSecrets(deps: SubscriptionSecretDeps, userId: string): Promise<Record<string, DeliveredSubscriptionSecret>> {
  const secrets: Record<string, DeliveredSubscriptionSecret> = {};
  for (const meta of await deps.subscriptionSecrets.listForUser(userId)) {
    if (!isSubscriptionVendor(meta.vendor)) continue;
    try {
      const value = await deps.secrets.accessVersion(meta.secretName, meta.version);
      if (value) secrets[meta.vendor] = { value, version: meta.version };
    } catch (err) {
      deps.log?.(`subscription secrets: could not read ${meta.secretName}`, err instanceof Error ? err.message : String(err));
    }
  }
  return secrets;
}
