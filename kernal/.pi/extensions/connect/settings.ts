/**
 * The agent's settings.json, and how the user's changes to it survive an upgrade.
 *
 * A release bundle lives in ~/.kernal/kernal-<version>-<platform>/, so PI_CODING_AGENT_DIR (and with it
 * settings.json) moves on every upgrade. Everything that writes settings writes that one file: pi
 * itself (/settings, thinking levels, installed packages), connect's default model, /compaction, the
 * web admin's subagent models. The bundle also ships settings.json with defaults that change between
 * releases (packages, subagent models, compaction), so neither file can simply replace the other.
 *
 * The answer is a three-way merge at install time, the way version control merges two edits of one
 * file: every bundle keeps a pristine copy of what it shipped (`settings.shipped.json`), so for each
 * value the installer can tell whether the user changed it (theirs vs the old shipped copy) and
 * whether the release changed it (the new shipped copy vs the old one):
 *
 *   user changed it, release did not   → the user's value         (a chosen default model survives)
 *   release changed it, user did not   → the new shipped value    (a new default arrives)
 *   neither                            → unchanged
 *   both                               → the user's value; objects are merged key by key, and lists
 *                                        of names (packages) keep the user's additions and removals
 *                                        on top of the new list
 *
 * Bundles built before this change carry no shipped copy, so there is no record of what the user
 * changed. For that one upgrade the keys a user sets through kernal (LEGACY_USER_KEYS) are kept and
 * everything else comes from the new release. Pure functions here; the installer runs
 * settings-merge.ts, and the tests drive both.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** The pristine copy of the shipped settings that each bundle carries next to settings.json. */
export const SHIPPED_FILE = "settings.shipped.json";

/**
 * Keys only the user sets. Used when the outgoing bundle has no shipped copy to compare against:
 * these are carried over as they are, every other key comes from the new release.
 */
export const LEGACY_USER_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "theme", "modelThinkingLevels", "kernal", "teleport"];

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Key order does not make two settings different. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
export const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Three-way merge of one value: `base` is what the old release shipped, `ours` what the user's
 * settings held when the upgrade started, `theirs` what the new release ships. `undefined` means
 * absent and is returned as such (the key is dropped).
 */
export function merge3(base: Json | undefined, ours: Json | undefined, theirs: Json | undefined): Json | undefined {
  if (same(ours, base)) return theirs;          // the user did not touch it: the release decides
  if (same(theirs, base)) return ours;          // only the user changed it
  if (isObj(ours) && isObj(theirs) && (base === undefined || isObj(base))) {
    const b: Obj = base ?? {};
    const out: Obj = {};
    // the new release's key order first, then keys only the user has
    for (const k of [...Object.keys(theirs), ...Object.keys(ours).filter((k) => !(k in theirs))]) {
      const v = merge3(b[k], ours[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isNames(ours) && isNames(theirs) && (base === undefined || isNames(base))) {
    const b = base ?? [];
    const removed = new Set(b.filter((x) => !ours.includes(x)));
    const out = theirs.filter((x) => !removed.has(x));
    for (const x of ours) if (!b.includes(x) && !out.includes(x)) out.push(x);
    return out;
  }
  return ours;                                  // both changed one value: the user's choice wins
}

/** What stands in for the old shipped copy when an old bundle has none: see LEGACY_USER_KEYS. */
export function legacyBase(ours: Obj): Obj {
  const base: Obj = { ...ours };
  for (const k of LEGACY_USER_KEYS) delete base[k];
  return base;
}

/** Dotted paths the user changed relative to what was shipped, for the installer's summary. */
export function userChanges(base: Json | undefined, ours: Json | undefined, prefix = ""): string[] {
  if (same(base, ours)) return [];
  if (isObj(base) && isObj(ours)) {
    return [...new Set([...Object.keys(base), ...Object.keys(ours)])].flatMap((k) => userChanges(base[k], ours[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix || "(everything)"];
}

/**
 * The settings to install: the new release's shipped settings with the user's changes on top.
 * `base` is the outgoing bundle's shipped copy, or undefined for a bundle that predates it.
 */
export function mergeSettings(base: Obj | undefined, ours: Obj, theirs: Obj): { settings: Obj; kept: string[]; legacy: boolean } {
  const b = base ?? legacyBase(ours);
  const merged = merge3(b, ours, theirs);
  return { settings: isObj(merged) ? merged : theirs, kept: userChanges(b, ours), legacy: !base };
}

// ---------- the live file ----------

/** The agent dir's settings.json (PI_CODING_AGENT_DIR when launched via bin/kernal, else ~/.pi/agent). */
export function settingsPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
}

export function readSettings(file = settingsPath()): Obj {
  try { const v = JSON.parse(readFileSync(file, "utf8")); return isObj(v) ? v : {}; } catch { return {}; }
}

/**
 * Read, change, write back. Every kernal writer goes through here, and every write lands in the one
 * settings.json the upgrade merge carries forward, so nothing written here needs to know about
 * upgrades. Unparseable JSON is refused rather than overwritten: it may be a hand edit in progress.
 */
export function updateSettings(change: (s: Obj) => void, file = settingsPath()): Obj {
  let s: Obj = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (!isObj(parsed)) throw new Error(`${file} does not hold a JSON object`);
      s = parsed;
    }
  }
  change(s);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  return s;
}

/** The `kernal` section of `settings`, or {} when it is missing or not an object. */
export function kernalSection(settings: Record<string, unknown>): Record<string, unknown> {
  return isObj(settings.kernal) ? settings.kernal : {};
}

/** Sets keys in the `kernal` section (undefined deletes one), through `write` (updateSettings). */
export function updateKernal(patch: Record<string, unknown>, write: typeof updateSettings = updateSettings): void {
  write((s) => {
    const k: Obj = isObj(s.kernal) ? s.kernal : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete k[key];
      else k[key] = value as Json;
    }
    s.kernal = k;
  });
}
