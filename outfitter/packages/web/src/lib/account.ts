// #389 CA-7 (docs/specs/central-auth.md §3, §4, §7, §8): pure helpers for the Account page: which
// keys a level may edit, turning a form field into a value the api accepts, where a value comes
// from, and money.

import { ApiError } from "../api/client.ts";
import type { ResolvedValue, SettingDecl, SettingLevel, SettingValue } from "../api/account.ts";
import { vocabulary } from "./vocabulary.ts";

/** §4: the personal provider keys of v1, with the env var Kernal maps each onto. */
export const PROVIDERS: ReadonlyArray<{ id: string; label: string; env: string }> = [
  { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY" },
  { id: "deepgram", label: "Deepgram", env: "DEEPGRAM_API_KEY" },
  { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY" },
  { id: "gemini", label: "Gemini", env: "GEMINI_API_KEY" },
];

/** §3.3: profile names. */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** §7: the key behind the "share my local models" toggle (#381/#382 read it). */
export const SHARE_MODELS_KEY = "localHost.shareModels";

/** §4: what the api accepts as a provider key value (8-512 printable ASCII, no whitespace). */
export function providerKeyProblem(value: string): string | null {
  if (value.length < 8) return "a key is at least 8 characters";
  if (value.length > 512) return "a key is at most 512 characters";
  if (!/^[\x21-\x7e]+$/.test(value)) return "printable characters only, no spaces";
  return null;
}

/** The keys a person may set at `level`: declared, not retired, not secret, allowed there. */
export function editableDecls(settings: readonly SettingDecl[], level: SettingLevel): SettingDecl[] {
  return settings.filter((d) => !d.retired && !d.secret && d.levels.includes(level));
}

/** A form field's text for a stored value; "" means "not set here". */
export function draftFromValue(value: SettingValue | undefined): string {
  return value === undefined ? "" : String(value);
}

export type ParsedDraft = { ok: true; value: SettingValue | null } | { ok: false; problem: string };

/** A form field's text as the value a write sends: `null` (cleared: inherit) or a value valid for
 * the key's type, mirroring the api's checks so a 400 is rare. */
export function parseDraft(decl: SettingDecl, raw: string): ParsedDraft {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  switch (decl.type) {
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false, problem: "pick on or off" };
    case "enum":
      return decl.values?.includes(text) ? { ok: true, value: text } : { ok: false, problem: "pick one of the listed values" };
    case "number": {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, problem: "a number" };
      if (decl.min !== undefined && n < decl.min) return { ok: false, problem: `at least ${decl.min}` };
      if (decl.max !== undefined && n > decl.max) return { ok: false, problem: `at most ${decl.max}` };
      return { ok: true, value: n };
    }
    case "url":
      try {
        const url = new URL(text);
        if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, problem: "an http(s) URL" };
      } catch {
        return { ok: false, problem: "an http(s) URL" };
      }
      return { ok: true, value: text };
    default:
      return { ok: true, value: text };
  }
}

/** The body of a value write (§3.5): only the keys whose field differs from the stored value
 * (`null` removes one), plus the fields that don't parse. */
export function changedValues(
  decls: readonly SettingDecl[],
  stored: Record<string, SettingValue>,
  drafts: Record<string, string>,
): { values: Record<string, SettingValue | null>; problems: Record<string, string> } {
  const values: Record<string, SettingValue | null> = {};
  const problems: Record<string, string> = {};
  for (const decl of decls) {
    const raw = drafts[decl.key];
    if (raw === undefined) continue;
    const parsed = parseDraft(decl, raw);
    if (!parsed.ok) {
      problems[decl.key] = parsed.problem;
      continue;
    }
    const before = stored[decl.key];
    if (parsed.value === null ? before !== undefined : parsed.value !== before) values[decl.key] = parsed.value;
  }
  return { values, problems };
}

/** A value as the page shows it. */
export function formatValue(value: SettingValue | undefined): string {
  if (value === undefined) return "—";
  if (value === true) return "on";
  if (value === false) return "off";
  return String(value);
}

/** Where an effective value comes from, in the page's words. */
export function sourceLabel(v: Pick<ResolvedValue, "source" | "sourceName">): string {
  switch (v.source) {
    case "fleet":
      return "fleet";
    case "group":
      return "group";
    case "user":
      return `your ${vocabulary.account.one.toLowerCase()}`;
    case "profile":
      return v.sourceName ? `${vocabulary.profile.one.toLowerCase()} ${v.sourceName}` : vocabulary.profile.one.toLowerCase();
    case "device":
      return v.sourceName ? `${vocabulary.device.one.toLowerCase()} ${v.sourceName}` : vocabulary.device.one.toLowerCase();
    default:
      return "default";
  }
}

/** §3.1: a value a higher level holds so a lower one can't change it (the resolver's `locked`). */
export function isLocked(v: ResolvedValue | undefined): boolean {
  return !!v?.locked;
}

/** The read-only text beside a locked value. */
export const LOCKED_TEXT = `set by your ${vocabulary.operator.one}`;

/** The current month in UTC, as GET /api/me/spend takes it. */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUsd(amount: number): string {
  return usd.format(Number.isFinite(amount) ? amount : 0);
}

/** A write lost a race (§3.5 409 stale_version): the page says so and never overwrites. */
export function isStaleWrite(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.message === "stale_version";
}

/** The api's error codes in plain words; anything else keeps its own message. */
export function accountErrorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.message) {
    case "stale_version":
      return "Changed elsewhere: reload to see the current values.";
    case "profile_exists":
      return "A profile with that name already exists.";
    case "unknown_profile":
      return "That profile no longer exists: reload.";
    case "invalid_value":
      return "The server refused one of the values.";
    case "unknown_key":
    case "level_not_allowed":
      return "One of the settings can't be saved here.";
    case "unknown_provider":
      return "Unknown provider.";
    case "if_match_required":
      return "Reload and try again.";
    default:
      return err.message || fallback;
  }
}
