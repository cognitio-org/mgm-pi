/**
 * Pure logic for the /admin web app: the request guards, secret masking and the validation of what
 * the page sends back. Nothing here touches the network or the disk, so all of it is unit-tested.
 * Every rule about a value (how a URL is normalised, how a key is cleaned, which index settings are
 * valid) comes from the extension that owns it; this file only arranges those calls.
 */
import { timingSafeEqual } from "node:crypto";
import { cleanKey, normalizeBaseUrl } from "../connect/lib.ts";
import { FIELDS, getAt, maskSecret, type Field } from "../mgm-codebase-index/lib.ts";

export const DEFAULT_IDLE_MINUTES = 15;
export const TOKEN_HEADER = "x-mgm-admin-token";
/** Status polls carry this so an open tab alone does not keep the server alive forever. */
export const POLL_HEADER = "x-mgm-poll";
export const MAX_BODY = 64 * 1024;

/** MGM_ADMIN_IDLE_MINUTES, else 15; fractions allowed (tests), nonsense falls back to the default. */
export function idleMs(env: Record<string, string | undefined>): number {
  const n = Number(env.MGM_ADMIN_IDLE_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MINUTES) * 60_000;
}

// ---------- request guards ----------
/**
 * DNS rebinding: a hostile page can make its own hostname resolve to 127.0.0.1, and the browser then
 * sends that hostname in Host. Only the two names this server is really reached by are accepted.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/**
 * Browsers send Origin on every cross-origin request and on every POST. Absent is a non-browser
 * client (curl), which still needs the token; present must be this server itself.
 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === "") return true;
  const o = origin.trim().toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

/** Constant-time comparison, so the token cannot be guessed a character at a time. */
export function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- secrets ----------
const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization)$/i;

/** A copy with every secret-looking string replaced by maskSecret's `set (…1234)`. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) && typeof v === "string" ? maskSecret(v) : redactSecrets(v);
  return out as T;
}

/** Every secret value the agent holds, for tests and for a last check before a response leaves. */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /(KEY|TOKEN|SECRET|PASSWORD)$/.test(k) && typeof v === "string" && v.trim().length >= 8)
    .map(([, v]) => cleanKey(v));
}

/** True when the text carries any of the secrets in full (a masked tail is fine). */
export const leaksSecret = (text: string, secrets: string[]) => secrets.some((s) => s.length >= 8 && text.includes(s));

// ---------- connections ----------
export const DEFAULT_ROUTER = "https://litellm.augment-code.support/v1";
export const DEFAULT_LOCAL = "http://localhost:1234/v1";

/** What the Connections page shows: URLs as they are, keys only as `set (…1234)`. */
export function connectionsView(env: Record<string, string | undefined>) {
  const routerKey = env.LITELLM_AGENT_KEY || env.LITELLM_API_KEY;
  return {
    MGM_USER: env.MGM_USER ?? "",
    LITELLM_BASE_URL: normalizeBaseUrl(env.LITELLM_BASE_URL ?? "", DEFAULT_ROUTER),
    LITELLM_AGENT_KEY: maskSecret(cleanKey(routerKey)),
    routerKeyFrom: env.LITELLM_AGENT_KEY ? "LITELLM_AGENT_KEY" : env.LITELLM_API_KEY ? "LITELLM_API_KEY" : undefined,
    OPENROUTER_API_KEY: maskSecret(cleanKey(env.OPENROUTER_API_KEY)),
    LMSTUDIO_BASE_URL: normalizeBaseUrl(env.LMSTUDIO_BASE_URL ?? "", DEFAULT_LOCAL),
    LMSTUDIO_MODEL: env.LMSTUDIO_MODEL ?? "",
  };
}

export type ConnectionEdit = Partial<Record<"MGM_USER" | "LITELLM_BASE_URL" | "LITELLM_AGENT_KEY" | "OPENROUTER_API_KEY" | "LMSTUDIO_BASE_URL" | "LMSTUDIO_MODEL", string>> & { clear?: string[] };
const KEYS = ["LITELLM_AGENT_KEY", "OPENROUTER_API_KEY"];

/**
 * Turn what the form sent into .env values, as /setup would: URLs through normalizeBaseUrl, keys
 * through cleanKey, a blank key meaning "keep the one saved". Errors and warnings are per field so
 * the page can show them next to the control.
 */
export function validateConnections(body: ConnectionEdit): { values: Record<string, string>; errors: Record<string, string>; warnings: Record<string, string> } {
  const values: Record<string, string> = {}, errors: Record<string, string> = {}, warnings: Record<string, string> = {};
  const oneLine = (field: string, v: string) => { if (/[\r\n\0]/.test(v)) { errors[field] = "must be a single line"; return false; } return true; };
  for (const field of ["LITELLM_BASE_URL", "LMSTUDIO_BASE_URL"] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (!oneLine(field, raw)) continue;
    const url = normalizeBaseUrl(raw, field === "LITELLM_BASE_URL" ? DEFAULT_ROUTER : DEFAULT_LOCAL);
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error(); values[field] = url; }
    catch { errors[field] = "not a valid http(s) URL"; }
  }
  for (const field of KEYS) {
    const raw = (body as any)[field];
    if (raw === undefined || raw === "") continue;          // blank keeps the saved key
    if (typeof raw !== "string" || !oneLine(field, raw)) continue;
    const key = cleanKey(raw);
    if (!key) continue;
    if (/\s/.test(key)) { errors[field] = "a key has no spaces in it; paste just the key"; continue; }
    values[field] = key;
    if (field === "OPENROUTER_API_KEY" && !key.startsWith("sk-or-")) warnings[field] = "OpenRouter keys start with sk-or-v1-; saved anyway";
  }
  for (const field of ["MGM_USER", "LMSTUDIO_MODEL"] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (!oneLine(field, raw)) continue;
    const v = raw.trim();
    if (v.length > 120) { errors[field] = "too long"; continue; }
    values[field] = v;
  }
  for (const field of body.clear ?? []) {
    if (!KEYS.includes(field)) { errors[field] = "only a key can be removed"; continue; }
    if (values[field]) { errors[field] = "replace or remove, not both"; continue; }
    values[field] = "";
  }
  return { values, errors, warnings };
}

// ---------- codebase index ----------
export type FieldView = { id: string; path: string[]; label: string; kind: Field["kind"]; choices?: string[]; min?: number; max?: number; help: string; value: unknown; group: string };

const GROUPS: Record<string, string> = { customProvider: "embeddings", embeddingProvider: "embeddings", indexing: "indexing", search: "search", reranker: "reranking" };

/** Every field /index can edit, with its current value; secrets never appear (none are in FIELDS). */
export function indexFields(config: Record<string, any>): FieldView[] {
  return FIELDS.map((f) => ({ id: f.path.join("."), path: f.path, label: f.label, kind: f.kind, choices: f.choices, min: f.min, max: f.max, help: f.help, value: redactSecrets(getAt(config, f.path)), group: GROUPS[f.path[0]] ?? "other" }));
}

export const fieldById = (id: string) => FIELDS.find((f) => f.path.join(".") === id);

// ---------- overview ----------
export type Pill = "ok" | "warn" | "error" | "off";

/** One word and a colour per backend, from what connect knows. */
export function backendPill(b: { id: string; hasKey: boolean; registered: boolean; answered: boolean; rejected?: string; models: string[] }): { pill: Pill; text: string; detail: string } {
  if (!b.hasKey) return { pill: "off", text: "not configured", detail: "no key saved" };
  if (b.rejected) return { pill: "error", text: "key rejected", detail: b.rejected };
  if (b.id === "lmstudio") return b.answered ? { pill: "ok", text: "reachable", detail: `${b.models.length} models` } : { pill: "warn", text: "unreachable", detail: "the local server did not answer" };
  if (!b.registered) return { pill: "error", text: "unavailable", detail: "not registered" };
  return { pill: "ok", text: "connected", detail: `${b.models.length} models` };
}
