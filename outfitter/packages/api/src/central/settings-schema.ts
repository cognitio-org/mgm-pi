// Central settings, CA-3 (#392, docs/specs/central-auth.md §3): every setting a Kernal (laptop or
// Drive) reads from Outfitter is declared here once. Owned by task C; the declaration format and
// the v1 key list are the contract Kernal (CA-8, CA-9) and the web (CA-7) build against, so a
// change to either goes through the spec.
//
// Rules that keep old Kernals working (§3.6): a key is never renamed and its type never changes.
// A new key gets `since: SETTINGS_SCHEMA_VERSION + 1` and the version is bumped; an older Kernal
// ignores keys it doesn't know. A retired key stays declared with `retired: true`.

/** The levels, highest authority first. "local" is the machine itself (Kernal's own overrides,
 * .env and the shell); the server never stores or returns it, but declares whether it may set a
 * key, so Kernal enforces the same rule. "group" is reserved: everyone is in `everyone`. */
export const SETTING_LEVELS = ["fleet", "group", "user", "profile", "device", "local"] as const;
export type SettingLevel = (typeof SETTING_LEVELS)[number];

/** How a lower level (closer to the machine) may change a value a higher level set:
 * - "any": the lowest level that sets it wins (fleet values are defaults).
 * - "opt-out": booleans only; any level may turn it off, none below the first `true` may turn it
 *   on (Sentry's rule). The value is the AND of every level that sets it.
 * - "none": the highest level that sets it wins; lower levels are ignored (the value is locked). */
export type OverrideRule = "none" | "opt-out" | "any";

export type SettingType = "string" | "boolean" | "number" | "enum" | "url";

export type SettingValue = string | number | boolean;

export interface SettingDecl {
  /** Dotted, lowercase-camel segments: `model.default`, `telemetry.sentry.enabled`. */
  key: string;
  type: SettingType;
  /** For type "enum". */
  values?: readonly string[];
  /** For type "number". */
  min?: number;
  max?: number;
  /** For type "number": whole numbers only. */
  integer?: boolean;
  /** Never cached on disk by Kernal, never shown back to the web, never in GET /api/config: a secret
   * reaches a device by its own delivery path (`delivery`). */
  secret: boolean;
  /** Where a secret comes from: "login" (with the device tokens, CA-5's router key). */
  delivery?: "login";
  /** Which levels may set it. A write to any other level is refused (400 level_not_allowed). */
  levels: readonly SettingLevel[];
  override: OverrideRule;
  /** Used when no level sets it. Absent: the key resolves to no value at all (Kernal's own default). */
  default?: SettingValue;
  /** Env vars Kernal maps onto this key at the "local" level (CA-8), first one set wins. */
  env?: readonly string[];
  /** Schema version that introduced the key. */
  since: number;
  retired?: boolean;
  /** One line for /config and the web. */
  description: string;
}

/** Bumped whenever a key is added or retired (§3.6). */
export const SETTINGS_SCHEMA_VERSION = 2;

const PERSONAL = ["fleet", "user", "profile", "device", "local"] as const;

/** Router key limits (#389 follow-up, §5.2): what api/central/litellm-keys.ts mints device and run
 * keys with, read from the fleet level at mint time. Operators only: the fleet level, locked. */
const ROUTER_LIMIT = { secret: false, levels: ["fleet"], override: "none", since: 1 } as const;

/** #424's Sentry signal switches: telemetry.sentry.enabled's shape (fleet on, local opt-out). */
const SENTRY_SIGNAL = { type: "boolean", secret: false, levels: ["fleet", "local"], override: "opt-out", default: false, since: 2 } as const;

/** The v1 keys (spec §3.2). */
export const SETTINGS_SCHEMA: readonly SettingDecl[] = [
  {
    key: "router.baseUrl",
    type: "url",
    secret: false,
    levels: ["fleet", "local"],
    override: "none",
    default: "https://router.kernal.one/v1",
    env: ["LITELLM_BASE_URL"],
    since: 1,
    description: "The LiteLLM router this machine's router key is for.",
  },
  {
    key: "router.key",
    type: "string",
    secret: true,
    delivery: "login",
    levels: ["device", "local"],
    override: "any",
    env: ["LITELLM_AGENT_KEY", "LITELLM_API_KEY"],
    since: 1,
    description: "This device's own router key, minted at sign-in (CA-5); never stored by Outfitter.",
  },
  {
    ...ROUTER_LIMIT,
    key: "router.deviceKey.durationDays",
    type: "number",
    min: 1,
    max: 365,
    integer: true,
    default: 90,
    description: "Days a device's router key lives before Kernal re-mints it (LiteLLM duration).",
  },
  {
    ...ROUTER_LIMIT,
    key: "router.deviceKey.maxBudgetUsd",
    type: "number",
    min: 0,
    max: 100_000,
    default: 50,
    description: "USD a device's router key may spend per budget period.",
  },
  {
    ...ROUTER_LIMIT,
    key: "router.deviceKey.budgetPeriodDays",
    type: "number",
    min: 1,
    max: 365,
    integer: true,
    default: 30,
    description: "Days after which a device key's spent budget resets (LiteLLM budget_duration).",
  },
  {
    ...ROUTER_LIMIT,
    key: "router.deviceKey.rpmLimit",
    type: "number",
    min: 1,
    max: 100_000,
    integer: true,
    default: 120,
    description: "Requests per minute a device's router key may make.",
  },
  {
    ...ROUTER_LIMIT,
    key: "router.keys.models",
    type: "string",
    description: "Models device and run keys may use, comma-separated; unset allows every model the router serves.",
  },
  {
    ...ROUTER_LIMIT,
    key: "router.runKey.maxBudgetUsd",
    type: "number",
    min: 0,
    max: 100_000,
    default: 20,
    description: "USD one Drive run's own router key may spend.",
  },
  {
    key: "model.provider",
    type: "enum",
    values: ["litellm", "lmstudio", "openrouter"],
    secret: false,
    levels: PERSONAL,
    override: "any",
    default: "litellm",
    since: 1,
    description: "The backend Kernal starts on (/connect).",
  },
  {
    key: "model.default",
    type: "string",
    secret: false,
    levels: PERSONAL,
    override: "any",
    since: 1,
    description: "The model Kernal starts on, e.g. claude-auto-llm.",
  },
  {
    key: "model.thinking",
    type: "enum",
    values: ["off", "minimal", "low", "medium", "high", "xhigh"],
    secret: false,
    levels: PERSONAL,
    override: "any",
    since: 1,
    description: "The default thinking level.",
  },
  {
    key: "compaction.summaryModel",
    type: "string",
    secret: false,
    levels: PERSONAL,
    override: "any",
    env: ["KERNAL_SUMMARY_MODEL"],
    since: 1,
    description: "The model that writes compaction summaries.",
  },
  {
    key: "compaction.masking",
    type: "boolean",
    secret: false,
    levels: PERSONAL,
    override: "any",
    default: true,
    since: 1,
    description: "Elide old tool results before the context fills.",
  },
  {
    key: "memory.mode",
    type: "enum",
    values: ["off", "tool", "auto"],
    secret: false,
    levels: PERSONAL,
    override: "any",
    since: 1,
    description: "Agent Engine memory on a laptop (kernal.memory).",
  },
  {
    key: "voice.enabled",
    type: "boolean",
    secret: false,
    levels: PERSONAL,
    override: "any",
    default: false,
    since: 1,
    description: "Voice input (pi-listen).",
  },
  {
    key: "voice.language",
    type: "string",
    secret: false,
    levels: PERSONAL,
    override: "any",
    default: "en",
    since: 1,
    description: "Speech recognition language.",
  },
  {
    key: "localHost.shareModels",
    type: "boolean",
    secret: false,
    levels: ["user", "profile", "device", "local"],
    override: "any",
    default: false,
    since: 1,
    description: "Share this machine's local models through the router (#378).",
  },
  {
    key: "telemetry.sentry.enabled",
    type: "boolean",
    secret: false,
    levels: ["fleet", "local"],
    override: "opt-out",
    default: false,
    since: 1,
    description: "Send errors to Sentry. Only the fleet turns it on; a machine may turn it off.",
  },
  {
    key: "telemetry.sentry.dsn",
    type: "url",
    secret: false,
    levels: ["fleet"],
    override: "none",
    since: 1,
    description: "Where Sentry events go.",
  },
  {
    key: "telemetry.sentry.tracesSampleRate",
    type: "number",
    min: 0,
    max: 1,
    secret: false,
    levels: ["fleet"],
    override: "none",
    default: 0.05,
    since: 1,
    description: "Fraction of traces kept.",
  },
  // #424: the other Sentry signals. Stored in the fleet document's `telemetry.sentry` with the
  // three keys above (fleet-settings.ts), and set at the fleet level only while Sentry is on
  // (settings-resolver.ts fleetLevelValues), so all of them read off while it is off. The switches
  // follow telemetry.sentry.enabled's rule: only the fleet turns one on, a machine may turn it off.
  {
    ...SENTRY_SIGNAL,
    key: "telemetry.sentry.logs",
    description: "Send server logs (Outfitter api/link and Drives) to Sentry. Kernal laptops send none.",
  },
  {
    ...SENTRY_SIGNAL,
    key: "telemetry.sentry.metrics",
    description: "Send counters and distributions (logins, router keys, runs, tool calls, tokens, spend) to Sentry.",
  },
  {
    ...SENTRY_SIGNAL,
    key: "telemetry.sentry.agentTraces",
    description: "Send AI agent spans (agent runs, model calls, tool calls) with models, tokens, cost and timing.",
  },
  {
    ...SENTRY_SIGNAL,
    key: "telemetry.sentry.agentContent",
    description: "Include prompts, responses and tool inputs and outputs (redacted) in agent spans; needs agentTraces.",
  },
  {
    key: "telemetry.sentry.profilesSampleRate",
    type: "number",
    min: 0,
    max: 1,
    secret: false,
    levels: ["fleet"],
    override: "none",
    default: 0,
    since: 2,
    description: "Fraction of processes or page loads profiled (api/link, Drives, the web app; not Kernal).",
  },
];

export function settingDecl(key: string): SettingDecl | undefined {
  return SETTINGS_SCHEMA.find((d) => d.key === key);
}

/** What GET /api/config/schema answers: every key still in use. */
export function publicSchema(): { schemaVersion: number; settings: SettingDecl[] } {
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, settings: SETTINGS_SCHEMA.filter((d) => !d.retired) };
}

/** Profile names (§3.3): what `kernal --profile` takes, so short and shell-safe. */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Profiles per user: a guard against a runaway client, far above what a person keeps. */
export const MAX_PROFILES = 20;

const MAX_STRING_LENGTH = 1024;
const MAX_URL_LENGTH = 2048;

/** Options for coerceSettingValue and parseValueWrite. `allowHttp` (dev mode only) also accepts
 * http:// URLs; otherwise a `url` must be https, so a Kernal never sends its router key in clear. */
export interface CoerceOptions {
  allowHttp?: boolean;
}

/** `value` as the declared type, or undefined when it doesn't fit. Used on writes (a misfit is a
 * 400) and again on reads, so a value stored before a validation change never reaches a Kernal
 * as the wrong type. Strings are trimmed and must not be empty: "unset" is `null` on a write. */
export function coerceSettingValue(decl: SettingDecl, value: unknown, opts: CoerceOptions = {}): SettingValue | undefined {
  switch (decl.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      if (decl.min !== undefined && value < decl.min) return undefined;
      if (decl.max !== undefined && value > decl.max) return undefined;
      if (decl.integer && !Number.isInteger(value)) return undefined;
      return value;
    case "enum":
      return typeof value === "string" && decl.values?.includes(value) ? value : undefined;
    case "string": {
      if (typeof value !== "string") return undefined;
      const v = value.trim();
      return v && v.length <= MAX_STRING_LENGTH && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined;
    }
    case "url": {
      if (typeof value !== "string") return undefined;
      const v = value.trim();
      if (!v || v.length > MAX_URL_LENGTH) return undefined;
      try {
        const url = new URL(v);
        return url.protocol === "https:" || (opts.allowHttp && url.protocol === "http:") ? v : undefined;
      } catch {
        return undefined;
      }
    }
  }
}

/** The levels a stored document can hold (fleet is the fleetSettings document; local is never on
 * the server). */
export type WritableLevel = Exclude<SettingLevel, "local">;

export type ValueWriteError = { error: "invalid_request" } | { error: "invalid_value" | "unknown_key" | "level_not_allowed"; key: string };

/** Validates a value write's body (§3.5): `{ values: { key: value | null } }`. Each key must be
 * declared, not retired, not secret, allowed at `level`, and valid for its type (`null` removes
 * it and needs only the first four). Answers the normalized patch. */
export function parseValueWrite(level: WritableLevel, body: unknown, opts: CoerceOptions = {}): { patch: Record<string, SettingValue | null> } | ValueWriteError {
  const values = (body as { values?: unknown } | null | undefined)?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return { error: "invalid_request" };
  const patch: Record<string, SettingValue | null> = {};
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const decl = settingDecl(key);
    if (!decl || decl.retired || decl.secret) return { error: "unknown_key", key };
    if (!decl.levels.includes(level)) return { error: "level_not_allowed", key };
    if (raw === null) {
      patch[key] = null;
      continue;
    }
    const value = coerceSettingValue(decl, raw, opts);
    if (value === undefined) return { error: "invalid_value", key };
    patch[key] = value;
  }
  return { patch };
}

/** `values` with `patch` applied (`null` removes a key). */
export function applyValuePatch(values: Record<string, SettingValue>, patch: Record<string, SettingValue | null>): Record<string, SettingValue> {
  const next = { ...values };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** What every level route answers for one document (§3.5). Version 0: it doesn't exist yet. */
export interface SettingsDocView {
  id: string;
  level: WritableLevel;
  name?: string;
  isDefault?: boolean;
  values: Record<string, SettingValue>;
  version: number;
  updatedAt?: string;
}

// ---------- GET /api/config's answer (§3.4) ----------

/** Where a resolved value came from. "default" is the schema's own default. Kernal adds its local
 * sources ("local", "dotenv", "env") on its side (CA-8). */
export type ValueSource = "fleet" | "group" | "user" | "profile" | "device" | "default";

export interface ResolvedValue {
  value: SettingValue;
  source: ValueSource;
  /** The profile's name for source "profile"; the group's id for source "group". */
  sourceName?: string;
  override: OverrideRule;
  /** True when no level below the source may change it (rule "none" with a fleet or group source;
   * rule "opt-out" whose value is already false). The web and /admin show it read-only. */
  locked: boolean;
  /** Whether the "local" level may set the key at all (decl.levels includes "local"). */
  localAllowed: boolean;
}

export interface ConfigResponse {
  schemaVersion: number;
  account: { email: string; userId: string };
  /** The profile resolved: the one asked for, else the user's default, else null. */
  profile: string | null;
  profiles: string[];
  deviceId: string | null;
  /** Non-secret keys only, and only keys with a value (a key no level sets and with no default is
   * absent). */
  values: Record<string, ResolvedValue>;
  /** Each document's version, for If-Match on the next write. 0: the document doesn't exist. */
  versions: { fleet: number; user: number; profile?: number; device?: number };
  resolvedAt: string;
}
