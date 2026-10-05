// Switching a floppy's model (PUT /api/sessions/:id/model). The choice is stored on the session as
// `modelOverride`, which every later run.spec already prefers over the tape's model (agentlink.ts's
// buildRunSpec). A Drive that is already going gets it too: pi's own `set_model` RPC, through the
// `rpc` down-frame agentd hands straight to pi (queued until pi is up). pi then writes a
// `model_change` entry, which the session header reads, and which the next run's restore sees, so
// that run doesn't pass `--model` again (agentd's Bug 8 check).

import type { RouteContext } from "./routes/context.ts";
import type { Guru, Run, Session } from "./store/types.ts";
import { resolveRunModel } from "./laptop.ts";

export const MODEL_ID_MAX = 200;

/** `provider/id`, as a tape names its model: no whitespace, both halves non-empty. The id may hold
 * more slashes (`litellm/openrouter/x`) or a colon (a Bedrock id). */
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MODEL_ID_MAX && /^[^\s/]+\/\S+$/.test(value);
}

/** pi's `set_model` takes the provider and the id apart; the provider is everything before the
 * first slash. */
export function setModelCommand(model: string): { type: "set_model"; provider: string; modelId: string } {
  const slash = model.indexOf("/");
  return { type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/** A run whose pi will take a `set_model` now or once it is up. A stopping run is checkpointing on
 * its way out; the next run starts on the new model from its spec. */
function takesLiveSwitch(run: Run | null): run is Run {
  return !!run && (run.state === "queued" || run.state === "provisioning" || run.state === "running" || run.state === "idle");
}

export interface ModelSwitch {
  /** What the floppy now asks for; null means the tape's model. */
  modelOverride: string | null;
  /** The model pi was told to use: the laptop preflight may have swapped a laptop model out. */
  model: string;
  /** "live": the active Drive was told; "next-run": no Drive is going, so the next one starts on it. */
  applied: "live" | "next-run";
  modelFallback?: { wanted: string; used: string };
}

/** Stores the floppy's model and, when a Drive is going, switches its pi over. `model` null goes
 * back to the tape's own. `guru` is null when the floppy's tape has been deleted. */
export async function switchSessionModel(ctx: RouteContext, session: Session, guru: Guru | null, model: string | null): Promise<ModelSwitch> {
  await ctx.store.sessions.setModelOverride(session.id, model, new Date().toISOString());
  const wanted = model ?? guru?.model ?? "";
  const run = await ctx.store.runs.findActiveForSession(session.id);
  // A tape with no model leaves it to the owner's central settings, which only agentd applies.
  if (!takesLiveSwitch(run) || !wanted) return { modelOverride: model, model: wanted, applied: "next-run" };
  const resolved = resolveRunModel({
    wanted,
    guruFallbackModel: guru?.fallbackModel,
    localModels: ctx.config.localModels,
    defaultCloudModel: ctx.config.defaultCloudModel,
    laptopOnline: await ctx.laptopProbe.isOnline(),
  });
  await ctx.store.runs.update(run.id, { modelFallback: resolved.fallback, updatedAt: new Date().toISOString() });
  await ctx.agentLink.send(run.id, { t: "rpc", command: setModelCommand(resolved.model) });
  return {
    modelOverride: model,
    model: resolved.model,
    applied: "live",
    ...(resolved.fallback ? { modelFallback: resolved.fallback } : {}),
  };
}
