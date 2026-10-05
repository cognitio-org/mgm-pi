// A floppy's model. The tape only seeds it: createSession pins the tape's model on the new floppy
// as `modelOverride`, and from then on the floppy keeps its own (a later tape edit doesn't move
// it). PUT /api/sessions/:id/model switches it, and every later run.spec uses it (agentlink.ts's
// buildRunSpec). A Drive that is already going gets it too: pi's own `set_model` RPC, through the
// `rpc` down-frame agentd hands straight to pi (queued until pi is up). pi then writes a
// `model_change` entry, which the session header reads, and which the next run's restore sees, so
// that run doesn't pass `--model` again (agentd's Bug 8 check).

import type { RouteContext } from "./routes/context.ts";
import type { Guru, PiEntry, Run, Session, Store } from "./store/types.ts";
import { resolveRunModel } from "./laptop.ts";

export const MODEL_ID_MAX = 200;

/** A `:<level>` thinking suffix (pi's levels), which `--model` takes but `set_model` doesn't. */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh)$/;

/** `provider/id`, as a tape names its model: no whitespace, both halves non-empty. The id may hold
 * more slashes (`litellm/openrouter/x`) or a colon (a Bedrock id), but not a thinking suffix: the
 * tape sets the thinking level, and a suffixed id couldn't switch a running pi. */
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MODEL_ID_MAX && /^[^\s/]+\/\S+$/.test(value) && !THINKING_SUFFIX.test(value);
}

/** A tape may name `provider/id:high` (pi's `--model` syntax). A floppy keeps the bare model; the
 * level stays the tape's (tapeThinking). */
export function bareModel(model: string): string {
  return model.replace(THINKING_SUFFIX, "");
}

/** The tape's thinking level: its own field, else the suffix on its model. */
export function tapeThinking(guru: Pick<Guru, "model" | "thinking">): string | undefined {
  return guru.thinking ?? guru.model?.match(THINKING_SUFFIX)?.[1];
}

/** The tape's model as a new floppy pins it (bare), or undefined when the tape names none. */
export function pinnableModel(guru: Pick<Guru, "model"> | null | undefined): string | undefined {
  return guru?.model ? bareModel(guru.model) : undefined;
}

/** pi's `set_model` takes the provider and the id apart; the provider is everything before the
 * first slash. */
export function setModelCommand(model: string): { type: "set_model"; provider: string; modelId: string } {
  const slash = model.indexOf("/");
  return { type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/** The last model a transcript records (pi's `model_change` entries, `provider/modelId`), for a
 * floppy from before models were pinned: it restores on what it last ran, not the tape's current
 * model. Mirrors agentd's lastKnownModelState. */
export function transcriptModel(entries: readonly PiEntry[]): string | undefined {
  let model: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "model_change") continue;
    if (typeof entry.provider === "string" && typeof entry.modelId === "string" && entry.provider && entry.modelId) {
      model = `${entry.provider}/${entry.modelId}`;
    }
  }
  return model;
}

/** What a run of this floppy starts on, before the laptop preflight. A floppy from before models
 * were pinned is pinned here, once: on its transcript's last model (or what that run wanted, when
 * the laptop preflight had swapped in a fallback), else the tape's. From then on it reads like any
 * other floppy, so the transcript is read once per old floppy, not per run. */
export async function floppyModel(store: Store, session: Session, guru: Pick<Guru, "model">): Promise<string> {
  if (session.modelOverride) return session.modelOverride;
  const last = transcriptModel((await store.entries.listForSession(session.id)).map((e) => e.entry));
  const swapped = last ? (await store.runs.listForSession(session.id)).find((r) => r.modelFallback?.used === last)?.modelFallback : undefined;
  const pinned = swapped?.wanted ?? last ?? pinnableModel(guru);
  // A tape with no model and no transcript yet: central settings decide (agentd); nothing to pin.
  if (!pinned) return guru.model;
  await store.sessions.setModelOverride(session.id, pinned, new Date().toISOString());
  return pinned;
}

/** A run whose pi will take a `set_model` now or once it is up. A stopping run is checkpointing on
 * its way out; the next run starts on the new model from its spec. */
function takesLiveSwitch(run: Run | null): run is Run {
  return !!run && (run.state === "queued" || run.state === "provisioning" || run.state === "running" || run.state === "idle");
}

export interface ModelSwitch {
  /** What the floppy now has; null only when its tape names no model (central settings decide). */
  modelOverride: string | null;
  /** The model pi was told to use: the laptop preflight may have swapped a laptop model out. */
  model: string;
  /** "live": the active Drive was told; "next-run": no Drive is going, so the next one starts on it. */
  applied: "live" | "next-run";
  modelFallback?: { wanted: string; used: string };
}

/** Stores the floppy's model and, when a Drive is going, switches its pi over. `model` null copies
 * the tape's model as it is now (a copy, like at creation: later tape edits still don't follow).
 * `guru` is null when the floppy's tape has been deleted. */
export async function switchSessionModel(ctx: RouteContext, session: Session, guru: Guru | null, model: string | null): Promise<ModelSwitch> {
  const stored = model ?? pinnableModel(guru) ?? null;
  await ctx.store.sessions.setModelOverride(session.id, stored, new Date().toISOString());
  const run = await ctx.store.runs.findActiveForSession(session.id);
  if (!takesLiveSwitch(run)) return { modelOverride: stored, model: stored ?? "", applied: "next-run" };
  const laptopOnline = await ctx.laptopProbe.isOnline();
  // Two switches at once: whichever sends last must send what is stored now, or pi would stay on
  // the older one while the floppy says the newer. So read the floppy again right before sending.
  const current = (await ctx.store.sessions.findById(session.id))?.modelOverride ?? null;
  // Null: the tape names no model, which leaves it to the owner's central settings (agentd's).
  const wanted = current ?? "";
  if (!wanted) return { modelOverride: current, model: wanted, applied: "next-run" };
  const resolved = resolveRunModel({
    wanted,
    guruFallbackModel: guru?.fallbackModel,
    localModels: ctx.config.localModels,
    defaultCloudModel: ctx.config.defaultCloudModel,
    laptopOnline,
  });
  await ctx.agentLink.send(run.id, { t: "rpc", command: setModelCommand(resolved.model) });
  await ctx.store.runs.update(run.id, { modelFallback: resolved.fallback, updatedAt: new Date().toISOString() });
  return {
    modelOverride: current,
    model: resolved.model,
    applied: "live",
    ...(resolved.fallback ? { modelFallback: resolved.fallback } : {}),
  };
}
