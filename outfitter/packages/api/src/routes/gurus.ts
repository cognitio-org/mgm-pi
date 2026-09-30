import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import {
  THINKING_LEVELS,
  createGuru,
  deleteGuru,
  envDenylist,
  updateGuru,
  type GuruInput,
  type GuruWriter,
} from "../gurus-service.ts";

// Validation and the write rules live in gurus-service.ts, shared with the admin op registry.
export {
  DENYLISTED_GURU_ENV_KEYS,
  DENYLISTED_GURU_ENV_PREFIXES,
  THINKING_LEVELS,
  isValidModelRef,
  isValidThinkingLevel,
} from "../gurus-service.ts";

/** A person in the web UI (IAP or dev mode) is a human writer; a Dongle caller is an agent. */
function writerOf(req: FastifyRequest): GuruWriter {
  const identity = req.identity;
  if (!identity || identity.viaToken) return { kind: "agent" };
  return { kind: "human", operator: identity.operator };
}

export async function registerGuruRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/gurus", async () => ctx.store.gurus.list());

  // E3.7: the Gurus page's form shows the env denylist next to its env key/value rows, so a guru
  // author sees the restriction before saving rather than only from the 400 after. A dedicated
  // route (rather than folding this into GET /api/models, which is model data, not guru-form data)
  // keeps each response scoped to one concern; this one has room to grow (e.g. future guru-level
  // limits) without models.ts's callers having to ignore fields they don't care about.
  app.get("/api/gurus/meta", async () => ({
    envDenylist: envDenylist(),
    thinkingLevels: THINKING_LEVELS,
  }));

  app.post("/api/gurus", async (req, reply) => {
    const result = await createGuru(ctx.store, req.body as GuruInput, writerOf(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send(result.guru);
  });

  app.put("/api/gurus/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await updateGuru(ctx.store, id, (req.body ?? {}) as Partial<GuruInput>, writerOf(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.guru;
  });

  app.delete("/api/gurus/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await deleteGuru(ctx.store, id, writerOf(req));
    if (!result.ok) {
      const payload = result.count === undefined ? { error: result.error } : { error: result.error, count: result.count };
      return reply.code(result.status).send(payload);
    }
    return reply.code(204).send();
  });
}
