// Local Host router reconciliation (epic #378, #384; docs/specs/local-host.md §3): every routable
// model on an online, managed host becomes one LiteLLM deployment `local/<routerPrefix>/<modelId>`
// pointing at the host's ngrok cloud endpoint with its bearer. Everything else has none.
//
// The router is the source of truth: each entry carries `model_info.metadata` (`outfitter:
// "local-host"`, `env`, `hostId`, `modelId`, `fingerprint`) and a deterministic `model_info.id`
// (naming.ts routerDeploymentId), so a retry or a second instance finds the entry instead of adding
// another. Nothing is kept in Mongo and `localHosts` is never written here.
//
//   onChange  reconciles one host (desired vs the router's entries whose metadata names it);
//   sweep     reconciles all of them from one /model/info: removes the entries of hosts that went
//             stale (no heartbeat announces that), repairs anything an onChange left half done,
//             and deletes duplicates. Entries without our metadata, or of another env, are never
//             touched.
//
// LiteLLM's model management API (https://docs.litellm.ai/docs/proxy/model_management), called with
// the scoped admin key (LITELLM_ADMIN_KEY; deploy/litellm-admin.sh ALLOWED_ROUTES lists exactly
// these routes and its test greps this file):
//   GET  /model/info     { data: [{ model_name, litellm_params (api_key withheld), model_info }] }
//   POST /model/new      { model_name, litellm_params, model_info }
//   POST /model/update   the same, matched by model_info.id
//   POST /model/delete   { id }
//
// The bearer is read from Secret Manager (managed.bearerSecret) and goes only into the payload's
// `litellm_params.api_key`. No log line, error or count carries it.

import type { Config } from "../config.ts";
import { LITELLM_TIMEOUT_MS, LitellmError } from "../central/litellm-keys.ts";
import type { SecretAdmin } from "../secrets.ts";
import { hostStatus, routerFingerprint, sharedModels, type LocalHost } from "../store/local-hosts.ts";
import type { Store } from "../store/types.ts";
import { LOCAL_HOST_ACCESS_GROUP, type HeartbeatModel, type ServerKind } from "./contract.ts";
import type { LocalHostChange, LocalHostListener } from "./events.ts";
import { routerDeploymentId, routerModelName } from "./naming.ts";

/** `model_info.metadata.outfitter` on every entry this module writes. */
export const ROUTER_METADATA_TAG = "local-host";
/** The deployment's timeouts, as today's hand-made `local-qwen-mlx` (a cold load takes minutes). */
export const LOCAL_MODEL_TIMEOUT_SECONDS = 600;

const KIND_LABEL: Record<ServerKind, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  "mlx-lm": "mlx-lm",
  vllm: "vLLM",
  openai: "an OpenAI-compatible server",
};

/** One router deployment as /model/new takes it (§3.3). */
export interface RouterDeployment {
  model_name: string;
  litellm_params: {
    model: string;
    api_base: string;
    api_key: string;
    timeout: number;
    stream_timeout: number;
    max_retries: number;
    extra_body?: Record<string, unknown>;
  };
  model_info: {
    id: string;
    mode: "chat" | "embedding";
    max_input_tokens?: number;
    supports_vision: boolean;
    supports_function_calling: boolean;
    access_groups: string[];
    description: string;
    metadata: RouterEntryMetadata;
  };
}

export interface RouterEntryMetadata {
  outfitter: typeof ROUTER_METADATA_TAG;
  env: string;
  hostId: string;
  ownerUserId: string;
  modelId: string;
  fingerprint: string;
}

/** An entry as /model/info lists it (only the fields compared here). */
interface RouterEntry {
  model_name?: string;
  litellm_params?: Record<string, unknown>;
  model_info?: { id?: string; metadata?: Record<string, unknown> | null } & Record<string, unknown>;
}

export interface SweepCounts {
  added: number;
  updated: number;
  deleted: number;
  failed: number;
  [k: string]: number;
}

/**
 * Whether the host should have router entries now (§3.2): sharing, not revoked, online, on
 * Outfitter's credentials, with a public URL and a bearer.
 */
export function hostWantsEntries(host: LocalHost, now: Date): boolean {
  return (
    host.shareModels &&
    !host.revokedAt &&
    hostStatus(host, now) === "online" &&
    host.tunnel.managed &&
    !!host.managed?.publicUrl &&
    !!host.managed?.bearerSecret
  );
}

/** The routable models the tunnel reaches, one per id (§3.1, §3.2). Loaded or not. */
export function routableSharedModels(host: LocalHost): HeartbeatModel[] {
  const seen = new Set<string>();
  const out: HeartbeatModel[] = [];
  for (const m of sharedModels(host)) {
    if (seen.has(m.id) || !routerModelName(host.routerPrefix, m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * Thinking off by default, as today's `local-qwen-mlx` deployment does. LiteLLM drops a top-level
 * `reasoning_effort` for an OpenAI-compatible model it doesn't know, so it goes in `extra_body`,
 * which LiteLLM merges into the upstream request as is. `chat_template_kwargs.enable_thinking` is
 * what the Qwen 3 chat templates read (vLLM, llama.cpp's server, mlx-lm and LM Studio pass it to
 * the template); `reasoning_effort: "none"` is what LM Studio and Ollama read. vLLM validates
 * `reasoning_effort` against low/medium/high and llama.cpp and mlx-lm don't know "none", so they
 * get only the template switch. An embedding model gets neither.
 */
export function thinkingOffBody(model: HeartbeatModel): Record<string, unknown> | undefined {
  if (model.type === "embeddings") return undefined;
  const body: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: false } };
  if (model.kind === "lmstudio" || model.kind === "ollama") body.reasoning_effort = "none";
  return body;
}

/** The one-line description people see in model lists (§3.3). */
export function deploymentDescription(host: LocalHost, model: HeartbeatModel): string {
  const state = model.loaded ? "loaded" : "not loaded";
  return (
    `On ${host.hostName} (${host.ownerEmail}), ${KIND_LABEL[model.kind] ?? model.kind}, ${state}. ` +
    "A request to a model that isn't loaded loads it first, which can take minutes."
  );
}

/** The /model/new payload of one model on one host (§3.3). Pure, exported for tests. */
export function buildDeployment(host: LocalHost, model: HeartbeatModel, opts: { env: string; bearer: string; now: Date }): RouterDeployment {
  const name = routerModelName(host.routerPrefix, model.id);
  if (!name) throw new Error("model id not routable");
  const publicUrl = (host.managed?.publicUrl ?? "").replace(/\/+$/, "");
  const extraBody = thinkingOffBody(model);
  return {
    model_name: name,
    litellm_params: {
      model: `openai/${model.id}`,
      api_base: `${publicUrl}/v1`,
      api_key: opts.bearer,
      timeout: LOCAL_MODEL_TIMEOUT_SECONDS,
      stream_timeout: LOCAL_MODEL_TIMEOUT_SECONDS,
      max_retries: 0,
      ...(extraBody ? { extra_body: extraBody } : {}),
    },
    model_info: {
      id: routerDeploymentId(host.id, model.id),
      mode: model.type === "embeddings" ? "embedding" : "chat",
      ...(typeof model.contextLength === "number" && model.contextLength > 0 ? { max_input_tokens: model.contextLength } : {}),
      supports_vision: model.vision === true,
      supports_function_calling: model.toolUse === true,
      access_groups: [LOCAL_HOST_ACCESS_GROUP],
      description: deploymentDescription(host, model),
      metadata: {
        outfitter: ROUTER_METADATA_TAG,
        env: opts.env,
        hostId: host.id,
        ownerUserId: host.userId,
        modelId: model.id,
        fingerprint: routerFingerprint(host, opts.now),
      },
    },
  };
}

/** Whether a listed entry already matches the desired deployment. /model/info withholds api_key,
 * which is covered by the fingerprint (it includes managed.bearerVersion). */
function entryMatches(entry: RouterEntry, want: RouterDeployment): boolean {
  const p = entry.litellm_params ?? {};
  const info = entry.model_info ?? {};
  const meta = info.metadata ?? {};
  const groups = Array.isArray(info.access_groups) ? info.access_groups : [];
  return (
    meta.fingerprint === want.model_info.metadata.fingerprint &&
    entry.model_name === want.model_name &&
    p.model === want.litellm_params.model &&
    p.api_base === want.litellm_params.api_base &&
    p.timeout === want.litellm_params.timeout &&
    p.max_retries === want.litellm_params.max_retries &&
    info.mode === want.model_info.mode &&
    groups.length === 1 &&
    groups[0] === LOCAL_HOST_ACCESS_GROUP
  );
}

/** Anything secret-shaped out of an upstream detail (LiteLLM may echo a key it was given). */
function scrub(detail: string): string {
  return detail
    .replace(/\bsk-[A-Za-z0-9._-]*/g, "sk-…")
    .replace(/\blhb_[A-Za-z0-9_-]*/g, "lhb_…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function errorDetail(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const b = body as { error?: unknown; detail?: unknown; message?: unknown };
  for (const candidate of [b.error, b.detail, b.message]) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const inner = candidate as { message?: unknown; error?: unknown };
      if (typeof inner.message === "string") return inner.message;
      if (typeof inner.error === "string") return inner.error;
    }
  }
  return "";
}

type Fetch = typeof fetch;

export interface LocalHostRouterOptions {
  store: Pick<Store, "localHosts">;
  config: Pick<Config, "litellmBaseUrl" | "litellmAdminKey" | "previewEnv">;
  secretAdmin: Pick<SecretAdmin, "accessLatest">;
  fetch?: Fetch;
  log?: (msg: string, err?: unknown) => void;
  now?: () => Date;
}

/** The bearer cache is dropped when it grows past this (old bearer versions pile up otherwise). */
const BEARER_CACHE_LIMIT = 512;

export class LocalHostRouterSync implements LocalHostListener {
  readonly name = "router";
  private readonly root: string;
  private readonly adminKey: string;
  private readonly env: string;
  private readonly store: Pick<Store, "localHosts">;
  private readonly secretAdmin: Pick<SecretAdmin, "accessLatest">;
  private readonly fetch: Fetch;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly now: () => Date;
  /** One promise chain per host id: an instance never reconciles one host twice at once. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Bumped by each onChange; a sweep skips a host whose generation moved after its /model/info. */
  private readonly generation = new Map<string, number>();
  /** Bearer per `<secret>#<bearerVersion>`, so a sweep doesn't read Secret Manager per host. */
  private readonly bearers = new Map<string, string>();

  constructor(opts: LocalHostRouterOptions) {
    // config.litellmBaseUrl is the OpenAI-style base (…/v1); the management routes sit at the root.
    this.root = opts.config.litellmBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.adminKey = opts.config.litellmAdminKey;
    this.env = opts.config.previewEnv;
    this.store = opts.store;
    this.secretAdmin = opts.secretAdmin;
    this.fetch = opts.fetch ?? fetch;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  // ---------- LocalHostListener ----------

  async onChange(change: LocalHostChange): Promise<void> {
    const id = change.host.id;
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    const counts = zero();
    const errors: string[] = [];
    await this.serial(id, async () => {
      // The stored record, not the one in the event: a later change may already have landed, and a
      // record that is gone wants no entries.
      const host = change.reason === "deleted" || change.reason === "device-revoked" ? null : await this.store.localHosts.findById(id);
      const entries = (await this.listEntries()).filter((e) => e.model_info?.metadata?.hostId === id);
      await this.reconcileHost(id, host, entries, counts, this.now(), errors);
    });
    // events.ts puts "router: " in front of this in the heartbeat's problems.
    if (counts.failed) throw new LitellmError(`${errors[0] ?? "failed"}${counts.failed > 1 ? ` (+${counts.failed - 1} more)` : ""}`);
  }

  async sweep(): Promise<SweepCounts> {
    const now = this.now();
    const counts = zero();
    // Before the list: an onChange that starts after this point may write what the list misses.
    const started = new Map(this.generation);
    const entries = await this.listEntries();
    const byHost = new Map<string, RouterEntry[]>();
    for (const e of entries) {
      const hostId = String(e.model_info?.metadata?.hostId ?? "");
      if (!hostId) continue;
      byHost.set(hostId, [...(byHost.get(hostId) ?? []), e]);
    }
    const hosts = new Map<string, LocalHost>();
    for (const h of await this.store.localHosts.listSharing()) if (hostWantsEntries(h, now)) hosts.set(h.id, h);
    const ids = new Set([...hosts.keys(), ...byHost.keys()]);
    for (const id of ids) {
      await this.serial(id, async () => {
        // An onChange ran for this host after the list was read: its result is newer than ours.
        if ((this.generation.get(id) ?? 0) !== (started.get(id) ?? 0)) return;
        await this.reconcileHost(id, hosts.get(id) ?? null, byHost.get(id) ?? [], counts, now);
      });
    }
    if (this.bearers.size > BEARER_CACHE_LIMIT) this.bearers.clear();
    return counts;
  }

  // ---------- reconciliation ----------

  /** Makes the router's entries for one host match its desired state. Failures are counted (and
   * logged without secrets), never thrown, so one bad entry doesn't stop the rest. */
  private async reconcileHost(
    id: string,
    host: LocalHost | null,
    entries: RouterEntry[],
    counts: SweepCounts,
    now: Date = this.now(),
    errors: string[] = [],
  ): Promise<void> {
    const fail = (what: string, err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      counts.failed++;
      errors.push(text);
      this.log(`local hosts: router could not ${what}`, text);
    };
    const desired = new Map<string, RouterDeployment>();
    if (host && hostWantsEntries(host, now)) {
      const models = routableSharedModels(host);
      if (models.length) {
        let bearer: string;
        try {
          bearer = await this.bearer(host);
        } catch (err) {
          // Leave the existing entries alone: they may still carry a working bearer.
          fail(`read the bearer of ${id}`, err);
          return;
        }
        for (const m of models) {
          const d = buildDeployment(host, m, { env: this.env, bearer, now });
          desired.set(d.model_info.id, d);
        }
      }
    }
    const byId = new Map<string, RouterEntry[]>();
    for (const e of entries) {
      const entryId = String(e.model_info?.id ?? "");
      if (entryId) byId.set(entryId, [...(byId.get(entryId) ?? []), e]);
    }
    // What stays, by id, once extras and duplicates are gone.
    const current = new Map<string, RouterEntry>();
    const restore = new Set<string>();
    for (const [entryId, list] of byId) {
      const wanted = desired.has(entryId);
      if (wanted && list.length === 1) {
        current.set(entryId, list[0]);
        continue;
      }
      // Not desired, or several copies of one id (two instances added it at once). A delete by id
      // removes every copy; a desired one is put back below.
      try {
        await this.deleteEntry(entryId);
        counts.deleted += wanted ? list.length - 1 : list.length;
        if (wanted) restore.add(entryId);
      } catch (err) {
        fail(`delete ${entryId}`, err);
        if (wanted) current.set(entryId, list[0]);
      }
    }
    for (const [entryId, want] of desired) {
      const existing = current.get(entryId);
      try {
        if (!existing) {
          this.expectOk("/model/new", await this.call("POST", "/model/new", { body: want }));
          if (!restore.has(entryId)) counts.added++;
        } else if (!entryMatches(existing, want)) {
          // Same model_info.id: requests already running on it keep going.
          this.expectOk("/model/update", await this.call("POST", "/model/update", { body: want }));
          counts.updated++;
        }
      } catch (err) {
        fail(`write ${entryId}`, err);
      }
    }
  }

  private async bearer(host: LocalHost): Promise<string> {
    const managed = host.managed!;
    const cacheKey = `${managed.bearerSecret}#${managed.bearerVersion}`;
    const cached = this.bearers.get(cacheKey);
    if (cached) return cached;
    const value = (await this.secretAdmin.accessLatest(managed.bearerSecret))?.trim();
    if (!value) throw new Error(`bearer secret ${managed.bearerSecret} has no enabled version`);
    this.bearers.set(cacheKey, value);
    return value;
  }

  /** Our entries on the router: metadata.outfitter "local-host" and this env. */
  private async listEntries(): Promise<RouterEntry[]> {
    const res = await this.call("GET", "/model/info");
    this.expectOk("/model/info", res);
    const body = res.body as { data?: unknown } | unknown[] | undefined;
    const data = (Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : []) as RouterEntry[];
    return data.filter((e) => {
      const meta = e?.model_info?.metadata;
      return !!meta && meta.outfitter === ROUTER_METADATA_TAG && meta.env === this.env;
    });
  }

  private async deleteEntry(entryId: string): Promise<void> {
    const res = await this.call("POST", "/model/delete", { body: { id: entryId } });
    // Already gone counts as deleted.
    if (res.ok || res.status === 404 || /not found|does not exist/i.test(errorDetail(res.body))) return;
    this.expectOk("/model/delete", res);
  }

  private serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tail = next.catch(() => undefined);
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return next;
  }

  // ---------- HTTP ----------

  /** One management call: the status and parsed body; a LitellmError only when nothing came back. */
  private async call(method: "GET" | "POST", path: string, opts: { body?: unknown } = {}): Promise<{ status: number; ok: boolean; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetch(new URL(this.root + path), {
        method,
        headers: {
          authorization: `Bearer ${this.adminKey}`,
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(LITELLM_TIMEOUT_MS),
      });
    } catch (err) {
      this.log(`litellm: ${method} ${path} did not answer`, err instanceof Error ? err.message : String(err));
      throw new LitellmError("LiteLLM did not answer");
    }
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // A proxy in front of LiteLLM may answer HTML; the status still says enough.
    }
    return { status: res.status, ok: res.ok, body };
  }

  private expectOk(path: string, res: { status: number; ok: boolean; body: unknown }): void {
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new LitellmError(`LiteLLM refused the admin key on ${path} (${res.status})`, res.status);
    const detail = scrub(errorDetail(res.body));
    throw new LitellmError(`LiteLLM ${path} answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
}

function zero(): SweepCounts {
  return { added: 0, updated: 0, deleted: 0, failed: 0 };
}

/** B's listener (§5), registered in server.ts only when LITELLM_ADMIN_KEY is set. */
export function localHostRouterListener(opts: LocalHostRouterOptions): LocalHostRouterSync {
  return new LocalHostRouterSync(opts);
}
