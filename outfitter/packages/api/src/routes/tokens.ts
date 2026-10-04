// Personal API token management (E4.1b): the "web"/"all"-role routes an operator uses (via the web
// UI's Tokens page) to create and revoke tokens for the laptop teleport client. Not registered on
// the "link" role -- managing tokens needs an IAP-identified caller, which that role doesn't have
// (see server.ts's auth preHandler); the link role only *verifies* tokens (src/auth.ts).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import type { ApiToken } from "../store/types.ts";
import { generateToken, hashToken, tokenPrefix, tokenExpiresAt, tokenKind, TOKEN_TTL_MS } from "../tokens.ts";
import { parseA2AKeyScope } from "../a2a/keys.ts";

/** Cap on non-revoked tokens per owner (design decision, E4.1b). */
const MAX_ACTIVE_TOKENS = 10;

/** Never send `hash` to a browser -- it's the only secret-equivalent value we store. `expiresAt`
 * is filled in with tokenExpiresAt's fallback for a token minted before the field existed, and left
 * out if the stored dates don't parse (such a token already fails auth -- see isTokenActive). */
export function publicToken(token: ApiToken): Omit<ApiToken, "hash"> {
  const { hash: _hash, ...rest } = token;
  // E9 §5.2: every token shows its kind; one minted before the field is a Dongle.
  const withKind = { ...rest, kind: tokenKind(token) ?? token.kind };
  const expires = tokenExpiresAt(token);
  if (!Number.isFinite(expires)) return withKind;
  return { ...withKind, expiresAt: new Date(expires).toISOString() };
}

export async function registerTokenRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/me/tokens", async (req) => {
    const email = req.identity!.email;
    const tokens = await ctx.store.tokens.listActiveForOwner(email);
    return tokens.map(publicToken);
  });

  app.post("/api/me/tokens", async (req, reply) => {
    const email = req.identity!.email;
    // #219: a service account reaching the web role through IAP (the live-test identity) never
    // needs a Dongle, and one would outlive the account: link accepts it for 90 days after the
    // account is deleted. Only people get tokens.
    if (email.toLowerCase().endsWith(".gserviceaccount.com")) {
      return reply.code(403).send({ error: "service accounts can't create personal tokens" });
    }
    // #390 Dongle fix 1: a token (a Dongle or a device token) never mints another token of either
    // kind. Otherwise one leaked Dongle could keep renewing itself past its 90 days and past a
    // revoke of the ones it was made from. Only a person in the web app creates tokens.
    if (req.identity?.viaToken) return reply.code(403).send({ error: "tokens are created in the web app" });
    const body = req.body as { name?: string; kind?: unknown; a2a?: unknown };
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "name is required" });
    const kind = body.kind ?? "dongle";
    if (kind !== "dongle" && kind !== "a2a") return reply.code(400).send({ error: 'kind must be "dongle" or "a2a"' });
    let a2a: ApiToken["a2a"];
    if (kind === "a2a") {
      // E9 §5.2: the owner makes A2A keys in the web UI (a token caller was refused above).
      // Each tape needs a LiteLLM key of its own: A2A never runs on the org-wide default.
      const scope = await parseA2AKeyScope(ctx.store, body.a2a, (guruId) => ctx.a2a.litellmKeyProblem(guruId));
      if ("error" in scope) return reply.code(400).send({ error: scope.error });
      a2a = scope;
    } else if (body.a2a !== undefined) {
      return reply.code(400).send({ error: "a2a is only for kind \"a2a\"" });
    }

    // Count-then-insert with no transaction: concurrent creates by the same owner can overshoot the
    // cap (docs/reports/security-review-api-tokens.md #1). The cap is hygiene, not a security
    // boundary -- every extra token is still owner-scoped and revocable -- so best-effort is enough.
    const activeCount = await ctx.store.tokens.countActiveForOwner(email);
    if (activeCount >= MAX_ACTIVE_TOKENS) {
      return reply.code(400).send({ error: `you already have ${MAX_ACTIVE_TOKENS} active tokens -- revoke one before creating another` });
    }

    const plaintext = generateToken();
    const createdMs = Date.now();
    const now = new Date(createdMs).toISOString();
    const record: ApiToken = {
      id: randomUUID(),
      ownerEmail: email,
      name,
      prefix: tokenPrefix(plaintext),
      hash: hashToken(plaintext),
      createdAt: now,
      expiresAt: new Date(createdMs + TOKEN_TTL_MS).toISOString(),
      kind,
      ...(a2a ? { a2a } : {}),
    };
    await ctx.store.tokens.insert(record);
    // The only point the plaintext ever exists outside the client's own memory -- never logged,
    // never re-derivable from the stored hash.
    return reply.code(201).send({ token: plaintext, record: publicToken(record) });
  });

  app.delete("/api/me/tokens/:id", async (req, reply) => {
    const email = req.identity!.email;
    const { id } = req.params as { id: string };
    const existing = await ctx.store.tokens.findById(id);
    // Same 404 whether the token doesn't exist or belongs to someone else -- don't confirm another
    // user's token id exists.
    if (!existing || existing.ownerEmail !== email) return reply.code(404).send({ error: "token not found" });
    const updated = existing.revokedAt ? existing : await ctx.store.tokens.update(id, { revokedAt: new Date().toISOString() });
    // E9 security review: revoking an A2A key stops its work, not just its next request. Its open
    // tasks are canceled and its Drives stopped now; the tick sweep ends whatever this misses. A
    // repeated DELETE of a revoked key runs it again (a retry after a failed first try).
    if (tokenKind(existing) === "a2a") {
      await ctx.a2a.endForKey(id, "canceled", "the A2A key was revoked").catch((err) => {
        req.log.warn({ err }, "a2a: ending a revoked key's tasks failed; the tick sweep will retry");
      });
    }
    return { record: publicToken(updated!) };
  });
}
