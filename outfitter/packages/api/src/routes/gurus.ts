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
// the pre-existing mgm connect extension (mgm/.pi/extensions/connect) has the same
// LITELLM_BASE_URL-to-Bearer-key exposure pattern, but it isn't guru-configurable, so it isn't a
// vector through this route -- flagged for awareness, not fixed here.
const DENYLISTED_GURU_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_AGENT_KEY",
]);

function denylistedGuruEnvKeys(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).filter((key) => DENYLISTED_GURU_ENV_KEYS.has(key) || key.startsWith("GIT_"));
}

export async function registerGuruRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/gurus", async () => ctx.store.gurus.list());

  app.post("/api/gurus", async (req, reply) => {
    const body = req.body as GuruInput;
    if (!body?.name || !body?.model) return reply.code(400).send({ error: "name and model are required" });
    const denied = denylistedGuruEnvKeys(body.env);
    if (denied.length > 0) {
      return reply.code(400).send({ error: `guru.env may not set: ${denied.join(", ")}` });
    }
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
    const updated = await ctx.store.gurus.update(id, { ...body, updatedAt: new Date().toISOString() });
    if (!updated) return reply.code(404).send({ error: "guru not found" });
    return updated;
  });
}
