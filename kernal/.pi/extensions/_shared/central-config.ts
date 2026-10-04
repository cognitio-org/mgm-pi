/**
 * Central settings on Kernal (#397 CA-8, outfitter/docs/specs/central-auth.md §3, §10): what
 * Outfitter resolved for this account and profile, layered with this machine's own overrides,
 * .env and the shell. Owned by task F; the exports below are the contract /admin (CA-9), the
 * migration (CA-10) and the extensions that read settings build against.
 *
 * Start-up never waits on the network: `resolve` answers from the cache at once, and
 * `refreshConfig` fetches GET /api/config in the background and rewrites the cache. A changed value
 * takes effect at the next start or on `/config reload`; a process never switches profile.
 *
 * Order, later wins within each key's override rule (spec §10): central (fleet → group → user →
 * profile → device, as the server resolved it) → this device's router key from the keychain →
 * this machine's overrides (~/.kernal/config.local.json) → .env (legacy, one warning per variable
 * when signed in) → the shell. The last three are all level "local", so a key whose declaration
 * has no "local" level ignores them.
 *
 * Signed out there is no central layer: everything works from the local layers as before, and LM
 * Studio works offline. Secrets are never written to the cache: the server sends none in
 * GET /api/config, `router.key` comes from the keychain, and personal provider keys (§4) are kept
 * in memory only (`providerKey`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env as kenv } from "./env.ts";
import * as session from "./outfitter-session.ts";
import { parseEnvText } from "../connect/lib.ts";
import { kernalSection, readSettings, updateKernal } from "../connect/settings.ts";

export type SettingValue = string | number | boolean;
export type OverrideRule = "none" | "opt-out" | "any";

/** Server sources (GET /api/config), then the local ones Kernal adds, lowest authority last. */
export type ConfigSource = "fleet" | "group" | "user" | "profile" | "device" | "default" | "local" | "dotenv" | "env";

export interface ConfigValue {
  value: SettingValue;
  source: ConfigSource;
  /** The profile's name for source "profile"; the env var's name for "dotenv" and "env". */
  sourceName?: string;
  override: OverrideRule;
  /** A local value can't change it (/admin shows it read-only). */
  locked: boolean;
}

export interface ResolvedConfig {
  /** Null when signed out: local layers only. */
  api: string | null;
  account: string | null;
  profile: string | null;
  schemaVersion: number;
  values: Record<string, ConfigValue>;
  /** When the central part was fetched; null when there is none. */
  fetchedAt: string | null;
  fromCache: boolean;
  /** The account's profiles, as the last answer listed them (empty when signed out). */
  profiles?: string[];
}

// ---------- the schema, as Kernal knows it ----------

type SettingType = "string" | "boolean" | "number" | "enum" | "url";
type Level = "fleet" | "group" | "user" | "profile" | "device" | "local";

/** The part of the server's SettingDecl (outfitter/packages/api/src/central/settings-schema.ts)
 * Kernal needs. A copy, not an import: Kernal ships without Outfitter's code. Keys the server adds
 * later are ignored here until a Kernal release knows them (spec §3.6). */
export interface KnownSetting {
  key: string;
  type: SettingType;
  values?: readonly string[];
  min?: number;
  max?: number;
  secret: boolean;
  levels: readonly Level[];
  override: OverrideRule;
  default?: SettingValue;
  env?: readonly string[];
  description: string;
}

/** The schema version this Kernal was built against. */
export const KNOWN_SCHEMA_VERSION = 3;

const PERSONAL: readonly Level[] = ["fleet", "user", "profile", "device", "local"];

/** The v1 keys (spec §3.2), v2's Sentry signals (#424) and v3's curated OpenRouter list (#440). */
export const KNOWN_SETTINGS: readonly KnownSetting[] = [
  { key: "router.baseUrl", type: "url", secret: false, levels: ["fleet", "local"], override: "none", default: "https://router.kernal.one/v1", env: ["LITELLM_BASE_URL"], description: "The LiteLLM router this machine's router key is for." },
  { key: "router.key", type: "string", secret: true, levels: ["device", "local"], override: "any", env: ["LITELLM_AGENT_KEY", "LITELLM_API_KEY"], description: "This device's own router key, minted at sign-in." },
  { key: "model.provider", type: "enum", values: ["litellm", "lmstudio", "openrouter"], secret: false, levels: PERSONAL, override: "any", default: "litellm", description: "The backend Kernal starts on (/connect)." },
  { key: "model.default", type: "string", secret: false, levels: PERSONAL, override: "any", description: "The model Kernal starts on." },
  { key: "model.thinking", type: "enum", values: ["off", "minimal", "low", "medium", "high", "xhigh"], secret: false, levels: PERSONAL, override: "any", description: "The default thinking level." },
  { key: "compaction.summaryModel", type: "string", secret: false, levels: PERSONAL, override: "any", env: ["KERNAL_SUMMARY_MODEL"], description: "The model that writes compaction summaries." },
  { key: "compaction.masking", type: "boolean", secret: false, levels: PERSONAL, override: "any", default: true, description: "Elide old tool results before the context fills." },
  { key: "memory.mode", type: "enum", values: ["off", "tool", "auto"], secret: false, levels: PERSONAL, override: "any", description: "Agent Engine memory on a laptop." },
  { key: "voice.enabled", type: "boolean", secret: false, levels: PERSONAL, override: "any", default: false, description: "Voice input (pi-listen)." },
  { key: "voice.language", type: "string", secret: false, levels: PERSONAL, override: "any", default: "en", description: "Speech recognition language." },
  { key: "localHost.shareModels", type: "boolean", secret: false, levels: ["user", "profile", "device", "local"], override: "any", default: false, description: "Share this machine's local models through the router." },
  { key: "telemetry.sentry.enabled", type: "boolean", secret: false, levels: ["fleet", "local"], override: "opt-out", default: false, description: "Send errors to Sentry. Only the fleet turns it on; a machine may turn it off." },
  { key: "telemetry.sentry.dsn", type: "url", secret: false, levels: ["fleet"], override: "none", description: "Where Sentry events go." },
  { key: "telemetry.sentry.tracesSampleRate", type: "number", min: 0, max: 1, secret: false, levels: ["fleet"], override: "none", default: 0.05, description: "Share of agent runs traced." },
  // #424: each off by default, turned on for the fleet only; a machine may turn one off (/sentry).
  { key: "telemetry.sentry.agentTraces", type: "boolean", secret: false, levels: ["fleet", "local"], override: "opt-out", default: false, description: "AI agent monitoring: agent runs, model calls (model, tokens, cost) and tool calls as gen_ai spans." },
  { key: "telemetry.sentry.agentContent", type: "boolean", secret: false, levels: ["fleet", "local"], override: "opt-out", default: false, description: "Prompts, outputs and tool arguments/results on agent spans, redacted (needs agentTraces)." },
  { key: "telemetry.sentry.metrics", type: "boolean", secret: false, levels: ["fleet", "local"], override: "opt-out", default: false, description: "Counters: agent runs, tool and model calls, tokens, spend, errors." },
  { key: "telemetry.sentry.logs", type: "boolean", secret: false, levels: ["fleet", "local"], override: "opt-out", default: false, description: "Server logs to Sentry (Outfitter and Drives; a laptop sends none)." },
  { key: "telemetry.sentry.profilesSampleRate", type: "number", min: 0, max: 1, secret: false, levels: ["fleet"], override: "none", default: 0, description: "Share of traces profiled (Outfitter and Drives; not Kernal's binary)." },
  // v3 (#440): the curated OpenRouter list, one add and one remove key per level so they combine
  // (connect/lib.ts curateOpenRouter). Comma-separated model ids.
  { key: "openrouter.models.fleetAdd", type: "string", secret: false, levels: ["fleet"], override: "none", description: "OpenRouter models offered to everyone on top of Kernal's curated list." },
  { key: "openrouter.models.fleetRemove", type: "string", secret: false, levels: ["fleet"], override: "none", description: "OpenRouter models hidden from everyone; nobody can add them back." },
  { key: "openrouter.models.add", type: "string", secret: false, levels: ["user"], override: "any", description: "OpenRouter models you added to your curated list." },
  { key: "openrouter.models.remove", type: "string", secret: false, levels: ["user"], override: "any", description: "OpenRouter models you removed from your curated list." },
  { key: "openrouter.models.profileAdd", type: "string", secret: false, levels: ["profile"], override: "any", description: "OpenRouter models this profile adds to your curated list." },
  { key: "openrouter.models.profileRemove", type: "string", secret: false, levels: ["profile"], override: "any", description: "OpenRouter models this profile removes from your curated list." },
  { key: "openrouter.models.localAdd", type: "string", secret: false, levels: ["local"], override: "any", description: "OpenRouter models this machine adds to the curated list." },
  { key: "openrouter.models.localRemove", type: "string", secret: false, levels: ["local"], override: "any", description: "OpenRouter models this machine removes from the curated list." },
];

/** The legacy settings.json flags (`kernal.<flag>: false`) that were each key's local opt-out
 * before `/sentry` moved to this machine's config layer (config.local.json, where /admin's "Only
 * this machine" saves too). Still read as opt-outs, so a laptop keeps an earlier `/sentry off`;
 * never written again, and cleared by `setLocalOptOut(key, false)` (`/sentry … on`, /admin). */
export const SENTRY_LOCAL_FLAGS: Readonly<Record<string, string>> = {
  "telemetry.sentry.enabled": "sentry",
  "telemetry.sentry.agentTraces": "sentryAgentTraces",
  "telemetry.sentry.agentContent": "sentryAgentContent",
  "telemetry.sentry.metrics": "sentryMetrics",
};

const BY_KEY = new Map(KNOWN_SETTINGS.map((d) => [d.key, d]));

/** Personal provider keys (spec §4) and the env var each backend reads. */
export const PROVIDER_ENV: Readonly<Record<string, string>> = {
  openrouter: "OPENROUTER_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const CENTRAL_SOURCES: ReadonlySet<ConfigSource> = new Set(["fleet", "group", "user", "profile", "device"]);
const LOCAL_SOURCES: ReadonlySet<ConfigSource> = new Set(["local", "dotenv", "env"]);

/** True when a value came from Outfitter or this device's login (not this machine's files or shell). */
export function isCentralSource(source: ConfigSource): boolean {
  return CENTRAL_SOURCES.has(source);
}

/** A value of the declared type, or undefined (spec §3.6: a mismatch is ignored, never an error).
 * Strings from env vars and .env are parsed; JSON values must already have the right type. */
export function coerce(decl: KnownSetting, raw: unknown, fromText = false): SettingValue | undefined {
  if (fromText && typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return undefined;
    if (decl.type === "boolean") {
      if (/^(1|true|yes|on)$/i.test(t)) return true;
      if (/^(0|false|no|off)$/i.test(t)) return false;
      return undefined;
    }
    if (decl.type === "number") raw = Number(t);
    else raw = t;
  }
  switch (decl.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      if (decl.min !== undefined && raw < decl.min) return undefined;
      if (decl.max !== undefined && raw > decl.max) return undefined;
      return raw;
    case "enum":
      return typeof raw === "string" && (decl.values ?? []).includes(raw) ? raw : undefined;
    case "url":
      return typeof raw === "string" && /^https?:\/\/\S+$/.test(raw) ? raw : undefined;
    case "string":
      return typeof raw === "string" && raw !== "" ? raw : undefined;
  }
}

// ---------- the server's answer (GET /api/config, spec §3.4) ----------

interface ResponseValue {
  value: unknown;
  source: string;
  sourceName?: string;
  override?: string;
  locked?: boolean;
  localAllowed?: boolean;
}

export interface ConfigResponse {
  schemaVersion: number;
  account: { email: string; userId: string };
  profile: string | null;
  profiles: string[];
  deviceId?: string | null;
  values: Record<string, ResponseValue>;
  versions?: Record<string, number>;
  resolvedAt: string;
}

interface CacheFile {
  api: string;
  email: string;
  profile: string | null;
  fetchedAt: string;
  response: ConfigResponse;
}

/** A cached answer older than this is ignored (spec §10), like the fleet-settings cache. */
export const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
/** Re-mint the device's router key when it has less than this left (spec §5.5). */
export const ROUTER_KEY_REMINT_MS = 7 * 24 * 60 * 60 * 1000;

/** The answer's shape checked field by field; undefined when it isn't one. Values Kernal doesn't
 * know, secret ones (the server sends none) and malformed entries are dropped. */
export function parseConfigResponse(json: unknown): ConfigResponse | undefined {
  const r = json as Partial<ConfigResponse> | null;
  if (!r || typeof r !== "object" || typeof r.schemaVersion !== "number" || !r.values || typeof r.values !== "object") return undefined;
  if (!r.account || typeof r.account.email !== "string") return undefined;
  const values: Record<string, ResponseValue> = {};
  for (const [key, v] of Object.entries(r.values)) {
    const decl = BY_KEY.get(key);
    if (!decl || decl.secret || !v || typeof v !== "object" || typeof (v as ResponseValue).source !== "string") continue;
    const value = coerce(decl, (v as ResponseValue).value);
    if (value === undefined) continue;
    const e = v as ResponseValue;
    values[key] = {
      value,
      source: e.source,
      ...(typeof e.sourceName === "string" ? { sourceName: e.sourceName } : {}),
      ...(typeof e.locked === "boolean" ? { locked: e.locked } : {}),
      ...(typeof e.localAllowed === "boolean" ? { localAllowed: e.localAllowed } : {}),
    };
  }
  return {
    schemaVersion: r.schemaVersion,
    account: { email: r.account.email, userId: typeof r.account.userId === "string" ? r.account.userId : "" },
    profile: typeof r.profile === "string" ? r.profile : null,
    profiles: Array.isArray(r.profiles) ? r.profiles.filter((p): p is string => typeof p === "string") : [],
    deviceId: typeof r.deviceId === "string" ? r.deviceId : null,
    values,
    ...(r.versions && typeof r.versions === "object" ? { versions: r.versions } : {}),
    resolvedAt: typeof r.resolvedAt === "string" ? r.resolvedAt : new Date(0).toISOString(),
  };
}

// ---------- process-wide state and seams ----------

type Session = Pick<typeof session, "loginState" | "getAccessToken" | "getRouterKey" | "setRouterKey">;

/** What the module reads from the outside world; tests replace parts with `_setCentralConfigDeps`. */
export interface CentralConfigDeps {
  session: Session;
  /** The shell environment (default process.env). */
  env: () => NodeJS.ProcessEnv;
  /** The merged .env files, nearest last (default: the files connect's loadEnv reads). */
  dotenv: () => Record<string, string>;
  /** The agent settings.json (for the legacy Sentry opt-out flags, SENTRY_LOCAL_FLAGS). */
  settings: () => Record<string, unknown>;
  /** Changes the agent settings.json's `kernal` section (default: updateKernal); only to clear a
   * legacy Sentry flag (SENTRY_LOCAL_FLAGS). */
  saveKernal: (patch: Record<string, unknown>) => void;
  fetch: typeof fetch;
  now: () => number;
  /** One-line warnings (default: stderr). */
  warn: (line: string) => void;
}

interface State {
  resolved: Map<string, ResolvedConfig>;
  inflight: Map<string, Promise<ResolvedConfig | undefined>>;
  providerKeys: Map<string, string>;
  warned: Set<string>;
  deps: Partial<CentralConfigDeps>;
}

/**
 * Process-wide, not module-wide: pi loads each extension through its own jiti with
 * `moduleCache: false` (outfitter-env.ts says more), so connect, sentry and /config each get their
 * own copy of this module. One slot on globalThis keeps one resolution per process.
 */
const SLOT = Symbol.for("kernal.centralConfig");
function state(): State {
  const g = globalThis as { [SLOT]?: State };
  return (g[SLOT] ??= { resolved: new Map(), inflight: new Map(), providerKeys: new Map(), warned: new Set(), deps: {} });
}

/** The .env files connect's loadEnv reads (connect/index.ts), nearest last. Not imported from
 * there: connect/index.ts pulls in pi's TUI and imports this module. */
function readDotenv(): Record<string, string> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const nextToAgent = agentDir ? join(agentDir, "..", ".env") : join(homedir(), "localllm", ".env");
  const cwd = process.cwd();
  let out: Record<string, string> = {};
  for (const f of [join(homedir(), "localllm", ".env"), nextToAgent, join(cwd, "..", ".env"), join(cwd, ".env")]) {
    try { out = { ...out, ...parseEnvText(readFileSync(f, "utf8")) }; } catch {}
  }
  return out;
}

function deps(): CentralConfigDeps {
  const d = state().deps;
  return {
    session: d.session ?? session,
    env: d.env ?? (() => process.env),
    dotenv: d.dotenv ?? readDotenv,
    settings: d.settings ?? (() => readSettings()),
    saveKernal: d.saveKernal ?? ((patch) => updateKernal(patch)),
    fetch: d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
    now: d.now ?? Date.now,
    warn: d.warn ?? ((line) => console.error(line)),
  };
}

/** Test-only: replace some of the outside world. */
export function _setCentralConfigDeps(d: Partial<CentralConfigDeps>): void {
  state().deps = { ...state().deps, ...d };
}

/** Test-only: forget the resolution, the provider keys, the warnings and the seams. */
export function _resetCentralConfig(): void {
  delete (globalThis as { [SLOT]?: State })[SLOT];
}

// ---------- paths ----------

/** ~/.kernal (KERNAL_HOME_DIR overrides, as for kernal-github). */
function kernalHome(): string {
  return kenv("HOME_DIR") || join(homedir(), ".kernal");
}

export function configCacheDir(): string {
  return kenv("CONFIG_CACHE_DIR") || join(kernalHome(), "config-cache");
}

/** One file per api, account and profile (spec §10). */
export function configCachePath(api: string, email: string, profile: string | undefined): string {
  const id = createHash("sha256").update(`${api}|${email}|${profile ?? ""}`).digest("hex").slice(0, 16);
  return join(configCacheDir(), `${id}.json`);
}

/** This machine's own overrides (the "local" level). */
export function localOverridesPath(): string {
  return join(kernalHome(), "config.local.json");
}

/** The web app for an API: app.kernal.one for the released link origin, else the API itself (a dev
 * server runs role "all"). */
export function webOrigin(api: string = session.outfitterApi()): string {
  return api === session.DEFAULT_OUTFITTER_API ? "https://app.kernal.one" : api;
}

function writeWhole(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Written whole then renamed: a second Kernal starting at the same moment never reads half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** config.local.json's values, read from disk now (not the memoised resolution). */
export function readLocalOverrides(): Record<string, unknown> {
  try {
    const f = JSON.parse(readFileSync(localOverridesPath(), "utf8")) as { version?: unknown; values?: unknown };
    return f && f.version === 1 && f.values && typeof f.values === "object" ? (f.values as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readCache(api: string, email: string, profile: string | undefined, now: number): CacheFile | undefined {
  try {
    const c = JSON.parse(readFileSync(configCachePath(api, email, profile), "utf8")) as Partial<CacheFile>;
    if (c.api !== api || c.email !== email || (c.profile ?? null) !== (profile ?? null)) return undefined;
    const age = now - Date.parse(c.fetchedAt ?? "");
    if (!(age >= 0 && age < MAX_CACHE_AGE_MS)) return undefined;
    const response = parseConfigResponse(c.response);
    return response ? { api, email, profile: profile ?? null, fetchedAt: c.fetchedAt!, response } : undefined;
  } catch {
    return undefined;
  }
}

// ---------- resolution ----------

type Layer = { value: SettingValue; source: ConfigSource; sourceName?: string; locked?: boolean };

/** The local candidates for one key, lowest priority first: overrides file, settings.json, .env,
 * shell. A variable that bin/kernal exported from .env (same value in both) counts as .env. */
function localLayers(decl: KnownSetting, overrides: Record<string, unknown>, settings: Record<string, unknown>,
  dotenv: Record<string, string>, shell: NodeJS.ProcessEnv): Layer[] {
  const out: Layer[] = [];
  const own = coerce(decl, overrides[decl.key]);
  if (own !== undefined) out.push({ value: own, source: "local" });
  // The Sentry keys' legacy opt-outs, `kernal.sentry: false` (#374) and `kernal.sentryAgentTraces:
  // false` and so on (SENTRY_LOCAL_FLAGS): still a local `false` beside config.local.json's.
  const flag = SENTRY_LOCAL_FLAGS[decl.key];
  if (flag && kernalSection(settings)[flag] === false) {
    out.push({ value: false, source: "local", sourceName: "settings.json" });
  }
  const fromVars = (read: (name: string) => string | undefined, source: "dotenv" | "env") => {
    for (const name of decl.env ?? []) {
      const v = coerce(decl, read(name), true);
      if (v !== undefined) return { value: v, source, sourceName: name } as Layer;
    }
    return undefined;
  };
  const dot = fromVars((n) => dotenv[n], "dotenv");
  if (dot) out.push(dot);
  const sh = fromVars((n) => (shell[n] !== undefined && shell[n] !== dotenv[n] ? shell[n] : undefined), "env");
  if (sh) out.push(sh);
  return out;
}

/**
 * One key: the server's resolution (already ordered fleet → device), the device's own layer
 * (router.key from the keychain), then the local layers, combined by the key's override rule
 * (spec §3.1). A server "default" is no level: any level that sets the key beats it.
 */
export function combine(decl: KnownSetting, central: Layer | undefined, device: Layer | undefined, local: Layer[]): ConfigValue | undefined {
  const levels: Layer[] = [];   // highest authority first
  if (central && central.source !== "default") levels.push(central);
  if (device) levels.push(device);
  const localAllowed = decl.levels.includes("local");
  if (localAllowed && local.length) levels.push(local[local.length - 1]);   // later local layers win
  const at = (l: Layer, locked: boolean): ConfigValue => ({
    value: l.value, source: l.source, ...(l.sourceName ? { sourceName: l.sourceName } : {}), override: decl.override, locked,
  });
  if (!levels.length) {
    const fallback = central ?? (decl.default !== undefined ? { value: decl.default, source: "default" as const } : undefined);
    if (!fallback) return undefined;
    return at(fallback, decl.override === "opt-out" ? fallback.value === false : false);
  }
  if (decl.override === "any") return at(levels[levels.length - 1], false);
  if (decl.override === "none") {
    const w = levels[0];
    return at(w, w.locked ?? (w.source === "fleet" || w.source === "group"));
  }
  // opt-out: any level may turn it off; a lower level can't turn it on by itself, so a local `true`
  // counts only when a higher level said `true` too.
  const off = levels.find((l) => l.value === false);
  if (off) return at(off, true);
  const on = levels.find((l) => !LOCAL_SOURCES.has(l.source));
  if (on) return at(on, false);
  const fallback = central ?? { value: decl.default ?? false, source: "default" as const };
  return at(fallback, fallback.value === false);
}

function warnDotenv(local: Map<string, Layer[]>): void {
  const st = state();
  for (const layers of local.values()) {
    for (const l of layers) {
      if (l.source !== "dotenv" || !l.sourceName || st.warned.has(l.sourceName)) continue;
      st.warned.add(l.sourceName);
      deps().warn(`${l.sourceName} in .env is deprecated: /admin can save it to your account or this machine`);
    }
  }
}

function resolveFrom(cache: CacheFile | undefined, account: session.SessionAccount | undefined, profile: string | undefined): ResolvedConfig {
  const d = deps();
  const overrides = readLocalOverrides();
  const settings = (() => { try { return d.settings(); } catch { return {}; } })();
  const dotenv = (() => { try { return d.dotenv(); } catch { return {}; } })();
  const shell = d.env();
  const routerKey = account ? safe(() => d.session.getRouterKey({ api: account.api, email: account.email })) : undefined;
  const values: Record<string, ConfigValue> = {};
  const locals = new Map<string, Layer[]>();
  for (const decl of KNOWN_SETTINGS) {
    const r = cache?.response.values[decl.key];
    const central: Layer | undefined = r
      ? { value: r.value as SettingValue, source: r.source as ConfigSource, ...(r.sourceName ? { sourceName: r.sourceName } : {}), ...(r.locked !== undefined ? { locked: r.locked } : {}) }
      : undefined;
    const device: Layer | undefined = decl.key === "router.key" && routerKey?.key ? { value: routerKey.key, source: "device" } : undefined;
    const local = localLayers(decl, overrides, settings, dotenv, shell);
    // The server may say a local value is not allowed for this account (localAllowed: false).
    const allowed = r?.localAllowed === false ? [] : local;
    locals.set(decl.key, allowed);
    const v = combine(decl, central, device, allowed);
    if (v) values[decl.key] = v;
  }
  // Signed out, .env is still how a machine is configured: no deprecation warning then.
  if (account) warnDotenv(locals);
  return {
    api: account?.api ?? null,
    account: account?.email ?? null,
    profile: cache?.response.profile ?? profile ?? null,
    schemaVersion: cache?.response.schemaVersion ?? KNOWN_SCHEMA_VERSION,
    values,
    fetchedAt: cache?.fetchedAt ?? null,
    fromCache: !!cache,
    profiles: cache?.response.profiles ?? [],
  };
}

function safe<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}

function signedInAccount(): session.SessionAccount | undefined {
  const s = safe(() => deps().session.loginState({ api: session.outfitterApi(deps().env()) }));
  return s?.signedIn ? s.account : undefined;
}

/** --profile <name> / KERNAL_PROFILE (bin/kernal turns the flag into the env var). */
export function activeProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.KERNAL_PROFILE?.trim() || undefined;
}

/** Sync: the cache plus local layers, for this process's profile. Resolved once per process and
 * kept (a process never switches profile); `/config reload` calls reloadConfig. */
export function resolve(profile: string | undefined = activeProfile(deps().env())): ResolvedConfig {
  const st = state();
  const id = profile ?? "";
  const kept = st.resolved.get(id);
  if (kept) return kept;
  const account = signedInAccount();
  const cache = account ? readCache(account.api, account.email, profile, deps().now()) : undefined;
  const r = resolveFrom(cache, account, profile);
  st.resolved.set(id, r);
  return r;
}

/** One value, or undefined. */
export function getValue<T extends SettingValue = SettingValue>(key: string): T | undefined {
  return resolve().values[key]?.value as T | undefined;
}

/** Fetches GET /api/config with the session's token, rewrites the cache, and returns the new
 * resolution (the process keeps the one it has until `reloadConfig`). Undefined when signed out,
 * offline or refused; never throws. Concurrent calls for one profile share one request. */
export async function refreshConfig(opts: { profile?: string; fetch?: typeof fetch } = {}): Promise<ResolvedConfig | undefined> {
  const profile = opts.profile ?? activeProfile(deps().env());
  const st = state();
  const id = profile ?? "";
  const running = st.inflight.get(id);
  if (running) return running;
  const p = fetchConfig(profile, opts.fetch).catch(() => undefined).finally(() => st.inflight.delete(id));
  st.inflight.set(id, p);
  return p;
}

async function bearer(account: session.SessionAccount): Promise<string | undefined> {
  // The session's access token (spec §2.2); the Dongle has no central settings (§10 "signed out").
  try {
    return await deps().session.getAccessToken({ api: account.api, email: account.email, fetch: deps().fetch });
  } catch {
    return undefined;
  }
}

/** A request to Outfitter with the session's token; undefined without one. After a 401 the
 * keychain is read once more and the request retried once (spec §2.4): another Kernal may have
 * rotated the pair since. The same token again means the server refused it, so no retry then. */
async function authedFetch(account: session.SessionAccount, url: string, init: RequestInit, fetchImpl?: typeof fetch): Promise<Response | undefined> {
  const doFetch = fetchImpl ?? deps().fetch;
  const send = (token: string) => doFetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const token = await bearer(account);
  if (!token) return undefined;
  const res = await send(token);
  if (res.status !== 401) return res;
  const again = await bearer(account);
  return again && again !== token ? send(again) : res;
}

async function fetchConfig(profile: string | undefined, fetchImpl?: typeof fetch): Promise<ResolvedConfig | undefined> {
  const account = signedInAccount();
  if (!account) return undefined;
  const url = `${account.api}/api/config${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`;
  const res = await authedFetch(account, url, { headers: { accept: "application/json" } }, fetchImpl);
  if (!res) return undefined;
  if (res.status === 404 && profile) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; profiles?: unknown };
    if (body.error === "unknown_profile") {
      const known = Array.isArray(body.profiles) ? body.profiles.join(", ") : "";
      const key = `profile:${profile}`;
      if (!state().warned.has(key)) {
        state().warned.add(key);
        deps().warn(`Profile "${profile}" does not exist for ${account.email}${known ? ` (profiles: ${known})` : ""}; using this machine's settings only`);
      }
    }
    return undefined;
  }
  if (!res.ok) return undefined;
  const response = parseConfigResponse(await res.json());
  if (!response) return undefined;
  const cache: CacheFile = { api: account.api, email: account.email, profile: profile ?? null, fetchedAt: new Date(deps().now()).toISOString(), response };
  try {
    writeWhole(configCachePath(account.api, account.email, profile), JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // An unwritable cache only means the next start reads the network's answer a little later.
  }
  return { ...resolveFrom(cache, account, profile), fromCache: false };
}

/** `/config reload`: refresh, then make the fresh resolution this process's own. Without an answer
 * the local layers are still re-read (a changed .env or config.local.json shows up). */
export async function reloadConfig(opts: { profile?: string; fetch?: typeof fetch } = {}): Promise<ResolvedConfig> {
  const profile = opts.profile ?? activeProfile(deps().env());
  const fresh = await refreshConfig({ ...opts, profile });
  state().resolved.delete(profile ?? "");
  if (fresh) state().resolved.set(profile ?? "", fresh);
  return resolve(profile);
}

/** This machine's own overrides (the "local" level), `~/.kernal/config.local.json`. Undefined
 * removes the key. Throws for a key this Kernal doesn't know, a secret, a key with no local level,
 * or a value of the wrong type. Takes effect in this process at once. */
export function setLocalOverride(key: string, value: SettingValue | undefined): void {
  const decl = BY_KEY.get(key);
  if (!decl) throw new Error(`unknown setting ${key}`);
  if (decl.secret) throw new Error(`${key} is a secret and is not stored in ${localOverridesPath()}`);
  if (!decl.levels.includes("local")) throw new Error(`${key} can't be set on this machine`);
  const values = { ...readLocalOverrides() };
  if (value === undefined) delete values[key];
  else {
    const v = coerce(decl, value);
    if (v === undefined) throw new Error(`invalid value for ${key}`);
    values[key] = v;
  }
  writeWhole(localOverridesPath(), JSON.stringify({ version: 1, values }, null, 2) + "\n");
  // Re-resolve from the same cache with the new local layer.
  state().resolved.clear();
}

/**
 * A Sentry key's opt-out on this machine (`/sentry off|on`, `/sentry agent|content|metrics off|on`,
 * and /admin's "Only this machine"): one place, config.local.json, so either tool undoes the other.
 * `off` saves `false`; clearing removes the key there and the legacy settings.json flag
 * (SENTRY_LOCAL_FLAGS) too, so it really undoes any earlier opt-out. Only ever an opt-out: nothing
 * here turns a key on (the fleet does). Throws for any other key or a disk error.
 */
export function setLocalOptOut(key: string, off: boolean): void {
  const flag = SENTRY_LOCAL_FLAGS[key];
  if (!flag) throw new Error(`${key} has no local opt-out`);
  if (off) return setLocalOverride(key, false);
  // The legacy flag first: settings.json is only touched when it holds one (a hand edit in progress
  // that isn't JSON is then left alone), and setLocalOverride re-resolves with both cleared.
  const d = deps();
  if (kernalSection(d.settings())[flag] !== undefined) d.saveKernal({ [flag]: undefined });
  setLocalOverride(key, undefined);
}

/** True when the legacy settings.json flag (SENTRY_LOCAL_FLAGS) opts `key` out on this machine. */
export function legacyOptOut(key: string, settings: Record<string, unknown> = safeSettings()): boolean {
  const flag = SENTRY_LOCAL_FLAGS[key];
  return !!flag && kernalSection(settings)[flag] === false;
}

function safeSettings(): Record<string, unknown> {
  try { return deps().settings(); } catch { return {}; }
}

// ---------- secrets delivered at start-up ----------

/** Personal provider keys delivered at start-up (CA-4), held in memory only, never in the cache. */
export function providerKey(provider: string): string | undefined {
  return state().providerKeys.get(provider);
}

/** POST /api/device/provider-keys (spec §4): the account's personal provider keys, into memory.
 * Signed out, offline or refused: nothing changes. Never throws. */
export async function refreshProviderKeys(opts: { fetch?: typeof fetch } = {}): Promise<void> {
  try {
    const account = signedInAccount();
    if (!account) return;
    const res = await authedFetch(account, `${account.api}/api/device/provider-keys`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
    }, opts.fetch);
    if (!res?.ok) return;
    const keys = ((await res.json()) as { keys?: unknown }).keys;
    if (!keys || typeof keys !== "object") return;
    const st = state();
    st.providerKeys.clear();
    for (const [provider, value] of Object.entries(keys)) {
      if (provider in PROVIDER_ENV && typeof value === "string" && value) st.providerKeys.set(provider, value);
    }
  } catch {
    // Keys stay as they were; the backends fall back to the local ones.
  }
}

/** POST /api/device/router-key when the device's key has under 7 days left, or with `force` after
 * the router refused it (spec §5.5), then stores the new one. True when it re-minted. Never throws. */
export async function remintRouterKeyIfDue(opts: { fetch?: typeof fetch; force?: boolean } = {}): Promise<boolean> {
  try {
    const account = signedInAccount();
    if (!account) return false;
    const d = deps();
    const current = d.session.getRouterKey({ api: account.api, email: account.email });
    if (!current) return false;
    const left = current.expiresAt ? Date.parse(current.expiresAt) - d.now() : Infinity;
    if (!opts.force && !(left < ROUTER_KEY_REMINT_MS)) return false;
    const res = await authedFetch(account, `${account.api}/api/device/router-key`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
    }, opts.fetch);
    if (!res?.ok) return false;
    const k = ((await res.json()) as { routerKey?: Record<string, unknown> }).routerKey;
    if (!k || typeof k.key !== "string" || typeof k.baseUrl !== "string" || typeof k.alias !== "string") return false;
    d.session.setRouterKey({ key: k.key, baseUrl: k.baseUrl, alias: k.alias, ...(typeof k.expiresAt === "string" ? { expiresAt: k.expiresAt } : {}) }, { api: account.api, email: account.email });
    // The server deleted the old key: the new one replaces it in what this process resolved, so
    // connect's next registerAll (kernal-config asks for one) uses it. Only the key changes; the
    // rest of a fresh answer still waits for the next start or /config reload (spec §10).
    for (const r of state().resolved.values()) {
      const v = r.values["router.key"];
      if (v?.source === "device") r.values["router.key"] = { ...v, value: k.key };
    }
    return true;
  } catch {
    return false;
  }
}

/** Start-up's background work (kernal-config calls it once): fresh settings into the cache, the
 * provider keys into memory, a router key re-minted when due. Never rejects. */
export function startBackgroundRefresh(opts: { fetch?: typeof fetch } = {}): Promise<void> {
  if (!signedInAccount()) return Promise.resolve();
  return Promise.all([refreshConfig(opts), refreshProviderKeys(opts), remintRouterKeyIfDue(opts)]).then(() => undefined, () => undefined);
}

// ---------- for connect ----------

/**
 * connect's loadEnv layering (spec §10 "Delivery"): the router's base URL and key, and the personal
 * provider keys, as env-style entries over `env` (which is the .env files plus the shell). Returns a
 * new object; process.env is not touched.
 *   - `router.baseUrl` set by the fleet (rule "none") replaces LITELLM_BASE_URL.
 *   - `router.key` from the keychain (level "device", rule "any") fills LITELLM_AGENT_KEY only when
 *     no local key is set, so a key /setup just saved still wins.
 *   - a provider key from the account fills its variable only when none is set locally.
 */
export function layerCentralEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  try {
    const r = resolve();
    const base = r.values["router.baseUrl"];
    if (base && isCentralSource(base.source)) out.LITELLM_BASE_URL = String(base.value);
    const key = r.values["router.key"];
    if (key?.source === "device" && !out.LITELLM_AGENT_KEY && !out.LITELLM_API_KEY) out.LITELLM_AGENT_KEY = String(key.value);
    for (const [provider, name] of Object.entries(PROVIDER_ENV)) {
      const v = providerKey(provider);
      if (v && !out[name]) out[name] = v;
    }
  } catch {
    // Central settings never break the local ones.
  }
  return out;
}

// ---------- for /config and /admin ----------

/** Where a value came from, in the words /config and /admin show (spec §11). */
export function describeSource(v: Pick<ConfigValue, "source" | "sourceName">): string {
  switch (v.source) {
    case "fleet": return "fleet";
    case "group": return "group";
    case "user": return "your account";
    case "profile": return v.sourceName ? `profile ${v.sourceName}` : "profile";
    case "device": return "this device";
    case "default": return "default";
    case "local": return v.sourceName === "settings.json" ? "this machine (settings.json)" : "this machine";
    case "dotenv": return v.sourceName ? `.env (${v.sourceName})` : ".env";
    case "env": return v.sourceName ? `shell (${v.sourceName})` : "shell";
  }
}

/** A value as shown: secrets reduced to their last four characters. */
export function displayValue(key: string, v: SettingValue): string {
  if (BY_KEY.get(key)?.secret) {
    const s = String(v);
    return s.length > 8 ? `…${s.slice(-4)}` : "…";
  }
  return typeof v === "string" ? v : JSON.stringify(v);
}
