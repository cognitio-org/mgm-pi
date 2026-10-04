// Central sign-in, CA-4 (#393, docs/specs/central-auth.md §4): personal provider keys. A user may
// store their own OpenRouter (etc.) key next to the router's; each value is one Secret Manager
// secret named by the user's hashed id, never an email. The API is write-only towards people: the
// web and /admin set or remove a key and see its last 4 characters, and only the user's own signed-in
// Kernal (a device token) ever receives the value, at start-up. Owned by task D; routes/keys.ts
// serves it.

import type { SecretAdmin } from "../secrets.ts";
import type { ProviderKeyMeta, ProviderKeysCollection } from "../store/keys.ts";

/** v1 providers and the env var Kernal knows each one by. */
export const PROVIDER_KEY_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
} as const;

export type ProviderKeyProvider = keyof typeof PROVIDER_KEY_ENV;

export const PROVIDER_KEY_PROVIDERS = Object.keys(PROVIDER_KEY_ENV) as ProviderKeyProvider[];

export function isProviderKeyProvider(value: unknown): value is ProviderKeyProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDER_KEY_ENV, value);
}

/** `outfitter-user-<userId>-<provider>`: the user id (central/user-id.ts) keeps emails out of
 * Secret Manager names. */
export function providerKeySecretName(userId: string, provider: ProviderKeyProvider): string {
  return `outfitter-user-${userId}-${provider}`;
}

/** 8-512 printable ASCII characters, no whitespace (§4). Anything else is someone pasting the wrong
 * thing, or a line break that would break the header it ends up in. */
export function isValidProviderKeyValue(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{8,512}$/.test(value);
}

/** What GET /api/me/provider-keys lists: never the value. */
export interface ProviderKeyView {
  provider: string;
  last4: string;
  setAt: string;
}

export function providerKeyView(meta: ProviderKeyMeta): ProviderKeyView {
  return { provider: meta.provider, last4: meta.last4, setAt: meta.setAt };
}

export interface ProviderKeyDeps {
  providerKeys: ProviderKeysCollection;
  secrets: Pick<SecretAdmin, "addVersion" | "disableAllEnabled" | "accessLatest">;
  log?: (msg: string, err?: unknown) => void;
}

export async function listProviderKeys(deps: ProviderKeyDeps, userId: string): Promise<ProviderKeyView[]> {
  return (await deps.providerKeys.listForUser(userId)).map(providerKeyView);
}

/** Stores a new value: a new Secret Manager version first, then the metadata, so the list never
 * names a key that isn't there. The caller has validated `provider` and `value`. */
export async function setProviderKey(
  deps: ProviderKeyDeps,
  args: { userId: string; provider: ProviderKeyProvider; value: string; setBy: string; now?: Date },
): Promise<ProviderKeyView> {
  const secretName = providerKeySecretName(args.userId, args.provider);
  await deps.secrets.addVersion(secretName, args.value);
  const meta: ProviderKeyMeta = {
    id: `${args.userId}:${args.provider}`,
    userId: args.userId,
    provider: args.provider,
    secretName,
    last4: args.value.slice(-4),
    setAt: (args.now ?? new Date()).toISOString(),
    setBy: args.setBy,
  };
  await deps.providerKeys.upsert(meta);
  return providerKeyView(meta);
}

/** Disables every version (recoverable from the console, like the operator page's remove) and drops
 * the metadata. Idempotent: removing a key that isn't set is fine. */
export async function deleteProviderKey(deps: ProviderKeyDeps, args: { userId: string; provider: ProviderKeyProvider }): Promise<void> {
  await deps.secrets.disableAllEnabled(providerKeySecretName(args.userId, args.provider));
  await deps.providerKeys.delete(`${args.userId}:${args.provider}`);
}

/** Every stored key's value, for the user's own Kernal (POST /api/device/provider-keys). A key that
 * can't be read is left out (and logged without its value) rather than failing the rest. */
export async function deliverProviderKeys(deps: ProviderKeyDeps, userId: string): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  for (const meta of await deps.providerKeys.listForUser(userId)) {
    if (!isProviderKeyProvider(meta.provider)) continue;
    try {
      const value = await deps.secrets.accessLatest(meta.secretName);
      if (value) keys[meta.provider] = value;
    } catch (err) {
      deps.log?.(`provider keys: could not read ${meta.secretName}`, err instanceof Error ? err.message : String(err));
    }
  }
  return keys;
}
