/**
 * /admin and the central settings (#398 CA-9, outfitter/docs/specs/central-auth.md §11): where each
 * value comes from, and where a save goes.
 *
 *   Settings page   every key Kernal knows, its value and source from central-config's `resolve()`,
 *                   and two save targets: "Save to my account (profile <name>)" → PUT
 *                   /api/config/profiles/:name (or /api/config/user with no profile), versioned with
 *                   If-Match from the last GET; "Only this machine" → `setLocalOverride`.
 *   Keys            signed in, a provider key typed into /admin goes to PUT /api/me/provider-keys/:provider
 *                   (write-only, Outfitter keeps it in Secret Manager), not to .env.
 *
 * A locked value (the fleet decides it) is read-only, "set by your Sysop". An opt-out value this
 * machine turned off is locked against the levels below it, not against the person: it stays
 * editable on this machine. Signed out there is no
 * account target: the Settings page saves to this machine only, and Connections writes .env as before.
 *
 * Requests go to the link origin with the session's access token (the same token central-config
 * uses); after a 401 the keychain is read once more and the request retried once (spec §2.4).
 * Nothing here logs or returns a key: provider keys come back as their last four characters only.
 */
import { readFileSync } from "node:fs";
import * as session from "../_shared/outfitter-session.ts";
import {
  KNOWN_SETTINGS, PROVIDER_ENV, SENTRY_LOCAL_FLAGS, coerce, describeSource, displayValue, isCentralSource, localOverridesPath, reloadConfig, resolve,
  setLocalOptOut, setLocalOverride,
  type ConfigValue, type KnownSetting, type ResolvedConfig, type SettingValue,
} from "../_shared/central-config.ts";
import { applyVoiceSettings } from "../_shared/central-apply.ts";

const FETCH_TIMEOUT_MS = 10_000;

/** What this module reads from the outside world; tests replace parts with `_setAdminCentralDeps`. */
export interface AdminCentralDeps {
  session: Pick<typeof session, "loginState" | "getAccessToken" | "outfitterApi">;
  fetch: typeof fetch;
  /** central-config's resolve and reload (seams so tests can count reloads). */
  resolve: () => ResolvedConfig;
  reload: () => Promise<ResolvedConfig>;
}

let overrides: Partial<AdminCentralDeps> = {};
function deps(): AdminCentralDeps {
  return {
    session: overrides.session ?? session,
    fetch: overrides.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
    resolve: overrides.resolve ?? (() => resolve()),
    reload: overrides.reload ?? (() => reloadConfig()),
  };
}

/** Test-only: replace some of the outside world (an empty object restores the defaults). */
export function _setAdminCentralDeps(d: Partial<AdminCentralDeps>): void {
  overrides = Object.keys(d).length ? { ...overrides, ...d } : {};
}

// ---------- the session and Outfitter ----------

/** The signed-in account for this process's API, or undefined (signed out, or no login yet). */
export function signedInAccount(): session.SessionAccount | undefined {
  try {
    const d = deps();
    const s = d.session.loginState({ api: d.session.outfitterApi() });
    return s.signedIn ? s.account : undefined;
  } catch {
    return undefined;
  }
}

export type OutfitterAnswer = { status: number; body: any; etag?: string };

/** One request to Outfitter with the session's token; undefined when there is no token to send. */
export async function outfitterRequest(account: session.SessionAccount, method: string, path: string, opts: { body?: unknown; ifMatch?: string } = {}): Promise<OutfitterAnswer | undefined> {
  const d = deps();
  const bearer = async () => { try { return await d.session.getAccessToken({ api: account.api, email: account.email, fetch: d.fetch }); } catch { return undefined; } };
  const send = (token: string) => d.fetch(`${account.api}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.ifMatch ? { "if-match": opts.ifMatch } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const token = await bearer();
  if (!token) return undefined;
  let res = await send(token);
  if (res.status === 401) {
    const again = await bearer();
    if (again && again !== token) res = await send(again);
  }
  const text = await res.text().catch(() => "");
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { status: res.status, body, etag: res.headers.get("etag") ?? undefined };
}

/** W/"<n>" → n. */
export function parseEtag(etag: string | undefined): number | undefined {
  const m = etag?.match(/^(?:W\/)?"(\d+)"$/);
  return m ? Number(m[1]) : undefined;
}

// ---------- the Settings page ----------

/** Where "Save to my account" writes: the profile this process resolved (KERNAL_PROFILE, else the
 * account's default), else the account-wide level. */
export type AccountTarget = { level: "profile"; name: string } | { level: "user" };

export function accountTarget(r: ResolvedConfig): AccountTarget {
  return r.profile ? { level: "profile", name: r.profile } : { level: "user" };
}

/** Signed in with no central answer yet (first start after kernal login, or an expired cache):
 * the resolution doesn't know the account's default profile, so ask Outfitter before choosing
 * the account target. Undefined when Outfitter can't answer either. */
async function withCentralAnswer(d: AdminCentralDeps, r: ResolvedConfig): Promise<ResolvedConfig | undefined> {
  if (r.fetchedAt !== null) return r;
  let fresh: ResolvedConfig | undefined;
  try { fresh = await d.reload(); } catch { fresh = undefined; }
  return fresh && fresh.fetchedAt !== null ? fresh : undefined;
}

/** Locked by the fleet or a group (or a lock the server sent), not by this machine's own opt-out
 * or by an opt-out key's default. */
export function sysopLocked(v: ConfigValue | undefined): boolean {
  return !!v?.locked && isCentralSource(v.source);
}

/** An opt-out key nothing central has turned on: this machine can turn it off, never on. */
const offByDefault = (decl: KnownSetting, v: ConfigValue | undefined) => decl.override === "opt-out" && !!v?.locked && v.source === "default";

const targetPath = (t: AccountTarget) => (t.level === "profile" ? `/api/config/profiles/${encodeURIComponent(t.name)}` : "/api/config/user");
const targetLabel = (t: AccountTarget) => (t.level === "profile" ? `Save to my account (profile ${t.name})` : "Save to my account");

/** The Settings page's source words (spec §11): fleet, your account, profile <name>, this machine, .env, shell. */
export function sourceLabel(v: { source: string; sourceName?: string }): string {
  return describeSource(v as Parameters<typeof describeSource>[0]);
}

export type SettingRow = {
  key: string; type: KnownSetting["type"]; choices?: readonly string[]; min?: number; max?: number; description: string;
  secret: boolean; default?: SettingValue;
  /** The effective value as shown (a secret only as its last four characters); absent when unset. */
  value?: SettingValue | string; source?: string; sourceLabel?: string; locked: boolean;
  /** Why the row can't be edited here, or undefined when it can. */
  readOnly?: string;
  /** What each save target holds for this key now (absent: not set there). */
  account?: SettingValue; machine?: SettingValue;
  canAccount: boolean; canMachine: boolean;
};

export type SettingsView = {
  signedIn: boolean;
  account?: { email: string; api: string };
  profile: string | null;
  profiles: string[];
  /** The account save target, with the version a write must name (If-Match). */
  target?: { level: "profile" | "user"; name?: string; label: string; version: number };
  /** Set when the account target could not be read (offline, unknown profile): account saves are off. */
  targetProblem?: string;
  fetchedAt: string | null;
  localFile: string;
  rows: SettingRow[];
};

function readMachineValues(): Record<string, unknown> {
  try {
    const f = JSON.parse(readFileSync(localOverridesPath(), "utf8")) as { version?: unknown; values?: unknown };
    return f && f.version === 1 && f.values && typeof f.values === "object" ? (f.values as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const levelOf = (t: AccountTarget) => t.level;

/** Builds the rows from a resolution, the account document (when signed in) and config.local.json. */
export function settingsRows(r: ResolvedConfig, target: AccountTarget | undefined, accountValues: Record<string, unknown> | undefined, machineValues: Record<string, unknown>): SettingRow[] {
  return KNOWN_SETTINGS.map((decl) => {
    const v = r.values[decl.key];
    const canLevelAccount = !!target && decl.levels.includes(levelOf(target));
    const canLevelMachine = decl.levels.includes("local") && !decl.secret;
    let readOnly: string | undefined;
    if (sysopLocked(v)) readOnly = "set by your Sysop";
    else if (offByDefault(decl, v) && machineValues[decl.key] === undefined) readOnly = "off unless your Sysop turns it on";
    else if (decl.secret) readOnly = decl.key === "router.key" ? "this device's key from kernal login; a key of your own goes on the Connections page" : "a secret";
    else if (!canLevelAccount && !canLevelMachine) readOnly = decl.levels.includes("fleet") && decl.levels.length === 1 ? "only your Sysop sets this" : "can't be set here";
    const account = accountValues ? coerce(decl, accountValues[decl.key]) : undefined;
    // A Sentry opt-out still in the legacy settings.json flag shows as this machine's `false`, so
    // "not set here" can clear it (saveSettings → setLocalOptOut).
    const legacy = v?.source === "local" && v.sourceName === "settings.json" && v.value === false;
    const machine = legacy ? false : coerce(decl, machineValues[decl.key]);
    return {
      key: decl.key, type: decl.type, ...(decl.values ? { choices: decl.values } : {}), ...(decl.min !== undefined ? { min: decl.min } : {}), ...(decl.max !== undefined ? { max: decl.max } : {}),
      description: decl.description, secret: decl.secret, ...(decl.default !== undefined ? { default: decl.default } : {}),
      ...(v ? { value: decl.secret ? displayValue(decl.key, v.value) : v.value, source: v.source, sourceLabel: sourceLabel(v) } : {}),
      locked: !!v?.locked,
      ...(readOnly ? { readOnly } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(machine !== undefined ? { machine } : {}),
      canAccount: !readOnly && canLevelAccount,
      canMachine: !readOnly && canLevelMachine,
    };
  });
}

/** GET /settings: the resolution as rows, and the account document's version for the next write. */
export async function settingsView(): Promise<SettingsView> {
  const d = deps();
  let r = d.resolve();
  const account = signedInAccount();
  const machine = readMachineValues();
  const baseOf = (r: ResolvedConfig) => ({ profile: r.profile, profiles: r.profiles ?? [], fetchedAt: r.fetchedAt, localFile: localOverridesPath() });
  if (!account) return { signedIn: false, ...baseOf(r), rows: settingsRows(r, undefined, undefined, machine) };
  const known = await withCentralAnswer(d, r);
  if (!known) {
    return { signedIn: true, account: { email: account.email, api: account.api }, ...baseOf(r),
      targetProblem: "Outfitter could not be reached to learn your account's profile: account saves are off until it answers (or run kernal login)",
      rows: settingsRows(r, undefined, undefined, machine) };
  }
  r = known;
  const base = baseOf(r);
  const target = accountTarget(r);
  let doc: OutfitterAnswer | undefined;
  try { doc = await outfitterRequest(account, "GET", targetPath(target)); } catch { doc = undefined; }
  const view = { signedIn: true, account: { email: account.email, api: account.api }, ...base };
  if (!doc || doc.status !== 200) {
    const why = !doc ? "Outfitter could not be reached, or the sign-in has expired: run kernal login"
      : doc.body?.error === "unknown_profile" ? `profile ${target.level === "profile" ? target.name : ""} does not exist on your account any more`
      : `Outfitter answered ${doc.status}${doc.body?.error ? ` (${doc.body.error})` : ""}`;
    return { ...view, targetProblem: why, rows: settingsRows(r, undefined, undefined, machine) };
  }
  const version = parseEtag(doc.etag) ?? (typeof doc.body?.version === "number" ? doc.body.version : 0);
  const values = doc.body?.values && typeof doc.body.values === "object" ? doc.body.values : {};
  return {
    ...view,
    target: { level: target.level, ...(target.level === "profile" ? { name: target.name } : {}), label: targetLabel(target), version },
    rows: settingsRows(r, target, values, machine),
  };
}

export type SaveRequest = { target?: unknown; values?: unknown; version?: unknown };
export type SaveResult = { status: number; body: Record<string, unknown> };

/** Checks every value against Kernal's schema; a string from a form field is parsed for its type.
 * Null removes the key from the target. */
export function validateSettingValues(values: unknown, allowed: (decl: KnownSetting) => string | undefined): { patch: Record<string, SettingValue | null>; errors: Record<string, string> } {
  const patch: Record<string, SettingValue | null> = {}, errors: Record<string, string> = {};
  if (!values || typeof values !== "object" || Array.isArray(values)) return { patch, errors: { _: "values must be an object" } };
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const decl = KNOWN_SETTINGS.find((s) => s.key === key);
    if (!decl) { errors[key] = "not a setting this Kernal knows"; continue; }
    const refused = allowed(decl);
    if (refused) { errors[key] = refused; continue; }
    if (raw === null || raw === "") { patch[key] = null; continue; }
    const v = coerce(decl, raw, typeof raw === "string");
    if (v === undefined) { errors[key] = decl.type === "enum" ? `one of ${(decl.values ?? []).join(", ")}` : decl.type === "number" ? `a number${decl.min !== undefined ? ` from ${decl.min} to ${decl.max}` : ""}` : decl.type === "url" ? "an http(s) URL" : decl.type === "boolean" ? "on or off" : "not a valid value"; continue; }
    patch[key] = v;
  }
  return { patch, errors };
}

/** POST /settings: `{ target: "account" | "machine", values: { key: value | null }, version }`. */
export async function saveSettings(req: SaveRequest): Promise<SaveResult> {
  const d = deps();
  let r = d.resolve();
  const lockedOrSecret = (decl: KnownSetting) => sysopLocked(r.values[decl.key]) ? "set by your Sysop" : decl.secret ? "a secret is not saved here" : undefined;

  if (req.target === "machine") {
    const { patch, errors } = validateSettingValues(req.values, (decl) => lockedOrSecret(decl) ?? (decl.levels.includes("local") ? undefined : "can't be set on this machine"));
    // An opt-out key nothing central turned on: this machine may turn it off (or clear that), not on.
    for (const [k, v] of Object.entries(patch)) {
      const decl = KNOWN_SETTINGS.find((s) => s.key === k)!;
      if (v === true && offByDefault(decl, r.values[k])) { errors[k] = "off unless your Sysop turns it on"; delete patch[k]; }
    }
    if (Object.keys(errors).length) return { status: 422, body: { error: "nothing was saved", errors } };
    if (!Object.keys(patch).length) return { status: 200, body: { message: "Nothing to save" } };
    // Validated above, so setLocalOverride only throws on a disk error: then nothing more is written.
    try {
      // A Sentry key's opt-out goes through setLocalOptOut, as /sentry's does: clearing it removes the
      // legacy settings.json flag too, so /admin undoes any /sentry off and the other way round.
      for (const [k, v] of Object.entries(patch)) {
        if (SENTRY_LOCAL_FLAGS[k] && (v === null || v === false)) setLocalOptOut(k, v === false);
        else setLocalOverride(k, v === null ? undefined : v);
      }
    } catch (e: any) {
      return { status: 500, body: { error: String(e?.message ?? e).slice(0, 300) } };
    }
    // config.local.json is the lowest local layer: a .env entry or a shell variable still wins over it
    // (except for the personal keys, where this machine's choice wins, #437).
    const after = (() => { try { return d.resolve(); } catch { return undefined; } })();
    if (after) { try { applyVoiceSettings(after); } catch {} }
    const warnings: string[] = [];
    for (const k of Object.keys(patch)) {
      const v = after?.values[k];
      if (v && (v.source === "dotenv" || v.source === "env") && v.sourceName) {
        warnings.push(`${v.sourceName} in ${v.source === "dotenv" ? ".env" : "the shell"} still wins over this machine's ${k}: remove it there`);
      }
    }
    const n = Object.keys(patch).length;
    return { status: 200, body: { message: `Saved ${n} setting${n === 1 ? "" : "s"} to ${localOverridesPath()} (this machine only). ${whenSaved(Object.keys(patch))}`, saved: Object.keys(patch), ...(warnings.length ? { warnings } : {}) } };
  }

  if (req.target !== "account") return { status: 400, body: { error: "target is account or machine" } };
  const account = signedInAccount();
  if (!account) return { status: 409, body: { error: "not signed in: run kernal login to save to your account" } };
  if (typeof req.version !== "number" || !Number.isInteger(req.version) || req.version < 0) return { status: 400, body: { error: "version is required: reload the page" } };
  const known = await withCentralAnswer(d, r);
  if (!known) return { status: 502, body: { error: "Outfitter could not be reached to learn your account's profile; nothing was saved" } };
  r = known;
  const target = accountTarget(r);
  const level = levelOf(target);
  const { patch, errors } = validateSettingValues(req.values, (decl) => lockedOrSecret(decl) ?? (decl.levels.includes(level) ? undefined : level === "profile" ? "can't be set in a profile" : "can't be set on your account"));
  if (Object.keys(errors).length) return { status: 422, body: { error: "nothing was saved", errors } };
  if (!Object.keys(patch).length) return { status: 200, body: { message: "Nothing to save" } };

  let res: OutfitterAnswer | undefined;
  try { res = await outfitterRequest(account, "PUT", targetPath(target), { body: { values: patch }, ifMatch: `W/"${req.version}"` }); }
  catch (e: any) { return { status: 502, body: { error: `Outfitter could not be reached (${String(e?.message ?? e).slice(0, 120)})` } }; }
  if (!res) return { status: 401, body: { error: "the sign-in has expired: run kernal login" } };
  if (res.status === 409) return { status: 409, body: { error: "changed elsewhere, reload", stale: true } };
  if (res.status === 400 && typeof res.body?.key === "string") return { status: 422, body: { error: "nothing was saved", errors: { [res.body.key]: String(res.body.error ?? "refused") } } };
  if (res.status === 404) return { status: 404, body: { error: res.body?.error === "unknown_profile" ? "that profile no longer exists on your account: reload" : "not found" } };
  if (res.status < 200 || res.status >= 300) return { status: 502, body: { error: `Outfitter refused the change (${res.status}${res.body?.error ? `: ${res.body.error}` : ""})` } };

  // As `/config reload`: the fresh answer becomes this process's own, so the page shows the new sources.
  try { await d.reload(); } catch {}
  try { applyVoiceSettings(d.resolve()); } catch {}
  const n = Object.keys(patch).length;
  const where = target.level === "profile" ? `your account (profile ${target.name})` : "your account";
  return { status: 200, body: {
    message: `Saved ${n} setting${n === 1 ? "" : "s"} to ${where}. Every Kernal signed in to it picks them up at its next start; here, ${whenSaved(Object.keys(patch))}`,
    saved: Object.keys(patch),
    version: parseEtag(res.etag) ?? (typeof res.body?.version === "number" ? res.body.version : undefined),
  } };
}

/** When saved keys reach this Kernal (#437): "a, b apply now; c at the next session (…); d at the next start." */
export function whenSaved(keys: string[]): string {
  const by: Record<string, string[]> = { now: [], session: [], start: [] };
  for (const k of keys) by[KNOWN_SETTINGS.find((d) => d.key === k)?.takesEffect ?? "start"].push(k);
  const parts = [
    by.now.length ? `${by.now.join(", ")} ${by.now.length === 1 ? "applies" : "apply"} now` : "",
    by.session.length ? `${by.session.join(", ")} at the next session (/new or a restart; a running conversation keeps its model)` : "",
    by.start.length ? `${by.start.join(", ")} at the next start` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join("; ")}.` : "";
}

// ---------- the default model's save target (#437: /connect and the Model page) ----------

export type ModelSaveTarget = "account" | "machine";

/** Signed in: the two places a chosen default model can go, in the Settings page's words.
 * Undefined signed out, where the choice only goes to settings.json, as it always did. */
export function modelSaveTargets(): { account: string; machine: string } | undefined {
  if (!signedInAccount()) return undefined;
  let r: ResolvedConfig | undefined;
  try { r = deps().resolve(); } catch { r = undefined; }
  return { account: r ? targetLabel(accountTarget(r)) : "Save to my account", machine: "Only this machine" };
}

/**
 * Saves `provider`/`model` as the default to the account (the versioned PUT of the Settings page:
 * GET for the version, then PUT with If-Match) or to this machine (config.local.json). An account
 * save also clears this machine's own model.* overrides, which would otherwise keep winning here.
 * The caller has already switched the session and written settings.json (pi's own default).
 */
export async function saveModelDefault(target: ModelSaveTarget, provider: string, model: string): Promise<{ ok: boolean; message: string }> {
  const values = { "model.provider": provider, "model.default": model };
  if (target === "machine") {
    const r = await saveSettings({ target: "machine", values });
    return r.status === 200
      ? { ok: true, message: `saved as this machine's default (${localOverridesPath()})` }
      : { ok: false, message: `not saved to this machine: ${String(r.body.error ?? r.status)}${r.body.errors ? ` (${Object.values(r.body.errors as object).join("; ")})` : ""}` };
  }
  const saved = await saveAccountDefaults(values);
  return saved.ok ? { ok: true, message: `saved as the default on ${saved.where}` } : { ok: false, message: `not saved to your account: ${saved.message}` };
}

export type AccountDefaultsResult = { ok: boolean; message: string; where?: string; profile?: string; clearedPins: string[] };

/**
 * The model.* defaults (any of model.provider, model.default, model.thinking) to the account: the
 * profile in use, else the user level, with the Settings page's versioned PUT. A 409 (changed
 * elsewhere since the GET) refetches the version and tries once more. On success this machine's own
 * pins of those keys (config.local.json) are removed, since they would keep winning here over the
 * account (`clearedPins` names them). Never throws; `message` says why on failure.
 */
export async function saveAccountDefaults(values: Record<string, SettingValue>): Promise<AccountDefaultsResult> {
  try {
    if (!signedInAccount()) return { ok: false, message: "not signed in", clearedPins: [] };
    let last: SaveResult | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const view = await settingsView();
      if (!view.target) return { ok: false, message: view.targetProblem ?? "Outfitter did not answer", clearedPins: [] };
      const r = await saveSettings({ target: "account", values, version: view.target.version });
      if (r.status === 200) {
        const machine = readMachineValues();
        const clearedPins: string[] = [];
        try {
          for (const k of Object.keys(values)) if (machine[k] !== undefined) { setLocalOverride(k, undefined); clearedPins.push(k); }
        } catch {}
        return { ok: true, message: String(r.body.message ?? "saved"), where: view.target.name ? `your account (profile ${view.target.name})` : "your account", ...(view.target.name ? { profile: view.target.name } : {}), clearedPins };
      }
      last = r;
      if (!(r.status === 409 && r.body.stale)) break;
    }
    const b = last?.body ?? {};
    return { ok: false, message: `${String(b.error ?? last?.status)}${b.errors ? ` (${Object.values(b.errors as object).join("; ")})` : ""}`, clearedPins: [] };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), clearedPins: [] };
  }
}

// ---------- personal provider keys (spec §4) ----------

export const PROVIDERS = Object.keys(PROVIDER_ENV);
/** The env var /admin's Connections page edits → the provider it is for. */
export const PROVIDER_OF_FIELD: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PROVIDER_ENV).map(([p, name]) => [name, p]));

export type ProviderKeyRow = { provider: string; last4: string; setAt: string };

/** GET /api/me/provider-keys: which keys the account holds (last four characters, never a value). */
export async function listProviderKeys(account: session.SessionAccount): Promise<ProviderKeyRow[] | undefined> {
  try {
    const res = await outfitterRequest(account, "GET", "/api/me/provider-keys");
    if (!res || res.status !== 200 || !Array.isArray(res.body)) return undefined;
    return res.body
      .filter((k: any) => k && typeof k.provider === "string" && PROVIDERS.includes(k.provider))
      .map((k: any) => ({ provider: k.provider, last4: typeof k.last4 === "string" ? k.last4.slice(-4) : "", setAt: typeof k.setAt === "string" ? k.setAt : "" }));
  } catch {
    return undefined;
  }
}

/** PUT (a value) or DELETE (null) /api/me/provider-keys/:provider. Undefined on success, else why. */
export async function writeProviderKey(account: session.SessionAccount, provider: string, value: string | null): Promise<string | undefined> {
  if (!PROVIDERS.includes(provider)) return "not a provider Outfitter keeps keys for";
  let res: OutfitterAnswer | undefined;
  try {
    res = value === null
      ? await outfitterRequest(account, "DELETE", `/api/me/provider-keys/${provider}`)
      : await outfitterRequest(account, "PUT", `/api/me/provider-keys/${provider}`, { body: { value } });
  } catch {
    return "Outfitter could not be reached; nothing was saved";
  }
  if (!res) return "the sign-in has expired: run kernal login";
  if (res.status >= 200 && res.status < 300) return undefined;
  if (res.body?.error === "invalid_value") return "Outfitter refused the key: 8 to 512 characters, no spaces";
  return `Outfitter refused the key (${res.status}${typeof res.body?.error === "string" ? `: ${res.body.error}` : ""})`;
}

// ---------- #458: the Settings page's model dropdowns ----------

/** One provider connect knows, as its `kernal:connect` op "state" answers (the Model page's list). */
export type ConnectionModels = { id: string; registered: boolean; rejected?: string; models: string[] };
export type ModelOptionProvider = { id: string; label: string; models: string[]; note?: string };

const MODEL_PROVIDER_ORDER = ["litellm", "openrouter", "lmstudio"];
const MODEL_PROVIDER_LABEL: Record<string, string> = { litellm: "Router", openrouter: "OpenRouter", lmstudio: "Local server" };

/** The options behind model.default and compaction.summaryModel on the Settings page: each
 * provider's discovered models from connect (the router's, the curated OpenRouter list with every
 * level's adds and removes, the local server's), the same list the Model page shows. A provider
 * that isn't connected has none, and says why; with connect not loaded there are no providers,
 * and the page keeps plain text boxes. Options only: a save still takes any id. */
export function settingModelOptions(conns: readonly ConnectionModels[]): { providers: ModelOptionProvider[] } {
  const rank = (id: string) => { const i = MODEL_PROVIDER_ORDER.indexOf(id); return i < 0 ? MODEL_PROVIDER_ORDER.length : i; };
  return {
    providers: [...conns].sort((a, b) => rank(a.id) - rank(b.id)).map((c) => {
      const label = MODEL_PROVIDER_LABEL[c.id] ?? c.id;
      const models = c.registered ? [...new Set(c.models)] : [];
      const note = !c.registered
        ? `${label} is not connected${c.rejected ? ` (${c.rejected})` : ""}: set it up under Connections, or type the id with Other…`
        : models.length ? undefined : `${label} reported no models.`;
      return { id: c.id, label, models, ...(note ? { note } : {}) };
    }),
  };
}
