// #458: the models a person can pick for the model-valued central settings (model.default,
// compaction.summaryModel), per provider, for the Account page's dropdowns. GET /api/config/models
// answers it (routes/config.ts). Only options: the server still validates a write by type alone,
// so a model that isn't listed here can still be saved ("Other…" on the page).
//
// - litellm: the router's chat models, from ModelsService (LITELLM_ADMIN_KEY → /model/info, cached
//   five minutes and shared with GET /api/models), without the "litellm/" prefix: model.default
//   holds the router's own model name.
// - openrouter: Kernal's curated list (#440, #442) with the fleet's, the account's and the
//   profile's adds and removes applied, the way Kernal applies them (connect/lib.ts
//   curateOpenRouter). This machine's own adds (the "local" level) are never on the server.
// - lmstudio: a local server's models are only known on the machine itself (Kernal's /admin lists
//   them), so the list is empty here.

import type { ModelRow } from "../models.ts";
import type { ResolvedValue } from "./settings-schema.ts";

/** Kernal's base OpenRouter list, kept in step with kernal/.pi/extensions/connect/lib.ts
 * DEFAULT_OPENROUTER_MODELS (this package doesn't depend on Kernal). */
export const DEFAULT_OPENROUTER_MODELS: readonly string[] = [
  "anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "openai/gpt-5.5", "google/gemini-3.8-flash",
  "qwen/qwen3.6-35b-a3b", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "moonshotai/kimi-k3",
  "z-ai/glm-5.1",
];

/** Each level's add and remove keys, farthest first, as in Kernal's CURATION_LEVELS. The fleet's
 * removals are applied last and always win. */
const CURATION_LEVELS: ReadonlyArray<readonly [add: string, remove: string | undefined]> = [
  ["openrouter.models.fleetAdd", undefined],
  ["openrouter.models.add", "openrouter.models.remove"],
  ["openrouter.models.profileAdd", "openrouter.models.profileRemove"],
];
const FLEET_REMOVE = "openrouter.models.fleetRemove";

/** "a/b, c/d,,a/b" → ["a/b", "c/d"]. */
export function parseIdList(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** The curated OpenRouter list for one resolution (GET /api/config's `values`). */
export function curatedOpenRouter(values: Record<string, ResolvedValue | undefined>, base: readonly string[] = DEFAULT_OPENROUTER_MODELS): string[] {
  const out = new Set(base);
  const list = (key: string) => parseIdList(values[key]?.value);
  for (const [add, remove] of CURATION_LEVELS) {
    if (remove) for (const id of list(remove)) out.delete(id);
    for (const id of list(add)) out.add(id);
  }
  for (const id of list(FLEET_REMOVE)) out.delete(id);
  return [...out];
}

export type ModelProviderId = "litellm" | "openrouter" | "lmstudio";

export interface ProviderModels {
  id: ModelProviderId;
  /** The word Kernal's /admin uses for it: Router, OpenRouter, Local server. */
  label: string;
  /** Model ids as model.default holds them for this provider (no provider prefix). */
  models: string[];
  /** Why the list is empty or partial, in the page's words; absent when it is complete. */
  note?: string;
}

export interface ModelOptions {
  providers: ProviderModels[];
}

/** The answer of GET /api/config/models from the router's rows and the person's resolution. */
export function modelOptions(routerRows: readonly ModelRow[], values: Record<string, ResolvedValue | undefined>): ModelOptions {
  const router = [...new Set(routerRows.map((r) => r.id.replace(/^litellm\//, "")))].sort((a, b) => a.localeCompare(b));
  // Only this deployment's LOCAL_MODELS came back: the router itself didn't answer.
  const routerAnswered = routerRows.some((r) => !r.local);
  return {
    providers: [
      { id: "litellm", label: "Router", models: router, ...(routerAnswered ? {} : { note: "The router's model list couldn't be read just now." }) },
      { id: "openrouter", label: "OpenRouter", models: curatedOpenRouter(values) },
      { id: "lmstudio", label: "Local server", models: [], note: "A local server's models are only known on that computer: use Kernal's /admin there, or type the id." },
    ],
  };
}
