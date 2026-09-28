import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { getSessionOr404 } from "./sessions.ts";
import { AFTER_SPEAKING, DEFAULT_VOICE_PREFS, VOICE_ENGINES, isTtsVoice, voiceTag, type AfterSpeaking, type VoiceEngine, type VoicePrefs } from "../voice.ts";
import { requireOperator } from "../auth.ts";

/** How long a token request waits on Deepgram's usage for the cap check before minting anyway. */
const CAP_CHECK_MS = 1_500;

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

  // Any of the preferences; the rest stay as they are.
  app.put("/api/me/voice", async (req, reply) => {
    const body = (req.body ?? {}) as { afterSpeaking?: unknown; ttsVoice?: unknown; handsFree?: unknown };
    if (body.afterSpeaking !== undefined && !(AFTER_SPEAKING as readonly unknown[]).includes(body.afterSpeaking)) {
      return reply.code(400).send({ error: `afterSpeaking must be one of ${AFTER_SPEAKING.join(", ")}` });
    }
    if (body.ttsVoice !== undefined && !isTtsVoice(body.ttsVoice)) {
      return reply.code(400).send({ error: "ttsVoice must be a Deepgram Aura voice id, e.g. aura-2-hermes-en" });
    }
    if (body.handsFree !== undefined && typeof body.handsFree !== "boolean") {
      return reply.code(400).send({ error: "handsFree must be true or false" });
    }
    if (body.afterSpeaking === undefined && body.ttsVoice === undefined && body.handsFree === undefined) {
      return reply.code(400).send({ error: "nothing to change: afterSpeaking, ttsVoice or handsFree" });
    }
    const email = req.identity!.email;
    const current = { ...DEFAULT_VOICE_PREFS, ...(await ctx.store.users.findByEmail(email))?.voice };
    const next: VoicePrefs = {
      afterSpeaking: (body.afterSpeaking as AfterSpeaking | undefined) ?? current.afterSpeaking,
      ttsVoice: (body.ttsVoice as string | undefined) ?? current.ttsVoice,
      handsFree: (body.handsFree as boolean | undefined) ?? current.handsFree,
    };
    const user = await ctx.store.users.setVoicePrefs(email, next);
    return { prefs: { ...DEFAULT_VOICE_PREFS, ...user.voice } };
  });

  // Any signed-in identity, including the live tests' service account (#219): the suite may exercise
  // this route, and what it can spend is bounded by the short-lived token (default 30 s), the rate
  // limit and its own tag.
  app.post("/api/voice/token", async (req, reply) => {
    const email = req.identity!.email;
    reply.header("cache-control", "no-store");
    // #257's optional cap, checked when a stream starts (a soft cap: an open stream runs on). If
    // Deepgram's usage can't be read quickly, voice carries on: a usage outage mustn't take the mic
    // away, or make every press wait out a hanging request.
    const cap = ctx.config.voiceMonthlyCapUsd;
    if (cap > 0 && ctx.voice.enabled && ctx.voiceUsage.enabled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const spend = await Promise.race([
          ctx.voiceUsage.forUser(email),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`usage read took over ${CAP_CHECK_MS} ms`)), CAP_CHECK_MS);
          }),
        ]);
        // In cents, as shown: "$5.00 of $5.00" must mean refused.
        if (Math.round(spend.month.usd * 100) >= Math.round(cap * 100)) {
          return reply.code(403).send({ error: "voice_cap_reached", capUsd: cap, monthUsd: spend.month.usd });
        }
      } catch (err) {
        req.log.warn({ email, err: err instanceof Error ? err.message : String(err) }, "voice cap check skipped: usage unreadable");
      } finally {
        clearTimeout(timer);
      }
    }
    const result = await ctx.voice.mint(email);
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

  // Per-floppy voice settings: the engine (owner decision on #251: Deepgram by default, or the
  // browser's own), which the mic and spoken replies both use, and whether replies are read aloud
  // (#255, off by default). Open to anyone who can open the session, like sending it a message.
  app.put("/api/sessions/:id/voice", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = (req.body ?? {}) as { engine?: unknown; speak?: unknown };
    if (body.engine !== undefined && !(VOICE_ENGINES as readonly unknown[]).includes(body.engine)) {
      return reply.code(400).send({ error: `engine must be one of ${VOICE_ENGINES.join(", ")}` });
    }
    if (body.speak !== undefined && typeof body.speak !== "boolean") {
      return reply.code(400).send({ error: "speak must be true or false" });
    }
    if (body.engine === undefined && body.speak === undefined) return reply.code(400).send({ error: "nothing to change: engine or speak" });
    const patch = {
      ...(body.engine !== undefined ? { voiceEngine: body.engine as VoiceEngine } : {}),
      ...(body.speak !== undefined ? { voiceSpeak: body.speak as boolean } : {}),
    };
    const updated = await ctx.store.sessions.update(session.id, patch);
    if (!updated) return reply.code(404).send({ error: "session not found" });
    return { voiceEngine: updated.voiceEngine ?? "deepgram", voiceSpeak: updated.voiceSpeak ?? false };
  });

  // #257: the caller's own Deepgram spend, today, this ISO week and this calendar month (UTC days,
  // as Deepgram buckets them). Built-in speech is free and isn't here.
  app.get("/api/me/voice/spend", async (req, reply) => {
    if (!ctx.voiceUsage.enabled) return { available: false };
    try {
      const spend = await ctx.voiceUsage.forUser(req.identity!.email);
      return {
        available: true,
        currency: "USD",
        ...spend,
        rates: ctx.voiceUsage.rates,
        ...(ctx.config.voiceMonthlyCapUsd > 0 ? { capUsd: ctx.config.voiceMonthlyCapUsd } : {}),
      };
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "voice spend unreadable");
      return reply.code(502).send({ error: "voice_usage_upstream" });
    }
  });

  // #257: sysops' view of the month: each person's spend, and the untagged use (the laptop, whose
  // pi-listen shares the Deepgram project) that can't be put on anyone.
  app.get("/api/operator/voice/spend", { preHandler: requireOperator }, async (req, reply) => {
    if (!ctx.voiceUsage.enabled) return { available: false };
    const users = await ctx.store.users.list();
    const byTag = new Map(users.map((u) => [voiceTag(u.email), u.email]));
    try {
      const project = await ctx.voiceUsage.forProject((tag) => byTag.get(tag));
      return { available: true, currency: "USD", ...project, rates: ctx.voiceUsage.rates };
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "voice project spend unreadable");
      return reply.code(502).send({ error: "voice_usage_upstream" });
    }
  });
}
