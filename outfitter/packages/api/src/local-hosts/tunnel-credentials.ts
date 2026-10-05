// Local Host (epic #378, docs/specs/local-host.md §2): per-host tunnel credentials (#383). Owned by
// task A.
//
// The Drive-preview pattern (previews.ts) applied to a laptop: the host gets an ngrok credential
// whose ACL binds only its own internal endpoint `https://lh<hex>.internal`, and only the api, with
// the account's API key, makes the public side: a cloud endpoint `https://lh-<random>.<domain>`
// whose traffic policy rate-limits, checks the per-host bearer, allows only the four inference
// paths, and forwards to that internal endpoint. The laptop can't reach or change that policy.
//
// The bearer lives in Secret Manager (`bearerSecretName`), in the cloud endpoint's policy and in
// the router's deployment; Mongo has only its hash. Nothing here logs it, and no error message
// carries it.

import type { Config } from "../config.ts";
import type { NgrokApi } from "../ngrok-api.ts";
import { ORPHAN_GRACE_MS } from "../previews.ts";
import type { SecretAdmin } from "../secrets.ts";
import type { LocalHost, LocalHostManaged, LocalHostsCollection } from "../store/local-hosts.ts";
import { hostStatus, staleAfterSeconds } from "../store/local-hosts.ts";
import {
  CREDENTIALS_REFETCH_SECONDS,
  ENDPOINT_IDLE_SECONDS,
  LOCAL_HOST_ALLOW_PATHS,
  LOCAL_HOST_PURPOSE,
  LOCAL_HOST_RATE_LIMIT,
  type TunnelCredentialsResponse,
} from "./contract.ts";
import type { LocalHostEvents, LocalHostListener } from "./events.ts";
import { bearerHash, bearerSecretName, credentialAcl, internalUrl, newBearer, newPublicSlug } from "./naming.ts";

/** What the credential, clean-up and sweep code needs; built from the RouteContext or in server.ts. */
export interface LocalHostTunnelDeps {
  store: { localHosts: LocalHostsCollection };
  /** undefined while NGROK_API_KEY is unset. */
  ngrok?: NgrokApi;
  config: Pick<Config, "localHostDomain" | "previewEnv">;
  secretAdmin: SecretAdmin;
  /** The credentials route announces a new public URL or bearer here. */
  events?: LocalHostEvents;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
  now?: () => Date;
}

/** Per-host credentials are provisioned only with both an ngrok client and a domain (§2.1). */
export function provisioningOn(deps: Pick<LocalHostTunnelDeps, "ngrok" | "config">): boolean {
  return Boolean(deps.ngrok && deps.config.localHostDomain);
}

// ---------- traffic policies (§2.4) ----------

/** The only bearer shape spliced into a policy expression (naming.ts newBearer). */
export const BEARER_RE = /^lhb_[A-Za-z0-9_-]{43}$/;
const PATH_RE = /^\/[A-Za-z0-9._\/-]+$/;

const JSON_404 = JSON.stringify({ error: { message: "not found", type: "not_found" } });

function checkBearer(bearer: string): string {
  if (!BEARER_RE.test(bearer)) throw new Error("local host bearer has the wrong shape");
  return bearer;
}

function pathList(): string {
  for (const p of LOCAL_HOST_ALLOW_PATHS) {
    if (!PATH_RE.test(p) || p.includes("..")) throw new Error(`not an allowed path: ${p}`);
  }
  return LOCAL_HOST_ALLOW_PATHS.map((p) => `'${p}'`).join(", ");
}

/** Steps 2 and 3 of §2.4: the bearer, then the path allow-list. Same expression shapes as Kernal's
 * _shared/tunnel/policy.ts, so the internal endpoint and the guard proxy agree with the cloud side. */
function guardRules(bearer: string): unknown[] {
  const token = checkBearer(bearer);
  return [
    {
      expressions: [`!('authorization' in req.headers) || req.headers['authorization'][0] != 'Bearer ${token}'`],
      actions: [{ type: "deny", config: { status_code: 401 } }],
    },
    {
      expressions: [`!(req.url.path in [${pathList()}])`],
      actions: [{ type: "custom-response", config: { status_code: 404, headers: { "content-type": "application/json" }, body: JSON_404 } }],
    },
  ];
}

/** The cloud endpoint's policy: only the api writes it (§2.4). JSON, which is valid YAML. */
export function cloudPolicy(id: string, bearer: string): string {
  return JSON.stringify({
    on_http_request: [
      {
        actions: [{
          type: "rate-limit",
          config: {
            name: "outfitter-local-host",
            algorithm: "sliding_window",
            capacity: LOCAL_HOST_RATE_LIMIT.requests,
            rate: `${LOCAL_HOST_RATE_LIMIT.windowSeconds}s`,
            bucket_key: ["conn.client_ip"],
          },
        }],
      },
      ...guardRules(bearer),
      { actions: [{ type: "forward-internal", config: { url: internalUrl(id) } }] },
    ],
    on_http_response: [
      { actions: [{ type: "add-headers", config: { headers: { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } } }] },
    ],
  });
}

/** The internal endpoint's policy, applied by the laptop's agent: the bearer and paths again, no
 * rate limit (the cloud endpoint did it). */
export function internalPolicy(bearer: string): string {
  return JSON.stringify({ on_http_request: guardRules(bearer) });
}

// ---------- metadata (§2.1) ----------

export function localHostMetadata(config: Pick<Config, "previewEnv">, host: Pick<LocalHost, "id" | "userId">, now: Date): string {
  return JSON.stringify({ purpose: LOCAL_HOST_PURPOSE, env: config.previewEnv, id: host.id, userId: host.userId, createdAt: now.toISOString() });
}

function parseMeta(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : undefined;
  } catch {
    return undefined;
  }
}

/** This deployment's local-host resources only: never a preview's, a hand-made one, or another
 * environment's sharing the ngrok account. */
function ours(config: Pick<Config, "previewEnv">, metadata: string | undefined): boolean {
  const meta = parseMeta(metadata);
  return meta?.purpose === LOCAL_HOST_PURPOSE && meta.env === config.previewEnv;
}

function olderThanGrace(metadata: string | undefined, now: Date): boolean {
  const created = Date.parse(String(parseMeta(metadata)?.createdAt ?? ""));
  return !Number.isFinite(created) || now.getTime() - created > ORPHAN_GRACE_MS;
}

// ---------- issuing (§2.3) ----------

export type TunnelCredentialsErrorCode = "local_host_tunnels_off" | "ngrok_failed";

export class TunnelCredentialsError extends Error {
  readonly code: TunnelCredentialsErrorCode;
  constructor(code: TunnelCredentialsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Short, secret-free text of an ngrok or Secret Manager failure, for logs. */
function errText(err: unknown): string {
  const status = (err as { status?: unknown; response?: { status?: unknown } } | undefined);
  const code = status?.status ?? status?.response?.status;
  // ngrok's policy-validation messages can quote the expression, which holds the bearer.
  const message = (err instanceof Error ? err.message : String(err)).replace(/lhb_[A-Za-z0-9_-]+/g, "lhb_[redacted]");
  return `${code !== undefined ? `${String(code)} ` : ""}${message.split("\n")[0].slice(0, 200)}`;
}

/**
 * Mints the host's tunnel credentials (§2.3). `host` is the caller's own, sharing, not revoked
 * record. Every call mints a new ngrok credential (ngrok shows a token once); the bearer and the
 * cloud endpoint are kept while they're valid, so the router entries don't churn. A failure removes
 * what this call made and throws TunnelCredentialsError("ngrok_failed").
 */
export async function issueTunnelCredentials(deps: LocalHostTunnelDeps, host: LocalHost): Promise<TunnelCredentialsResponse> {
  if (!provisioningOn(deps)) throw new TunnelCredentialsError("local_host_tunnels_off", "per-host tunnels are off");
  const ngrok = deps.ngrok!;
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => {});
  const secretName = bearerSecretName(host.id);
  const previous = host.managed;
  const metadata = localHostMetadata(deps.config, host, now);

  // Undo list: what this call made, removed in reverse if a later step fails.
  const undo: Array<() => Promise<void>> = [];
  const rollback = async () => {
    for (const step of undo.reverse()) await step().catch((err) => log("local hosts: rollback step failed; the sweep retries", { id: host.id, err: errText(err) }));
  };

  try {
    // 1. Bearer: stable across refetches; minted when there is none, or Secret Manager lost it.
    let bearer = previous ? await deps.secretAdmin.accessLatest(previous.bearerSecret) : undefined;
    let bearerVersion = previous?.bearerVersion ?? 0;
    let minted = false;
    if (!bearer || !BEARER_RE.test(bearer)) {
      bearer = newBearer();
      bearerVersion = Math.max(bearerVersion, host.retiredBearerVersion ?? 0) + 1;
      await deps.secretAdmin.addVersion(secretName, bearer);
      minted = true;
      // A rollback must not leave a bearer nobody holds as the latest enabled version.
      undo.push(() => deps.secretAdmin.disableAllEnabled(secretName));
    } else if (bearerHash(bearer) !== previous!.bearerHash) {
      // Someone added a version by hand: it is the bearer now, and the router must hear about it.
      bearerVersion += 1;
      minted = true;
    }

    // 2. Credential: always a new one. The previous one is deleted after the record points at the
    // new one, so a failure here leaves the laptop's current credential working.
    const cred = await ngrok.createCredential({
      description: `outfitter local host ${host.id}`,
      metadata,
      acl: credentialAcl(host.id),
    });
    undo.push(() => ngrok.deleteCredential(cred.id));
    if (!cred.token) throw new Error("ngrok returned no token");

    // 3. Cloud endpoint: kept unless absent or its policy holds an old bearer.
    let endpointId = previous?.endpointId;
    let publicUrl = previous?.publicUrl;
    const replacedEndpoint = minted && endpointId ? endpointId : undefined;
    if (!endpointId || !publicUrl || minted) {
      const url = `https://${newPublicSlug()}.${deps.config.localHostDomain}`;
      const ep = await ngrok.createCloudEndpoint({
        url,
        trafficPolicy: cloudPolicy(host.id, bearer),
        description: `outfitter local host ${host.id}`,
        metadata,
      });
      undo.push(() => ngrok.deleteEndpoint(ep.id));
      endpointId = ep.id;
      publicUrl = ep.url || url;
    }

    // 4. Store, then retire what the new values replaced.
    const managed: LocalHostManaged = {
      credentialId: cred.id,
      credentialIssuedAt: now.toISOString(),
      endpointId,
      publicUrl,
      bearerSecret: secretName,
      bearerVersion,
      bearerHash: bearerHash(bearer),
    };
    const next = await deps.store.localHosts.update(host.id, { managed, retiredBearerVersion: undefined });
    if (!next) throw new Error("the host record is gone");
    undo.length = 0;

    if (previous?.credentialId && previous.credentialId !== cred.id) {
      await ngrok.deleteCredential(previous.credentialId).catch((err) =>
        log("local hosts: deleting the previous credential failed; the sweep retries", { id: host.id, err: errText(err) }));
    }
    if (replacedEndpoint) {
      await ngrok.deleteEndpoint(replacedEndpoint).catch((err) =>
        log("local hosts: deleting the replaced endpoint failed; the sweep retries", { id: host.id, err: errText(err) }));
    }
    if (deps.events && (previous?.publicUrl !== publicUrl || previous?.bearerVersion !== bearerVersion)) {
      const { problems } = await deps.events.changed({ reason: "credentials", host: next, previous: host });
      if (problems.length) log("local hosts: listeners reported problems on new credentials", { id: host.id, problems });
    }

    return {
      provider: "ngrok",
      authtoken: cred.token,
      credentialId: cred.id,
      url: internalUrl(host.id),
      publicUrl: publicUrl!,
      trafficPolicy: internalPolicy(bearer),
      bearer,
      allowPaths: [...LOCAL_HOST_ALLOW_PATHS],
      rateLimit: { ...LOCAL_HOST_RATE_LIMIT },
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CREDENTIALS_REFETCH_SECONDS * 1000).toISOString(),
    };
  } catch (err) {
    log("local hosts: issuing tunnel credentials failed", { id: host.id, err: errText(err) });
    await rollback();
    throw new TunnelCredentialsError("ngrok_failed", "issuing tunnel credentials failed");
  }
}

// ---------- clean-up (§2.5) ----------

/** Deletes the host's cloud endpoint and ngrok credential. Failures are logged, never thrown: the
 * sweep removes whatever no record references. */
export async function deleteHostNgrok(deps: LocalHostTunnelDeps, host: LocalHost): Promise<void> {
  const log = deps.log ?? (() => {});
  if (!deps.ngrok || !host.managed) return;
  const { endpointId, credentialId } = host.managed;
  if (endpointId) {
    await deps.ngrok.deleteEndpoint(endpointId).catch((err) => log("local hosts: deleting a cloud endpoint failed; the sweep retries", { id: host.id, err: errText(err) }));
  }
  await deps.ngrok.deleteCredential(credentialId).catch((err) => log("local hosts: deleting a credential failed; the sweep retries", { id: host.id, err: errText(err) }));
}

/** Deletes only the cloud endpoint (sharing off, idle) and returns the patch that forgets it. The
 * credential stays: it can only bind an internal endpoint nothing forwards to. */
export async function dropCloudEndpoint(deps: LocalHostTunnelDeps, host: LocalHost): Promise<Partial<LocalHost> | undefined> {
  const managed = host.managed;
  if (!managed?.endpointId) return undefined;
  if (deps.ngrok) {
    // Forgotten even when the delete fails: an unreferenced endpoint is an orphan the sweep deletes.
    await deps.ngrok.deleteEndpoint(managed.endpointId).catch((err) =>
      (deps.log ?? (() => {}))("local hosts: deleting a cloud endpoint failed; the sweep retries", { id: host.id, err: errText(err) }));
  }
  const { endpointId: _e, publicUrl: _p, ...rest } = managed;
  return { managed: rest };
}

/** Disables the bearer's Secret Manager versions; logged, never thrown. */
export async function retireBearer(deps: LocalHostTunnelDeps, host: LocalHost): Promise<void> {
  await deps.secretAdmin.disableAllEnabled(host.managed?.bearerSecret ?? bearerSecretName(host.id)).catch((err) =>
    (deps.log ?? (() => {}))("local hosts: disabling the bearer failed", { id: host.id, err: errText(err) }));
}

/** Records the sweep looks at; past this many it skips the orphan pass (an incomplete list would
 * make referenced resources look orphaned). */
export const SWEEP_RECORD_LIMIT = 10_000;

/**
 * The tunnel listener (§2.5): its sweep deletes stale hosts' idle cloud endpoints and the ngrok
 * resources of ours that no record references. Registered in server.ts.
 */
export function localHostTunnelListener(deps: LocalHostTunnelDeps): LocalHostListener {
  return {
    name: "tunnel",
    async sweep(now: Date) {
      const ngrok = deps.ngrok;
      // Nothing to sweep without an ngrok client; no counts, so the tick's answer stays as it was.
      if (!ngrok) return undefined;
      const out = { endpointsIdle: 0, endpointsOrphaned: 0, credentialsOrphaned: 0 };
      const log = deps.log ?? (() => {});
      const hosts = await deps.store.localHosts.listAll(SWEEP_RECORD_LIMIT);
      const idleMs = (staleAfterSeconds() + ENDPOINT_IDLE_SECONDS) * 1000;
      for (const host of hosts) {
        if (!host.managed?.endpointId || hostStatus(host, now) !== "stale") continue;
        if (now.getTime() - Date.parse(host.lastSeenAt) <= idleMs) continue;
        const patch = await dropCloudEndpoint(deps, host);
        if (patch && (await deps.store.localHosts.update(host.id, patch))) {
          host.managed = patch.managed;
          out.endpointsIdle++;
        }
      }
      if (hosts.length >= SWEEP_RECORD_LIMIT) {
        log("local hosts: too many records to sweep ngrok's side safely; skipped", { records: hosts.length });
        return out;
      }
      const endpoints = new Set(hosts.map((h) => h.managed?.endpointId).filter(Boolean));
      const credentials = new Set(hosts.map((h) => h.managed?.credentialId).filter(Boolean));
      try {
        for (const ep of await ngrok.listCloudEndpoints()) {
          if (endpoints.has(ep.id) || !ours(deps.config, ep.metadata) || !olderThanGrace(ep.metadata, now)) continue;
          await ngrok.deleteEndpoint(ep.id);
          out.endpointsOrphaned++;
        }
        for (const cred of await ngrok.listCredentials()) {
          if (credentials.has(cred.id) || !ours(deps.config, cred.metadata) || !olderThanGrace(cred.metadata, now)) continue;
          await ngrok.deleteCredential(cred.id);
          out.credentialsOrphaned++;
        }
      } catch (err) {
        log("local hosts: sweeping ngrok's side failed; the next tick retries", { err: errText(err) });
      }
      return out;
    },
  };
}
