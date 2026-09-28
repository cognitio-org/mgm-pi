import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { getSessionOr404 } from "./sessions.ts";
import { AFTER_SPEAKING, DEFAULT_VOICE_PREFS, VOICE_ENGINES, type AfterSpeaking, type VoiceEngine } from "../voice.ts";

/** Web voice (#252, epic #256), "web"/"all" role. The browser streams the mic straight to Deepgram
 * with a token from POST /api/voice/token; the transcript goes out through the ordinary
 * POST /api/sessions/:id/messages, so nothing here touches runs, agentd or pi. */
export async function registerVoiceRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  // What the mic needs to know before it records: whether Deepgram is available here, and the
  // person's own preferences.
  app.get("/api/me/voice", async (req) => {
    const user = await ctx.store.users.findByEmail(req.identity!.email);
    return {
      deepgram: ctx.voice.enabled,
      model: ctx.config.voiceModel,
      language: ctx.config.voiceLanguage,
      prefs: { ...DEFAULT_VOICE_PREFS, ...user?.voice },
    };
  });

  app.put("/api/me/voice", async (req, reply) => {
    const body = (req.body ?? {}) as { afterSpeaking?: unknown };
    if (!(AFTER_SPEAKING as readonly unknown[]).includes(body.afterSpeaking)) {
      return reply.code(400).send({ error: `afterSpeaking must be one of ${AFTER_SPEAKING.join(", ")}` });
    }
    const user = await ctx.store.users.setVoicePrefs(req.identity!.email, { afterSpeaking: body.afterSpeaking as AfterSpeaking });
    return { prefs: { ...DEFAULT_VOICE_PREFS, ...user.voice } };
  });

  // Any signed-in identity, including the live tests' service account (#219): the suite may exercise
  // this route, and what it can spend is bounded by the 30 s token, the rate limit and its own tag.
  app.post("/api/voice/token", async (req, reply) => {
    const email = req.identity!.email;
    const result = await ctx.voice.mint(email);
    reply.header("cache-control", "no-store");
    if (result.ok) {
      req.log.info({ email, expiresAt: result.token.expiresAt }, "voice token minted");
      return result.token;
    }
    switch (result.reason) {
      case "disabled":
        return reply.code(404).send({ error: "voice_disabled" });
      case "rate_limited":
        reply.header("retry-after", String(result.retryAfterSeconds ?? 60));
        return reply.code(429).send({ error: "voice_rate_limited", retryAfterSeconds: result.retryAfterSeconds });
      case "upstream":
        req.log.warn({ email, detail: result.detail }, "voice token mint failed");
        return reply.code(502).send({ error: "voice_upstream" });
    }
  });

  // Per-floppy engine toggle (owner decision on #251): Deepgram by default, or the browser's own.
  // Open to anyone who can open the session, like sending it a message.
  app.put("/api/sessions/:id/voice", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = (req.body ?? {}) as { engine?: unknown };
    if (!(VOICE_ENGINES as readonly unknown[]).includes(body.engine)) {
      return reply.code(400).send({ error: `engine must be one of ${VOICE_ENGINES.join(", ")}` });
    }
    const updated = await ctx.store.sessions.update(session.id, { voiceEngine: body.engine as VoiceEngine });
    if (!updated) return reply.code(404).send({ error: "session not found" });
    return { voiceEngine: updated.voiceEngine ?? "deepgram" };
  });
}
