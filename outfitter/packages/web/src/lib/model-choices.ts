// #458: pure helpers behind the Account page's model dropdowns (components/account/ModelField.tsx):
// which settings get one, the options each offers for the selected provider, the search, and
// whether a stored value is in the list.

import type { ModelOptions } from "../api/account.ts";

/** How a model-valued setting holds its value: `model.default` is a model id of the provider
 * `model.provider` names (the router's own model name, an OpenRouter id); `compaction.summaryModel`
 * names its provider too, as `provider/id` (Kernal's compaction reads it that way). */
export const MODEL_SETTINGS: Readonly<Record<string, "provider" | "qualified">> = {
  "model.default": "provider",
  "compaction.summaryModel": "qualified",
};

export const PROVIDER_KEY = "model.provider";

/** The provider names model.provider takes, in the page's words. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  litellm: "Router (LiteLLM)",
  openrouter: "OpenRouter",
  lmstudio: "Local server (LM Studio)",
};

/** compaction.summaryModel's "self": summarize with the working model (`/compaction model self`). */
export const SUMMARIZE_WITH_SELF: ModelChoice = { value: "self", group: "The working model" };

export function isModelSetting(key: string): boolean {
  return key in MODEL_SETTINGS;
}

export interface ModelChoice {
  /** What the setting stores when this is picked. */
  value: string;
  /** The provider's name, for grouping. */
  group: string;
}

export interface ChoiceSet {
  choices: ModelChoice[];
  /** Why the list is empty or partial (the api's note), if it is. */
  note?: string;
}

/** The options for `key` with `provider` selected. `model.default` offers that provider's models
 * only; `compaction.summaryModel` offers every provider's, as `provider/id`, the selected one
 * first. Null while the options are loading or couldn't be read. */
export function choicesFor(key: string, provider: string, options: ModelOptions | null): ChoiceSet | null {
  if (!options) return null;
  const kind = MODEL_SETTINGS[key];
  if (kind === "provider") {
    const p = options.providers.find((x) => x.id === provider);
    if (!p) return { choices: [], note: `No list for the provider "${provider}": type the model's id with Other….` };
    return { choices: p.models.map((m) => ({ value: m, group: p.label })), ...(p.note ? { note: p.note } : {}) };
  }
  const ordered = [...options.providers].sort((a, b) => Number(b.id === provider) - Number(a.id === provider));
  return { choices: [SUMMARIZE_WITH_SELF, ...ordered.flatMap((p) => p.models.map((m) => ({ value: `${p.id}/${m}`, group: p.label })))] };
}

/** Case-insensitive substring search over the values, capped so a large router list stays a
 * short menu. An empty query keeps the first `limit`. */
export function filterChoices(choices: readonly ModelChoice[], query: string, limit = 100): ModelChoice[] {
  const q = query.trim().toLowerCase();
  const rows = q ? choices.filter((c) => c.value.toLowerCase().includes(q)) : choices;
  return rows.slice(0, limit);
}

/** True when `value` is one of the options (an empty value, "not set", always is). */
export function inList(choices: readonly ModelChoice[], value: string): boolean {
  return value === "" || choices.some((c) => c.value === value);
}
