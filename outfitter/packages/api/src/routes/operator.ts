// Operator settings routes (EPIC.md Decisions table / operators.md): everything here is gated by
// auth.ts's requireOperator preHandler, on top of the usual IAP-or-token auth preHandler
// (server.ts) that runs first and sets req.identity. Registered on the "web"/"all" role only
// (routes/index.ts), same condition as gurus/environments/tokens -- the "link" role never manages
// secrets.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { parseSentryUpdate, withDefaults } from "../fleet-settings.ts";
import type { Guru } from "../store/types.ts";
import type { SecretKind } from "../operator.ts";
import {
  managedSecretDefs,
  isManagedSecretName,
  managedSecretDef,
  guruLitellmKeySecretName,
  sessionGithubTokenSecretName,
} from "../operator.ts";
import { GITHUB_TOKEN_DEFAULT_SECRET } from "../secrets.ts";
import { requireOperator } from "../auth.ts";
import { fetchJson, failedResponse } from "../providers-status.ts";
import { normalizeOwnerMatch, tokenKind } from "../tokens.ts";
import { publicToken } from "./tokens.ts";

/** Longer than the 3s probes in providers-status.ts: a manual "test this value" click is a rare,
 * deliberate action (not a background poll), so operators.md gives it more room before timing out. */
const TEST_TIMEOUT_MS = 5_000;

interface SecretRow {
  id: string;
  secretName: string;
  label: string;
  purpose: string;
  set: boolean;
  masked?: string;
  updatedAt?: string;
  appliesAt: "next run" | "next deploy";
}

async function secretRow(ctx: RouteContext, gurus: Guru[], secretName: string): Promise<SecretRow> {
  const def = managedSecretDef(secretName, gurus);
  if (!def) throw new Error(`not a managed secret: ${secretName}`);
  const info = await ctx.secretAdmin.info(secretName);
  return {
    id: def.secretName,
    secretName: def.secretName,
    label: def.label,
    purpose: def.purpose,
    set: info.set,
    masked: info.masked,
    updatedAt: info.updatedAt,
    appliesAt: def.appliesAt,
  };
}

/** Extracts a human-readable error string from a provider's JSON error body, trying the field
 * names each provider actually uses; falls back to the raw status. Exported for direct unit
 * testing (routes.operator.test.ts), same pattern as providers-status.ts's exported parsers. */
export function detailFromJson(json: unknown, status: number): string {
  if (json && typeof json === "object") {
    const body = json as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "msg"]) {
      const v = body[key];
      if (typeof v === "string" && v) return v;
      if (v && typeof v === "object") {
        const nested = (v as Record<string, unknown>).message;
        if (typeof nested === "string" && nested) return nested;
      }
    }
  }
  return `HTTP ${status}`;
}

/** Probes `value` against the provider `kind` authenticates, exactly like the corresponding
 * providers-status.ts probe but for an arbitrary (not-yet-saved) value -- see operators.md's
 * per-kind endpoint list. Never throws: network/timeout failures come back as `{ ok: false }`. */
export async function testSecretValue(
  kind: SecretKind,
  value: string,
  litellmBaseUrl: string,
  tunnelDomain: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail?: string }> {
  let url: string;
  let headers: Record<string, string>;
  switch (kind) {
    case "litellm": {
      const root = litellmBaseUrl.replace(/\/v1\/?$/, "");
      url = `${root}/key/info`;
      headers = { Authorization: `Bearer ${value}` };
      break;
    }
    case "github": {
      url = "https://api.github.com/user";
      headers = { Authorization: `Bearer ${value}`, "User-Agent": "outfitter-operator-settings" };
      break;
    }
    case "ngrok": {
      url = "https://api.ngrok.com/endpoints";
      headers = { Authorization: `Bearer ${value}`, "Ngrok-Version": "2" };
      break;
    }
    case "tunnel": {
      if (!tunnelDomain) return { ok: false, detail: "TUNNEL_DOMAIN_LMSTUDIO is not configured" };
      url = `https://${tunnelDomain}/v1/models`;
      headers = { Authorization: `Bearer ${value}` };
      break;
    }
    case "untested":
      return { ok: false, detail: "This secret is not probed." };
  }
  // fetchJson only rejects on a network failure/timeout (a non-2xx response is a resolved,
  // ok: false result) -- catch that here the same way providers-status.ts's own probes do.
  const res = await fetchJson(url, headers, TEST_TIMEOUT_MS, fetchImpl).catch((err) => failedResponse(err, TEST_TIMEOUT_MS));
  if (res.error) return { ok: false, detail: res.error };
  if (!res.ok) return { ok: false, detail: detailFromJson(res.json, res.status) };
  return { ok: true };
}

export async function registerOperatorRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/operator/settings", { preHandler: requireOperator }, async () => {
    const gurus = await ctx.store.gurus.list();
    const defs = managedSecretDefs(gurus);
    const secrets = await Promise.all(defs.map((def) => secretRow(ctx, gurus, def.secretName)));
    return {
      litellmBaseUrl: ctx.config.litellmBaseUrl,
      sandboxProvider: ctx.config.sandboxProvider,
      cloudRunJob: ctx.config.cloudRunJob,
      // GKE fields (gke-sandbox-provider-plan.md §5 item 8): returned whenever set, regardless of
      // sandboxProvider, the same as cloudRunJob above -- an operator switching SANDBOX_PROVIDER
      // still wants to see both providers' settings, not just the currently-active one.
      ...(ctx.config.gkeCluster
        ? {
            gkeCluster: ctx.config.gkeCluster,
            gkeLocation: ctx.config.gkeLocation,
            gkeNamespace: ctx.config.gkeNamespace,
            gkeWarmPool: ctx.config.gkeWarmPool,
            gkeLaunchMode: ctx.config.gkeLaunchMode,
            gkeMaxActive: ctx.config.gkeMaxActive,
          }
        : {}),
      tunnelDomain: ctx.config.tunnelDomainLmstudio,
      operators: ctx.config.operators,
      secrets,
      // Unlike GET /api/fleet-settings, the DSN is shown while Sentry is off too, so the operator
      // can see what turning it back on would send to.
      fleetSettings: withDefaults(await ctx.store.fleetSettings.get()),
    };
  });

  // Fleet settings (fleet-settings.ts): the Telemetry panel's save. Replaces the Sentry section
  // whole; this instance applies it at once, the others within FleetSettingsCache's window, and
  // laptops on their next Kernal start.
  app.put("/api/operator/fleet-settings", { preHandler: requireOperator }, async (req, reply) => {
    const parsed = parseSentryUpdate(req.body, { allowHttp: ctx.config.devMode });
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const settings = {
      ...withDefaults(await ctx.store.fleetSettings.get()),
      telemetry: { sentry: parsed.value },
      updatedAt: new Date().toISOString(),
      updatedBy: req.identity!.email,
    };
    await ctx.store.fleetSettings.put(settings);
    ctx.fleetSettings.set(settings);
    req.log.info({ operator: req.identity!.email, sentryEnabled: parsed.value.enabled, tracesSampleRate: parsed.value.tracesSampleRate }, "operator fleet settings write");
    return settings;
  });

  app.put("/api/operator/secrets/:secretName", { preHandler: requireOperator }, async (req, reply) => {
    const { secretName } = req.params as { secretName: string };
    const gurus = await ctx.store.gurus.list();
    if (!isManagedSecretName(secretName, gurus)) {
      return reply.code(400).send({ error: `unknown managed secret: ${secretName}` });
    }
    const body = req.body as { value?: unknown };
    const raw = typeof body?.value === "string" ? body.value : "";
    const value = raw.trim();
    if (!value) return reply.code(400).send({ error: "value is required" });
    if (/\s/.test(value)) return reply.code(400).send({ error: "value may not contain whitespace" });

    await ctx.secretAdmin.addVersion(secretName, value);
    req.log.info({ operator: req.identity!.email, secretName }, "operator secret write");
    return secretRow(ctx, gurus, secretName);
  });

  app.delete("/api/operator/secrets/:secretName", { preHandler: requireOperator }, async (req, reply) => {
    const { secretName } = req.params as { secretName: string };
    const gurus = await ctx.store.gurus.list();
    if (!isManagedSecretName(secretName, gurus)) {
      return reply.code(400).send({ error: `unknown managed secret: ${secretName}` });
    }

    if (secretName === "outfitter-litellm-key-default") {
      const ownKeys = await Promise.all(
        gurus.map((guru) => ctx.secretAdmin.info(guruLitellmKeySecretName(guru.id))),
      );
      const anyGuruHasOwnKey = ownKeys.some((info) => info.set);
      if (!anyGuruHasOwnKey) {
        return reply.code(409).send({
          error: "no guru has its own LiteLLM key -- disabling the default key would leave every run with none",
        });
      }
    }

    // Count repo sessions rather than warn. The click is rare, so one list plus one info()
    // per repo session is enough, and a warning would let the common case (a repo session
    // with no token of its own) lose every clone. Stricter than the LiteLLM rule above on
    // purpose: one session's own PAT must not permit breaking the rest. Repo-less sessions
    // never receive this fallback (secrets.ts), so they are not counted. A session created
    // between the list and the disable can still miss the token; that race matches the guru check.
    if (secretName === GITHUB_TOKEN_DEFAULT_SECRET) {
      const sessions = await ctx.store.sessions.list();
      const repoSessions = sessions.filter((session) => session.repo);
      const ownTokens = await Promise.all(
        repoSessions.map((session) => ctx.secretAdmin.info(sessionGithubTokenSecretName(session.id))),
      );
      if (ownTokens.some((info) => !info.set)) {
        return reply.code(409).send({
          error:
            "a repo session has no GitHub token of its own -- disabling the shared token would break it",
        });
      }
    }

    await ctx.secretAdmin.disableAllEnabled(secretName);
    req.log.info({ operator: req.identity!.email, secretName }, "operator secret disable");
    return secretRow(ctx, gurus, secretName);
  });

  app.post("/api/operator/secrets/:secretName/test", { preHandler: requireOperator }, async (req, reply) => {
    const { secretName } = req.params as { secretName: string };
    const gurus = await ctx.store.gurus.list();
    const def = managedSecretDef(secretName, gurus);
    if (!def) return reply.code(400).send({ error: `unknown managed secret: ${secretName}` });

    const body = req.body as { value?: unknown } | undefined;
    const explicit = typeof body?.value === "string" ? body.value.trim() : "";
    const value = explicit || (await ctx.secretAdmin.accessLatest(secretName));
    if (!value) return { ok: false, detail: "no value set" };

    return testSecretValue(def.kind, value, ctx.config.litellmBaseUrl, ctx.config.tunnelDomainLmstudio, fetch);
  });

  // Offboarding (deploy/README.md Rollback): removing someone from IAP doesn't touch their outf_
  // tokens, which outfitter-link accepts without IAP. This revokes every active token for one
  // email, or for a whole @domain, in one call. Returns what it revoked (never hashes) so the
  // operator sees exactly whose access just ended.
  app.post("/api/operator/tokens/revoke", { preHandler: requireOperator }, async (req, reply) => {
    const match = normalizeOwnerMatch((req.body ?? {}) as { email?: unknown; domain?: unknown });
    if ("error" in match) return reply.code(400).send({ error: match.error });

    const revoked = await ctx.store.tokens.revokeAllForOwners(match, new Date().toISOString());
    // E9: a revoked A2A key's tasks and Drives stop too (the tick sweep retries a failure).
    for (const token of revoked) {
      if (tokenKind(token) !== "a2a") continue;
      await ctx.a2a.endForKey(token.id, "canceled", "the A2A key was revoked").catch((err) => {
        req.log.warn({ err }, "a2a: ending a revoked key's tasks failed; the tick sweep will retry");
      });
    }
    const owners = [...new Set(revoked.map((t) => t.ownerEmail))].sort();
    req.log.info({ operator: req.identity!.email, match, count: revoked.length, owners }, "operator token revoke");
    return { match, revoked: revoked.map(publicToken), owners };
  });
}
