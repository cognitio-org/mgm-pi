/**
 * A default set inside Kernal goes to the account (#437, owner decision 2026-10-04;
 * outfitter/docs/specs/central-auth.md §11). pi's model picker Ctrl+S ("set as default") and a
 * default thinking level are written by pi itself to the agent's settings.json (`defaultProvider` +
 * `defaultModel`, `defaultThinkingLevel`). Under #437's precedence the account wins over that legacy
 * file, so without this a Ctrl+S would look broken on every machine signed in to an account with a
 * model.* value. This module catches those writes and saves them to the account (the active profile,
 * else the user level) with the Settings page's versioned PUT (kernal-admin/central.ts
 * saveAccountDefaults), so new sessions on every machine start with them.
 *
 * How a default is told apart from a per-session change: pi 0.87 emits `model_select` and
 * `thinking_level_select` for both, without a persist flag, and only a persisted change touches
 * settings.json. So Kernal keeps a record of the three keys as last seen
 * (`kernal-defaults-synced.json` next to settings.json): created from settings.json the first time,
 * moved on after every write Kernal makes itself (/connect, /admin's Model page: `noteOwnDefaultsWrite`)
 * and after every sync. A difference between settings.json and the record is a default someone set
 * outside Kernal's own writers (pi's Ctrl+S, the default thinking level, pi's /login choosing a
 * provider's model, a hand edit) and is saved to the account; Enter in the picker, cycling and a
 * session's thinking change never write the file, so they never reach the account.
 *
 * When it looks: a short settle after `model_select` / `thinking_level_select` (pi queues its
 * settings write on a promise and writes under a lock, so the file is read a moment later), and at
 * `session_start` and `agent_start`, which catch a Ctrl+S that emits nothing (the session's own
 * model, or a default thinking level equal to the session's) and one made just before quitting. The
 * record is on disk, not in memory, so a second Kernal on this machine never echoes the first one's
 * own writes, and a change one process already synced is not saved again by another. No fs.watch:
 * it fires for every other process's and pi's unrelated writes and is unreliable across platforms.
 *
 * Signed out, inside a Drive, or without kernal-admin (the Drive image): nothing is saved and the
 * record simply moves on (settings.json stays as pi wrote it, as before #437). A failure (offline,
 * expired sign-in, Outfitter refusing) never breaks the session: one notice says the default stays on
 * this machine. On success, a pin this machine holds for the same key (config.local.json, /admin
 * "Only this machine") is removed, or it would keep winning here over the new default.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSettings, settingsPath } from "../connect/settings.ts";
import { KNOWN_SETTINGS, describeSource, resolve, type SettingValue } from "./central-config.ts";
import { inSandbox } from "./env.ts";

export type Defaults = { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };
const KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

/** The record of the three keys as last seen, next to settings.json (it moves with the bundle). */
export function recordPath(settings: string = settingsPath()): string {
  return join(dirname(settings), "kernal-defaults-synced.json");
}

function pick(s: Record<string, unknown>): Defaults {
  const out: Defaults = {};
  for (const k of KEYS) if (typeof s[k] === "string" && s[k]) out[k] = s[k] as string;
  return out;
}

function readRecord(path: string): Defaults | undefined {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" && j.version === 1 ? pick(j) : undefined;
  } catch {
    return undefined;
  }
}

function writeRecord(d: Defaults, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, ...d }, null, 2) + "\n");
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
  } catch {}
}

/** Kernal itself wrote the defaults to settings.json (connect's saveDefault): not to be echoed. */
export function noteOwnDefaultsWrite(file: string = settingsPath()): void {
  // No record yet: initDefaultsRecord will start one from settings.json as it is now anyway.
  const path = recordPath(file);
  if (existsSync(path)) writeRecord(pick(readSettings(file)), path);
}

/** Creates the record from settings.json when there is none yet (first start with this, or a new
 * bundle after an upgrade): what is there already is no new choice. */
export function initDefaultsRecord(file: string = settingsPath()): void {
  // No settings.json, no pi agent dir here (a test, or pi not set up): nothing to watch.
  if (!existsSync(file)) return;
  const path = recordPath(file);
  if (!readRecord(path)) writeRecord(pick(readSettings(file)), path);
}

export type PendingDefaults = { model?: { provider: string; model: string }; thinking?: string; now: Defaults };

/** What settings.json holds that the record does not: provider and model count as a pair. */
export function pendingDefaults(file: string = settingsPath()): PendingDefaults | undefined {
  const now = pick(readSettings(file));
  const was = readRecord(recordPath(file));
  if (!was) return undefined;   // no record: initDefaultsRecord makes one, nothing is pending
  const out: PendingDefaults = { now };
  if ((now.defaultProvider !== was.defaultProvider || now.defaultModel !== was.defaultModel) && now.defaultProvider && now.defaultModel) {
    out.model = { provider: now.defaultProvider, model: now.defaultModel };
  }
  if (now.defaultThinkingLevel !== was.defaultThinkingLevel && now.defaultThinkingLevel) out.thinking = now.defaultThinkingLevel;
  return out.model || out.thinking ? out : undefined;
}

/** The account values for a pending change. A backend outside model.provider's choices (one of pi's
 * own) goes into model.default as `provider/id`, which names its own backend (central-apply). */
export function accountValues(p: PendingDefaults): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  if (p.model) {
    const providers = KNOWN_SETTINGS.find((d) => d.key === "model.provider")?.values ?? [];
    if (providers.includes(p.model.provider)) {
      values["model.provider"] = p.model.provider;
      values["model.default"] = p.model.model;
    } else {
      values["model.default"] = `${p.model.provider}/${p.model.model}`;
    }
  }
  if (p.thinking) {
    const levels = KNOWN_SETTINGS.find((d) => d.key === "model.thinking")?.values ?? [];
    if (levels.includes(p.thinking)) values["model.thinking"] = p.thinking;
  }
  return values;
}

type Admin = Pick<typeof import("../kernal-admin/central.ts"), "saveAccountDefaults" | "signedInAccount">;

export type SyncDeps = {
  /** kernal-admin's save helpers, loaded lazily: the Drive image ships without kernal-admin. */
  admin?: () => Promise<Admin | undefined>;
  file?: string;
};

export type SyncResult = { saved?: string[]; skipped?: string; problem?: string; notice?: { msg: string; level: "info" | "warning" } };

const loadAdmin = () => import("../kernal-admin/central.ts").catch(() => undefined) as Promise<Admin | undefined>;

/** What the notice calls the change. */
function what(p: PendingDefaults): string {
  const parts: string[] = [];
  if (p.model) parts.push(`${p.model.provider}/${p.model.model}`);
  if (p.thinking) parts.push(`thinking ${p.thinking}`);
  return parts.join(", ");
}

/**
 * Saves a default that settings.json holds and the record does not to the account, and moves the
 * record on. Never throws. The record moves first, so a second trigger (or a second Kernal) does
 * not save the same change again; a failed save is not retried: the default stays on this machine.
 */
export async function syncDefaults(deps: SyncDeps = {}): Promise<SyncResult> {
  try {
    if (inSandbox()) return { skipped: "in a Drive" };
    const file = deps.file ?? settingsPath();
    const p = pendingDefaults(file);
    if (!p) return { skipped: "nothing new" };
    writeRecord(p.now, recordPath(file));
    const admin = await (deps.admin ?? loadAdmin)();
    if (!admin || !admin.signedInAccount()) return { skipped: "signed out: settings.json only" };
    const values = accountValues(p);
    if (!Object.keys(values).length) return { skipped: "nothing the account holds" };
    const label = p.model && p.thinking ? "default model and thinking level" : p.model ? "default model" : "default thinking level";
    const r = await admin.saveAccountDefaults(values);
    if (!r.ok) {
      // The account's own value (if any) still decides new sessions on this machine: say so.
      let still = "";
      try {
        const v = resolve().values[p.model ? "model.default" : "model.thinking"];
        if (v && (v.source === "user" || v.source === "profile" || v.source === "device")) still = `; new sessions still start on ${describeSource(v)}'s ${String(v.value)}`;
      } catch {}
      return { problem: r.message, notice: { msg: `Couldn't save ${what(p)} to your account: ${r.message}. Kept on this machine (settings.json)${still}.`, level: "warning" } };
    }
    const pins = r.clearedPins.length ? ` This machine's own pin (${r.clearedPins.join(", ")} in config.local.json) was removed so it applies here too.` : "";
    return { saved: Object.keys(values), notice: { msg: `Saved ${what(p)} as your account's ${label}${r.profile ? ` (profile ${r.profile})` : ""}: new sessions on every machine signed in to it start with it.${pins}`, level: "info" } };
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}

/** Debounce after a select event: pi's settings write is queued, not done, when it emits. */
export const SETTLE_MS = 150;

/**
 * Registers the triggers on `pi` (kernal-config does this outside a Drive). Runs are serialized, so
 * an event and agent_start close together never save twice. `onSynced` is for tests.
 */
export function registerDefaultSync(pi: { on: (ev: string, h: (ev: any, ctx: any) => any) => void }, deps: SyncDeps & { onSynced?: (r: SyncResult) => void; settleMs?: number } = {}): { run: (ctx?: any) => Promise<SyncResult> } | undefined {
  // Only for Kernal's own agent dir (bin/kernal sets PI_CODING_AGENT_DIR): a bare pi's
  // ~/.pi/agent/settings.json is not Kernal's to sync.
  if (!deps.file && !process.env.PI_CODING_AGENT_DIR) return undefined;
  try { initDefaultsRecord(deps.file); } catch {}
  let chain: Promise<unknown> = Promise.resolve();
  const run = (ctx?: any): Promise<SyncResult> => {
    const next = chain.then(() => syncDefaults(deps)).then((r) => {
      // ctx may belong to a session that ended while the sync ran: its getters throw, so read it inside the try.
      if (r.notice) { try { if (ctx?.hasUI) ctx.ui.notify(r.notice.msg, r.notice.level); } catch {} }
      deps.onSynced?.(r);
      return r;
    });
    chain = next.catch(() => undefined);
    return next;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = (_ev: unknown, ctx: any) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void run(ctx); }, deps.settleMs ?? SETTLE_MS);
    (timer as any).unref?.();
  };
  // The settle timer holds the selecting session's ctx: it ends with that session.
  pi.on("session_shutdown", () => { if (timer) { clearTimeout(timer); timer = undefined; } });
  pi.on("model_select", soon);
  pi.on("thinking_level_select", soon);
  // Not awaited: a turn never waits on Outfitter.
  pi.on("agent_start", (_ev: unknown, ctx: any) => { if (pendingDefaults(deps.file)) void run(ctx); });
  return { run };
}
