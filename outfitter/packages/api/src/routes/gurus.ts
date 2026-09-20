import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Guru } from "../store/types.ts";

type GuruInput = Omit<Guru, "id" | "createdAt" | "updatedAt"> & { id?: string };

export async function registerGuruRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/gurus", async () => ctx.store.gurus.list());

  app.post("/api/gurus", async (req, reply) => {
    const body = req.body as GuruInput;
    if (!body?.name || !body?.model) return reply.code(400).send({ error: "name and model are required" });
    const now = new Date().toISOString();
    const guru: Guru = { ...body, id: body.id ?? randomUUID(), createdAt: now, updatedAt: now };
    await ctx.store.gurus.insert(guru);
    return reply.code(201).send(guru);
  });

  app.put("/api/gurus/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<GuruInput>;
    const updated = await ctx.store.gurus.update(id, { ...body, updatedAt: new Date().toISOString() });
    if (!updated) return reply.code(404).send({ error: "guru not found" });
    return updated;
  });
}
