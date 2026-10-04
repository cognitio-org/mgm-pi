/**
 * Applying the centrally managed personal settings (#437, outfitter/docs/specs/central-auth.md §10):
 * model.provider, model.default and model.thinking at the start of a session, and voice.* in
 * pi-listen's settings. central-config decides each value and where it came from; this module only
 * applies the ones that change something:
 *
 *   - a value from this machine (config.local.json) or from Outfitter (fleet, group, account,
 *     profile, device) is applied;
 *   - a legacy value (settings.json, pi-listen's settings, KERNAL_SUMMARY_MODEL) is what pi,
 *     pi-listen and compaction read for themselves already, and a default changes nothing: those
 *     are left alone, so a Kernal nobody configured centrally starts exactly as before.
 *
 * Model and thinking, through pi's extension API (`pi.setModel`, `pi.setThinkingLevel`): pi picks
 * its start-up model from settings.json before any session_start, so this switches the new,
 * still empty session once, at session_start ("startup" and "new" only). It never switches a
 * session that has messages (a resumed or forked conversation keeps its model), never overrides
 * --model/--models/--provider/--thinking on the command line, and never runs inside a Drive, where
 * agentd chooses the model (run.spec settings, agentd settings.ts). A change mid-session therefore
 * reaches the next session (/new or the next start), never the running conversation.
 *
 * Compaction reads its two keys from central-config on every use (compaction/index.ts), and memory
 * is decided when Kernal starts (bin/kernal and outfitter-agentengine/laptop.ts), so neither needs
 * anything here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  KNOWN_SETTINGS, appliesOverLocal, describeSource, displayValue, resolve, voiceSettingsFile,
  type ConfigValue, type ResolvedConfig,
} from "./central-config.ts";
import { inSandbox } from "./env.ts";
import { readSettings } from "../connect/settings.ts";

// ---------- model and thinking at session start ----------

/** pi's own flags that choose the model or the thinking level (pi --help). */
const MODEL_FLAGS = new Set(["--model", "--models", "--provider"]);
const THINKING_FLAGS = new Set(["--thinking"]);

/** What the command line already decided: pi's flags win over every setting. */
export function cliChoices(argv: readonly string[] = process.argv): { model: boolean; thinking: boolean } {
  let model = false, thinking = false;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    if (MODEL_FLAGS.has(flag)) {
      model = true;
      // --model provider/id:high sets the thinking level too.
      const v = inline ?? argv[i + 1] ?? "";
      if (flag === "--model" && /:(off|minimal|low|medium|high|xhigh)$/.test(v)) thinking = true;
    }
    if (THINKING_FLAGS.has(flag)) thinking = true;
  }
  return { model, thinking };
}

type ModelRef = { provider: string; id: string };

export type StartApplyResult = { model?: string; thinking?: string; problem?: string; skipped?: string };

/** True when the session already holds a conversation (resumed, forked, continued). */
function hasMessages(ctx: any): boolean {
  try {
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    return entries.some((e: any) => e?.type === "message");
  } catch {
    return false;
  }
}

/** The model the settings name, or undefined when none applies here. `model.default` may also be
 * written `provider/id`, which then names its own backend. */
export function wantedModel(r: ResolvedConfig, current: ModelRef | undefined, find: (provider: string, id: string) => ModelRef | undefined,
  available: () => ModelRef[]): { model?: ModelRef; wanted?: string } {
  const p = r.values["model.provider"], m = r.values["model.default"];
  const providerApplies = appliesOverLocal(p), modelApplies = appliesOverLocal(m);
  if (!providerApplies && !modelApplies) return {};
  const provider = providerApplies ? String(p!.value) : (current?.provider ?? String(p?.value ?? "litellm"));
  if (modelApplies) {
    const id = String(m!.value);
    const direct = find(provider, id);
    if (direct) return { model: direct, wanted: `${provider}/${id}` };
    const slash = id.indexOf("/");
    if (slash > 0) {
      const named = find(id.slice(0, slash), id.slice(slash + 1));
      if (named) return { model: named, wanted: id };
    }
    return { wanted: `${provider}/${id}` };
  }
  // Only the backend is set: stay on the current model when it is already there, else that
  // backend's first model.
  if (current?.provider === provider) return { model: current, wanted: `${provider}/${current.id}` };
  const first = available().find((x) => x.provider === provider);
  return first ? { model: first, wanted: `${provider}/${first.id}` } : { wanted: `${provider} (no model available)` };
}

/**
 * At session_start: switch a new, empty session to the centrally managed (or this machine's)
 * default model and thinking level. Never throws; says why it did nothing in `skipped`.
 */
export async function applyModelAtSessionStart(pi: any, event: { reason?: string } | undefined, ctx: any,
  opts: { argv?: readonly string[]; resolved?: ResolvedConfig; perModelThinking?: (ref: ModelRef) => string | undefined } = {}): Promise<StartApplyResult> {
  try {
    if (inSandbox()) return { skipped: "in a Drive agentd chooses the model" };
    const reason = event?.reason ?? "startup";
    if (reason !== "startup" && reason !== "new") return { skipped: `session_start ${reason}` };
    if (hasMessages(ctx)) return { skipped: "the session has a conversation already" };
    const r = opts.resolved ?? resolve();
    const cli = cliChoices(opts.argv ?? process.argv);
    const out: StartApplyResult = {};
    const registry = ctx?.modelRegistry;
    let current: ModelRef | undefined = ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    if (!cli.model && registry) {
      const { model, wanted } = wantedModel(r, current,
        (p, id) => registry.find?.(p, id),
        () => (registry.getAvailable?.() ?? []).filter((x: any) => registry.hasConfiguredAuth?.(x) ?? true));
      if (wanted && !model) out.problem = `${wanted} is not available here; staying on ${current ? `${current.provider}/${current.id}` : "pi's default"}`;
      if (model && !(current && current.provider === model.provider && current.id === model.id)) {
        const ok = await pi.setModel(model);
        if (ok) { out.model = `${model.provider}/${model.id}`; current = { provider: model.provider, id: model.id }; }
        else out.problem = `${model.provider}/${model.id} has no key here; staying on ${current ? `${current.provider}/${current.id}` : "pi's default"}`;
      }
    }
    const t = r.values["model.thinking"];
    if (!cli.thinking && appliesOverLocal(t) && typeof pi.setThinkingLevel === "function") {
      // pi's own per-model level (settings.json modelThinkingLevels) wins, as it does over pi's
      // default level: it marks a model that can't think at that level.
      const perModel = current ? (opts.perModelThinking ?? settingsThinkingFor)(current) : undefined;
      if (!perModel && pi.getThinkingLevel?.() !== t!.value) {
        pi.setThinkingLevel(String(t!.value));
        out.thinking = String(t!.value);
      }
    }
    return out;
  } catch (e) {
    return { problem: `could not apply the default model: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function settingsThinkingFor(ref: ModelRef): string | undefined {
  const levels = readSettings().modelThinkingLevels;
  if (!levels || typeof levels !== "object" || Array.isArray(levels)) return undefined;
  const v = (levels as Record<string, unknown>)[`${ref.provider}/${ref.id}`];
  return typeof v === "string" ? v : undefined;
}

// ---------- voice: pi-listen's settings ----------

function readJson(path: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Puts voice.enabled and voice.language into pi-listen's settings when they come from this machine
 * or the account (appliesOverLocal). pi-listen reads its settings at each session_start, so a
 * change reaches the next session. Returns the keys it changed; never throws. Leaves pi-listen
 * alone with KERNAL_VOICE=off, like kernal-voice.
 */
export function applyVoiceSettings(r: ResolvedConfig = resolve(), path: string = voiceSettingsFile()): string[] {
  try {
    // A Drive has no microphone; KERNAL_VOICE=off leaves pi-listen alone, as kernal-voice does.
    if (inSandbox() || (process.env.KERNAL_VOICE ?? process.env.MGM_VOICE) === "off") return [];
    const enabled = r.values["voice.enabled"], language = r.values["voice.language"];
    const patch: Record<string, unknown> = {};
    if (appliesOverLocal(enabled)) patch.enabled = enabled!.value;
    if (appliesOverLocal(language)) patch.language = language!.value;
    if (!Object.keys(patch).length) return [];
    const settings = readJson(path) ?? (existsSync(path) ? undefined : {});
    if (!settings) return [];   // unparseable: a hand edit in progress is left alone
    const voice = settings.voice && typeof settings.voice === "object" ? settings.voice : {};
    const changed = Object.keys(patch).filter((k) => voice[k] !== patch[k]);
    if (!changed.length) return [];
    const next = { ...settings, voice: { ...voice, ...Object.fromEntries(changed.map((k) => [k, patch[k]])) } };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
    return changed.map((k) => `voice.${k}`);
  } catch {
    return [];
  }
}

// ---------- what /config says about a change ----------

const WHEN: Record<string, string> = {
  now: "applied now",
  session: "applies at the next session (/new or the next start); the running conversation keeps its model",
  start: "applies at the next start of Kernal",
};

/** When a key's change reaches this Kernal, in /config's words. */
export function whenItApplies(key: string): string {
  const decl = KNOWN_SETTINGS.find((d) => d.key === key);
  return WHEN[decl?.takesEffect ?? "start"];
}

function same(a: ConfigValue | undefined, b: ConfigValue | undefined): boolean {
  return a?.value === b?.value && a?.source === b?.source && a?.sourceName === b?.sourceName;
}

/** The personal keys that differ between two resolutions, one line each. */
export function describeChanges(before: ResolvedConfig, after: ResolvedConfig): string[] {
  const lines: string[] = [];
  for (const decl of KNOWN_SETTINGS) {
    if (!decl.accountFirst) continue;
    const a = before.values[decl.key], b = after.values[decl.key];
    if (same(a, b)) continue;
    const shown = b ? `${displayValue(decl.key, b.value)} (${describeSource(b)})` : "(unset)";
    lines.push(`  ${decl.key} → ${shown}: ${whenItApplies(decl.key)}`);
  }
  return lines;
}

/** A copy of a resolution's values, to compare after a reload. */
export function snapshot(r: ResolvedConfig): ResolvedConfig {
  return { ...r, values: { ...r.values } };
}
