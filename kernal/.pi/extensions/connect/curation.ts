/**
 * #440: the curated OpenRouter list as central settings. Reading is `curationLists()` (every level's
 * add and remove keys from central-config's resolution); `changeCuration` adds or removes one model
 * at the account (user, or the active profile) or on this machine, through the same save path as
 * /admin's Settings page (kernal-admin/central.ts), so the same checks and messages apply.
 *
 * Each level keeps its own add and remove keys, so a change on this machine never hides what the
 * account added (lib.ts curateOpenRouter combines them; a fleet removal always wins).
 */
import { resolve, type ResolvedConfig } from "../_shared/central-config.ts";
import { saveSettings, settingsView, signedInAccount } from "../kernal-admin/central.ts";
import { CURATION_KEYS, DEFAULT_OPENROUTER_MODELS, NO_CURATION, curateOpenRouter, parseIdList, type CurationLists } from "./lib.ts";

export type CurationTarget = "account" | "machine";

export function curationLists(r?: ResolvedConfig): CurationLists {
  let res: ResolvedConfig;
  try { res = r ?? resolve(); } catch { return NO_CURATION; }   // central settings never break the list
  const out = { ...NO_CURATION };
  for (const [name, key] of Object.entries(CURATION_KEYS) as [keyof CurationLists, string][]) out[name] = parseIdList(res.values[key]?.value);
  return out;
}

/** Whether "my account" is a target right now (signed in to Outfitter). */
export const canSaveToAccount = () => !!signedInAccount();

/**
 * Add or remove one model id at a target. Adding drops it from that level's removals; removing
 * drops it from that level's additions and, when the model would still be offered (a default, the
 * fleet's or another level's add), records the removal. Returns a message, or throws with why not.
 */
export async function changeCuration(action: "add" | "remove", id: string, target: CurationTarget, base: string[] = DEFAULT_OPENROUTER_MODELS): Promise<string> {
  id = id.trim();
  if (!id || /[,\s]/.test(id)) throw new Error(`"${id}" is not a model id`);
  const lists = curationLists();
  if (action === "add" && lists.fleetRemove.includes(id)) throw new Error(`${id} is hidden by your Sysop for everyone; it can't be added back`);
  const [addName, removeName] = target === "account" ? (["add", "remove"] as const) : (["localAdd", "localRemove"] as const);
  const next = { ...lists, [addName]: [...lists[addName]], [removeName]: [...lists[removeName]] };
  const without = (xs: string[]) => xs.filter((x) => x !== id);
  if (action === "add") {
    next[removeName] = without(next[removeName]);
    if (!curateOpenRouter(base, next).includes(id)) next[addName] = [...next[addName], id];
  } else {
    next[addName] = without(next[addName]);
    if (curateOpenRouter(base, next).includes(id)) next[removeName] = [...next[removeName], id];
  }
  const values: Record<string, string | null> = {};
  for (const name of [addName, removeName]) {
    if (next[name].join(",") !== lists[name].join(",")) values[CURATION_KEYS[name]] = next[name].length ? next[name].join(",") : null;
  }
  if (!Object.keys(values).length) return action === "add" ? `${id} is already on your list` : `${id} is not on your list`;

  let version: number | undefined;
  if (target === "account") {
    const view = await settingsView();
    if (!view.target) throw new Error(view.targetProblem ?? "not signed in: run kernal login to save to your account");
    version = view.target.version;
  }
  const res = await saveSettings({ target, values, version });
  if (res.status !== 200) {
    const errors = res.body.errors as Record<string, string> | undefined;
    throw new Error(errors ? Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join("; ") : String(res.body.error ?? `failed (${res.status})`));
  }
  const where = target === "account" ? "your account" : "this machine";
  return action === "add" ? `Added ${id} to the OpenRouter list on ${where}` : `Removed ${id} from the OpenRouter list on ${where}`;
}
