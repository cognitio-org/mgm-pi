/**
 * Outfitter calls for subscription secrets (subscriptions.md §3). The same session as provider
 * keys: getAccessToken + sendWithBearer (kernal-login/env-import.ts). Not a second auth stack.
 * Responses are parsed here and values are never logged.
 */
import { getAccessToken, loginState, outfitterApi, type SessionAccount, type SessionStorage } from "../_shared/outfitter-session.ts";
import { sendWithBearer } from "../_shared/outfitter-env.ts";
import { isVendor, type SubscriptionVendor } from "./vendors.ts";

const TIMEOUT_MS = 10_000;

export interface OutfitterCall {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  storage?: SessionStorage;
}

export function signedInAccount(io: OutfitterCall = {}): SessionAccount | undefined {
  const env = io.env ?? process.env;
  const api = outfitterApi(env);
  const state = loginState({ env, api, ...io.storage });
  return state.signedIn ? state.account : undefined;
}

export type OutfitterResult = { signedOut: true } | { status: number; body: unknown };

/** One JSON request with the session's access token. `{ signedOut }` when there is no login. */
export async function outfitterJson(io: OutfitterCall, method: string, path: string, body?: unknown): Promise<OutfitterResult> {
  const env = io.env ?? process.env;
  const api = outfitterApi(env);
  if (!signedInAccount(io)) return { signedOut: true };
  const fetchImpl = io.fetch ?? fetch;
  const storage = { env, ...io.storage, api };
  const bearer = (rejected?: string) => getAccessToken({ ...storage, fetch: fetchImpl, ...(rejected ? { rejected } : {}) });
  const res = await sendWithBearer(bearer, (token) => fetchImpl(`${api}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  const text = await res.text();
  let parsed: unknown = {};
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
  }
  return { status: res.status, body: parsed };
}

/** `error` from an Outfitter JSON body, when it is a short code. A token-shaped string is not a code. */
export function outfitterError(body: unknown): string {
  if (!body || typeof body !== "object" || !("error" in body)) return "";
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "string" || error.length > 40 || /\s/.test(error) || /[!-~]{20,}/.test(error)) return "";
  return error;
}

export type SecretList = { ok: true; vendors: Set<SubscriptionVendor> } | { ok: false; error: string } | { ok: false; signedOut: true };

/** GET /api/me/subscription-secrets. Vendors only: last4 and the value are not returned to the caller. */
export async function listSubscriptionVendors(io: OutfitterCall): Promise<SecretList> {
  try {
    const res = await outfitterJson(io, "GET", "/api/me/subscription-secrets");
    if ("signedOut" in res) return { ok: false, signedOut: true };
    if (res.status !== 200 || !Array.isArray(res.body)) return { ok: false, error: `Outfitter answered ${res.status}${outfitterError(res.body) ? `: ${outfitterError(res.body)}` : ""}` };
    const vendors = new Set<SubscriptionVendor>();
    for (const row of res.body) {
      const vendor = row && typeof row === "object" ? (row as { vendor?: unknown }).vendor : undefined;
      if (typeof vendor === "string" && isVendor(vendor)) vendors.add(vendor);
    }
    return { ok: true, vendors };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type SecretLookup = { ok: true; value?: string } | { ok: false; error: string };

/**
 * POST /api/device/subscription-secrets (device token, same role as provider keys). The value stays
 * in this result for the runner to put on the child; callers must not print it.
 */
export async function loadSubscriptionSecret(vendor: SubscriptionVendor, io: OutfitterCall = {}): Promise<SecretLookup> {
  try {
    const res = await outfitterJson(io, "POST", "/api/device/subscription-secrets", {});
    if ("signedOut" in res) return { ok: true };
    if (res.status !== 200 || !res.body || typeof res.body !== "object") {
      return { ok: false, error: `could not read the account secret (${res.status}${outfitterError(res.body) ? `: ${outfitterError(res.body)}` : ""})` };
    }
    const secrets = (res.body as { secrets?: unknown }).secrets;
    if (!secrets || typeof secrets !== "object") return { ok: true };
    const slot = (secrets as Record<string, unknown>)[vendor];
    if (!slot || typeof slot !== "object") return { ok: true };
    const value = (slot as { value?: unknown }).value;
    if (value === undefined || value === "") return { ok: true };
    if (typeof value !== "string") return { ok: false, error: "could not read the account secret" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not read the account secret" };
  }
}
