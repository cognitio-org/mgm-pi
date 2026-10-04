/**
 * #440: the curated OpenRouter list as central settings. Reading is `curationLists()` (every level's
 * add and remove keys from central-config's resolution); `changeCuration` adds or removes one model
 * at the account (the user, or the active profile's own pair) or on this machine, through the same
 * save path as /admin's Settings page (kernal-admin/central.ts), so the same checks apply.
 *
 * Each level keeps its own add and remove keys, so a change at one never replaces another's list
 * (lib.ts curateOpenRouter applies them, the nearer level winning; a fleet removal always wins).
 * A change starts from what the target holds now: the account document from the same GET that
 * supplies its If-Match version, config.local.json read from disk. The resolution is memoised for
 * the process and may be older, which would drop another machine's additions.
 */
import { readLocalOverrides, resolve, type ResolvedConfig } from "../_shared/central-config.ts";
import { saveSettings, settingsView, signedInAccount } from "../kernal-admin/central.ts";
import { CURATION_KEYS, CURATION_LEVELS, DEFAULT_OPENROUTER_MODELS, NO_CURATION, curateOpenRouter, parseIdList, type CurationLists } from "./lib.ts";

export type CurationTarget = "account" | "machine";
type ListName = keyof CurationLists;

/** An OpenRouter model id: `vendor/model`, optionally with a `:variant`; `~` marks a "latest" alias. */
const ID_SHAPE = /^~?[A-Za-z0-9][\w.-]*\/[\w.-]+(?::[\w.-]+)?$/;
const MAX_ID = 200;
/** Outfitter's limit on a string setting (settings-schema.ts coerceSettingValue). */
const MAX_VALUE = 1024;

export function curationLists(r?: ResolvedConfig): CurationLists {
  let res: ResolvedConfig;
  try { res = r ?? resolve(); } catch { return { ...NO_CURATION }; }   // central settings never break the list
  const out = { ...NO_CURATION };
  for (const [name, key] of Object.entries(CURATION_KEYS) as [ListName, string][]) out[name] = parseIdList(res.values[key]?.value);
  return out;
}

/** Whether "my account" is a target right now (signed in to Outfitter). */
export const canSaveToAccount = () => !!signedInAccount();

const LEVEL_WORDS: Record<string, string> = { add: "your account", profileAdd: "your profile", localAdd: "this machine", remove: "your account", profileRemove: "your profile", localRemove: "this machine" };

/**
 * Add or remove one model id at a target. Adding clears that level's removal of it, and an account
 * add also clears this machine's (it is the machine you are on); removing does the reverse. When
 * the model would still be offered or still hidden through another list, the change is refused
 * with the reason rather than saved without effect. `catalogue` (OpenRouter's ids, when known)
 * refuses an id OpenRouter doesn't list. Returns a message, or throws with why not.
 */
export async function changeCuration(action: "add" | "remove", rawId: string, target: CurationTarget, opts: { base?: string[]; catalogue?: string[] } = {}): Promise<string> {
  const id = rawId.trim();
  const base = opts.base ?? DEFAULT_OPENROUTER_MODELS;
  // A removal takes any stored id (one saved on the Settings page may not have the shape); an add must.
  if (!id || /,/.test(id) || (action === "add" && (!ID_SHAPE.test(id) || id.length > MAX_ID))) throw new Error(`"${id.slice(0, 80)}" is not an OpenRouter model id (vendor/model)`);
  if (action === "add" && opts.catalogue?.length && !opts.catalogue.includes(id) && !opts.catalogue.includes(id.replace(/:[^/:]+$/, ""))) throw new Error(`OpenRouter doesn't list ${id}`);
  const lists = curationLists();
  if (action === "add" && lists.fleetRemove.includes(id)) throw new Error(`${id} is hidden by your Sysop for everyone; it can't be added back`);

  // The target's own pair, and this machine's, as stored right now.
  let version: number | undefined;
  let pair: [ListName, ListName];
  const stored: Partial<Record<ListName, string[]>> = {};
  const local = readLocalOverrides();
  stored.localAdd = parseIdList(local[CURATION_KEYS.localAdd]);
  stored.localRemove = parseIdList(local[CURATION_KEYS.localRemove]);
  if (target === "account") {
    const view = await settingsView();
    if (!view.target) throw new Error(view.targetProblem ?? "not signed in: run kernal login to save to your account");
    version = view.target.version;
    pair = view.target.level === "profile" ? ["profileAdd", "profileRemove"] : ["add", "remove"];
    for (const name of pair) stored[name] = parseIdList(view.rows.find((r) => r.key === CURATION_KEYS[name])?.account);
  } else {
    pair = ["localAdd", "localRemove"];
  }
  const now = { ...lists, ...stored } as CurationLists;
  const next = { ...now } as CurationLists;
  const without = (xs: string[]) => xs.filter((x) => x !== id);
  const [addName, removeName] = pair;
  const touched = new Set<ListName>(pair);
  if (action === "add") {
    next[removeName] = without(next[removeName]);
    if (target === "account" && next.localRemove.includes(id)) { next.localRemove = without(next.localRemove); touched.add("localRemove"); }
    if (!curateOpenRouter(base, next).includes(id)) next[addName] = [...next[addName], id];
  } else {
    next[addName] = without(next[addName]);
    if (target === "account" && next.localAdd.includes(id)) { next.localAdd = without(next.localAdd); touched.add("localAdd"); }
    if (curateOpenRouter(base, next).includes(id)) next[removeName] = [...next[removeName], id];
  }

  // Refuse a change that would be saved without effect, naming the list that still decides.
  const offered = curateOpenRouter(base, next).includes(id);
  if (offered !== (action === "add")) {
    const nearer = CURATION_LEVELS.slice(CURATION_LEVELS.findIndex(([a]) => a === addName) + 1).flatMap(([a, r]) => [a, r]).filter(Boolean) as ListName[];
    const decider = nearer.find((n) => next[n].includes(id));
    throw new Error(decider ? `${LEVEL_WORDS[decider]} ${action === "add" ? "removes" : "adds"} ${id}, and it wins over ${LEVEL_WORDS[addName]}: change it there` : `${id} could not be ${action === "add" ? "added" : "removed"}`);
  }

  const account: Record<string, string | null> = {}, machine: Record<string, string | null> = {};
  for (const name of touched) {
    if (next[name].join(",") === now[name].join(",")) continue;
    const value = next[name].join(",");
    if (value.length > MAX_VALUE) throw new Error(`the list on ${LEVEL_WORDS[name]} is full (${MAX_VALUE} characters): remove some models first`);
    (name === "localAdd" || name === "localRemove" ? machine : account)[CURATION_KEYS[name]] = value || null;
  }
  if (!Object.keys(account).length && !Object.keys(machine).length) return action === "add" ? `${id} is already on your list` : `${id} is not on your list`;

  const save = async (t: CurationTarget, values: Record<string, string | null>) => {
    if (!Object.keys(values).length) return;
    const res = await saveSettings({ target: t, values, version: t === "account" ? version : undefined });
    if (res.status === 200) return;
    const errors = res.body.errors as Record<string, string> | undefined;
    if (errors && Object.values(errors).includes("unknown_key")) throw new Error("your Outfitter doesn't support a curated OpenRouter list yet; save to this machine instead");
    if (res.status === 409) throw new Error("your account's settings changed elsewhere just now; try again");
    throw new Error(errors ? Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join("; ") : String(res.body.error ?? `failed (${res.status})`));
  };
  // This machine first: its only failure is a disk error, and then nothing reached the account.
  await save("machine", machine);
  await save("account", account);
  const where = target === "account" ? (addName === "profileAdd" ? "your profile" : "your account") : "this machine";
  return action === "add" ? `Added ${id} to the OpenRouter list on ${where}` : `Removed ${id} from the OpenRouter list on ${where}`;
}
