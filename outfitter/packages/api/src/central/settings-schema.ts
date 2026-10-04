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
export const SETTINGS_SCHEMA_VERSION = 1;

const PERSONAL = ["fleet", "user", "profile", "device", "local"] as const;

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
];

export function settingDecl(key: string): SettingDecl | undefined {
  return SETTINGS_SCHEMA.find((d) => d.key === key);
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
