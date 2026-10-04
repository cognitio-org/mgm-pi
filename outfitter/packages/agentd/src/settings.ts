// Central settings in a Drive (docs/specs/central-auth.md §9, #395): run.spec.settings carries the
// session owner's resolved values (their default profile), so a Drive starts the way their laptop
// does. Pure: run.ts applies the result once, before the guru is rendered.
//
// The tape stays in charge. A setting only fills what the tape leaves unset:
//   - model.default     -> guru.model, when the tape names no model
//   - model.thinking    -> guru.thinking, when the tape sets no level
//   - compaction.summaryModel -> KERNAL_SUMMARY_MODEL in guru.env, when the tape sets none
// The whole set also goes to Kernal as KERNAL_RUN_SETTINGS (JSON: the values and each one's source
// level) for the keys agentd has no switch for (compaction.masking, ...); Kernal ranks them with the
// fleet, below the tape's own env (central-config.ts, #437). memory.mode is not applied: Agent Engine
// memory in a Drive is the tape's capability, which the api checks on every admin.request, so a
// person's laptop preference can't turn it on there. Unknown keys and values of the wrong type are
// ignored, so an older agentd keeps working against a newer api.

import type { DownRunSpec } from "./protocol.js";

/** The env var Kernal in a Drive reads the owner's settings from: `{ schemaVersion, profile,
 * values: { "<key>": <value> } }`. */
export const RUN_SETTINGS_ENV = "KERNAL_RUN_SETTINGS";

/** pi's thinking levels (the schema's model.thinking enum). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The values of a well-formed run.spec.settings, or undefined. Entries that aren't
 * `{ value: string | number | boolean }` are dropped. */
export function settingValues(settings: unknown): Record<string, string | number | boolean> | undefined {
  if (!isPlainObject(settings) || !isPlainObject(settings.values)) return undefined;
  const values: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(settings.values)) {
    if (!isPlainObject(entry)) continue;
    const v = entry.value;
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) values[key] = v;
  }
  return values;
}

/** Where each value came from (fleet, user, profile, default, ...), for Kernal's /config and its
 * precedence (central-config.ts reads KERNAL_RUN_SETTINGS, #437). Level names only. */
export function settingSources(settings: unknown): Record<string, string> {
  const sources: Record<string, string> = {};
  if (!isPlainObject(settings) || !isPlainObject(settings.values)) return sources;
  for (const [key, entry] of Object.entries(settings.values)) {
    if (isPlainObject(entry) && typeof entry.source === "string" && /^[a-z]{1,16}$/.test(entry.source)) sources[key] = entry.source;
  }
  return sources;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `spec` with the owner's settings filled in where the tape left a gap. Returns `spec` itself when
 * there is nothing to apply. Never throws. */
export function applyRunSettings(spec: DownRunSpec, onLog: (line: string) => void = () => {}): DownRunSpec {
  const values = settingValues(spec.settings);
  if (!values || Object.keys(values).length === 0) return spec;
  const guru = { ...spec.guru };
  const env = { ...(guru.env ?? {}) };
  const applied: string[] = [];

  const model = nonBlank(values["model.default"]);
  if (model && !nonBlank(guru.model)) {
    guru.model = model;
    applied.push("model.default");
  }
  const thinking = values["model.thinking"];
  if (typeof thinking === "string" && THINKING_LEVELS.has(thinking) && guru.thinking === undefined) {
    guru.thinking = thinking;
    applied.push("model.thinking");
  }
  const summaryModel = nonBlank(values["compaction.summaryModel"]);
  if (summaryModel && env.KERNAL_SUMMARY_MODEL === undefined) {
    env.KERNAL_SUMMARY_MODEL = summaryModel;
    applied.push("compaction.summaryModel");
  }
  if (env[RUN_SETTINGS_ENV] === undefined) {
    const profile = isPlainObject(spec.settings) && typeof spec.settings.profile === "string" ? spec.settings.profile : null;
    const schemaVersion = isPlainObject(spec.settings) && typeof spec.settings.schemaVersion === "number" ? spec.settings.schemaVersion : 0;
    env[RUN_SETTINGS_ENV] = JSON.stringify({ schemaVersion, profile, values, sources: settingSources(spec.settings) });
  }
  guru.env = env;
  // Key names only: the values are a person's preferences, not for the log.
  if (applied.length > 0) onLog(`settings: applied ${applied.join(", ")} from the owner's settings`);
  return { ...spec, guru };
}
