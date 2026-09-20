import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Environment } from "../store/types.ts";

type EnvironmentInput = Omit<Environment, "id" | "createdAt" | "updatedAt"> & { id?: string };

export async function registerEnvironmentRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/environments", async () => ctx.store.environments.list());

  app.post("/api/environments", async (req, reply) => {
    const body = req.body as EnvironmentInput;
    if (!body?.name) return reply.code(400).send({ error: "name is required" });
    const now = new Date().toISOString();
    const environment: Environment = { ...body, id: body.id ?? randomUUID(), createdAt: now, updatedAt: now };
    await ctx.store.environments.insert(environment);
    return reply.code(201).send(environment);
  });

  app.put("/api/environments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<EnvironmentInput>;
    const updated = await ctx.store.environments.update(id, { ...body, updatedAt: new Date().toISOString() });
    if (!updated) return reply.code(404).send({ error: "environment not found" });
    return updated;
  });
}
