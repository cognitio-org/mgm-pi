import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Guru } from "../store/types.ts";

type GuruInput = Omit<Guru, "id" | "createdAt" | "updatedAt"> & { id?: string };

// guru.env is merged into the pi child process's environment verbatim (agentd's guru.ts renderGuru).
// Any domain user can create/edit a guru, so these keys are rejected outright here (finding #6,
// docs/reports/security-review-pr1.md) rather than left to agentd's own denylist to silently drop --
// a 400 tells the guru author immediately instead of a run quietly not getting the env var it
// expected. NODE_OPTIONS/LD_PRELOAD/LD_LIBRARY_PATH can load arbitrary code into pi, PATH can shadow
// git/gh with a malicious binary, GIT_* can hijack agentd's own per-invocation auth-header env vars
// (see agentd/src/git.ts), HOME can redirect where pi/git read config/credentials from.
// LITELLM_BASE_URL/LITELLM_API_KEY/LITELLM_AGENT_KEY (finding #1, docs/reports/security-review-pr15.md):
// outfitter-spend.ts's LiteLLM probes read these straight from process.env with no validation. A
// guru-supplied LITELLM_BASE_URL previously survived into the pi child's env (secretEnv only pinned
// the key, not the base URL) and would have made the sandbox send the *real* per-run LiteLLM key as
// a Bearer token to an attacker-controlled host -- credential exfiltration + SSRF. This denylist is
// the actual fix; run.ts also now pins LITELLM_BASE_URL server-side as belt-and-suspenders. Note:
// the pre-existing kernal connect extension (kernal/.pi/extensions/connect) has the same
// LITELLM_BASE_URL-to-Bearer-key exposure pattern, but it isn't guru-configurable, so it isn't a
// vector through this route -- flagged for awareness, not fixed here.
//
// Exported (E3.7) so GET /api/gurus/meta can echo it to the Gurus page's form, which shows it next
// to the env key/value rows so a guru author sees the restriction before hitting the 400 rather
// than after. GIT_* is a prefix match, not a literal key, so it's listed separately in the meta
// response below instead of pretending it belongs in this Set.
export const DENYLISTED_GURU_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_AGENT_KEY",
  // A user Dongle must not be planted into a Drive. The capture tool does not use one.
  "OUTFITTER_TOKEN",
]);

/** guru.env keys denied by prefix rather than exact match -- see DENYLISTED_GURU_ENV_KEYS' doc. */
export const DENYLISTED_GURU_ENV_PREFIXES = ["GIT_"];

/** The guru whose id is `default` is presumed to exist in most deployments (the fleet's fallback
 * guru for a session with nothing else configured) and can't be deleted through this route --
 * DELETE /api/gurus/default always 400s. There's no seed script creating it yet (a later story),
 * but the id is reserved now so an operator who does create one doesn't have to remember a special
 * rule that only starts mattering once they do. */
const UNDELETABLE_GURU_ID = "default";

/** `provider/id` (pi's --model flag shape, rpc.md): at least one `/`, no whitespace, non-empty
 * segments either side. Deliberately permissive about what's on each side (provider ids and model
 * ids are free-form, and an id itself may contain further `/`s, e.g. openrouter's
 * "anthropic/claude-3-opus") -- this only catches the common mistake of a bare model name with no
 * provider prefix, which pi would otherwise reject deep inside the sandbox instead of at save time. */
const MODEL_REF_PATTERN = /^[^\s/]+\/[^\s]+$/;

export function isValidModelRef(model: string): boolean {
  return MODEL_REF_PATTERN.test(model);
}

/** Thinking levels pi's --model `:thinking` suffix and RPC set_thinking_level accept (pi's own
 * thinking-selector.js LEVEL_DESCRIPTIONS, mirrored here since pi has no --help flag enumerating
 * them and mgm's connect extension only ever maps *into* this set, never validates against it). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(thinking: string): boolean {
  return (THINKING_LEVELS as readonly string[]).includes(thinking);
}

function denylistedGuruEnvKeys(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).filter(
    (key) => DENYLISTED_GURU_ENV_KEYS.has(key) || DENYLISTED_GURU_ENV_PREFIXES.some((p) => key.startsWith(p)),
  );
}

/** Shared POST/PUT validation beyond "name and model are required" (that check stays inline since
 * it differs between create and update). Returns an error message, or undefined if the input is
 * fine. Checks fields only when present, since PUT bodies are partial. */
function validationError(body: {
  model?: string;
  fallbackModel?: string;
  thinking?: string;
  mergeFromCloud?: unknown;
  playwrightBeforeCheckpoint?: unknown;
}): string | undefined {
  if (body.model !== undefined && !isValidModelRef(body.model)) {
    return `model must look like provider/id, got: ${body.model}`;
  }
  if (body.fallbackModel !== undefined && body.fallbackModel !== "" && !isValidModelRef(body.fallbackModel)) {
    return `fallbackModel must look like provider/id, got: ${body.fallbackModel}`;
  }
  if (body.thinking !== undefined && body.thinking !== "" && !isValidThinkingLevel(body.thinking)) {
    return `thinking must be one of: ${THINKING_LEVELS.join(", ")}`;
  }
  if (body.mergeFromCloud !== undefined && typeof body.mergeFromCloud !== "boolean") {
    return "mergeFromCloud must be a boolean";
  }
  // Absent stays absent (existing gurus are off). Only a real boolean is stored; anything else
  // would be easy to mistake for "on" later.
  if (body.playwrightBeforeCheckpoint !== undefined && typeof body.playwrightBeforeCheckpoint !== "boolean") {
    return "playwrightBeforeCheckpoint must be a boolean";
  }
  return undefined;
}

export async function registerGuruRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/gurus", async () => ctx.store.gurus.list());

  // E3.7: the Gurus page's form shows the env denylist next to its env key/value rows, so a guru
  // author sees the restriction before saving rather than only from the 400 after. A dedicated
  // route (rather than folding this into GET /api/models, which is model data, not guru-form data)
  // keeps each response scoped to one concern; this one has room to grow (e.g. future guru-level
  // limits) without models.ts's callers having to ignore fields they don't care about.
  app.get("/api/gurus/meta", async () => ({
    envDenylist: [...DENYLISTED_GURU_ENV_KEYS, ...DENYLISTED_GURU_ENV_PREFIXES.map((p) => `${p}*`)],
    thinkingLevels: THINKING_LEVELS,
  }));

  app.post("/api/gurus", async (req, reply) => {
    const body = req.body as GuruInput;
    if (!body?.name || !body?.model) return reply.code(400).send({ error: "name and model are required" });
    const denied = denylistedGuruEnvKeys(body.env);
    if (denied.length > 0) {
      return reply.code(400).send({ error: `guru.env may not set: ${denied.join(", ")}` });
    }
    const invalid = validationError(body);
    if (invalid) return reply.code(400).send({ error: invalid });
    const now = new Date().toISOString();
    const guru: Guru = { ...body, id: body.id ?? randomUUID(), createdAt: now, updatedAt: now };
    await ctx.store.gurus.insert(guru);
    return reply.code(201).send(guru);
  });

  app.put("/api/gurus/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<GuruInput>;
    const denied = denylistedGuruEnvKeys(body.env);
    if (denied.length > 0) {
      return reply.code(400).send({ error: `guru.env may not set: ${denied.join(", ")}` });
    }
    const invalid = validationError(body);
    if (invalid) return reply.code(400).send({ error: invalid });
    const updated = await ctx.store.gurus.update(id, { ...body, updatedAt: new Date().toISOString() });
    if (!updated) return reply.code(404).send({ error: "guru not found" });
    return updated;
  });

  // E3.7: only deletable when nothing references it. Sessions keep guruId as a plain string (no
  // foreign-key enforcement in the store), so a deleted guru would otherwise silently orphan every
  // session that used it -- routes/sessions.ts resolves guruId to a guru again on every wake
  // (agentlink.ts's buildRunSpec), which would then 404 deep inside a run instead of at delete time.
  app.delete("/api/gurus/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const guru = await ctx.store.gurus.findById(id);
    if (!guru) return reply.code(404).send({ error: "guru not found" });
    if (id === UNDELETABLE_GURU_ID) {
      return reply.code(400).send({ error: "the default guru cannot be deleted" });
    }
    const referencing = await ctx.store.sessions.list({ guruId: id });
    if (referencing.length > 0) {
      return reply.code(409).send({
        error: `guru is referenced by ${referencing.length} session${referencing.length === 1 ? "" : "s"}`,
        count: referencing.length,
      });
    }
    await ctx.store.gurus.delete(id);
    return reply.code(204).send();
  });
}
