// E2.8 laptop model preflight (EPIC.md "Laptop model preflight" / "E2.8 Laptop model preflight").
//
// Before a run starts with (or wakes into) a laptop-only model such as `litellm/local-qwen-mlx`,
// the API needs to know whether the laptop's LM Studio is actually reachable through its ngrok
// tunnel right now. LaptopProbe answers that with a direct HTTPS probe of the tunnel, cached for
// `cacheMs` (default 60s) so a burst of run starts doesn't hammer ngrok. `setOnline` lets the
// optional push path (POST /api/hooks/ngrok, routes/hooks.ts) flip the cached value instantly
// instead of waiting out the cache window.

import { hostStatus, sharedModels, type LocalHost, type LocalHostsCollection } from "./store/local-hosts.ts";
import { parseRouterModelName } from "./local-hosts/naming.ts";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_MS = 60_000;

export interface LaptopProbeConfig {
  /** Domain the laptop's LM Studio is tunneled on, e.g. kernal-lmstudio.ngrok.app (no scheme). */
  tunnelDomain: string;
  /** Bearer token tunnel.sh's traffic policy requires. */
  token: string;
  /** Probe request timeout in ms. Default 3000 per EPIC.md E2.8. */
  timeoutMs?: number;
  /** How long a probe result (or a setOnline call) is trusted before probing again. Default 60000. */
  cacheMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** #382 (docs/specs/local-host.md §1.8): the host registry, for `local/<prefix>/<model>` names
   * (isOnlineFor). */
  localHosts?: LocalHostsCollection;
}

export class LaptopProbe {
  private readonly tunnelDomain: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly fetchImpl: typeof fetch;
  private cachedOnline: boolean | undefined;
  private cachedAt: number | undefined;
  private readonly localHosts: LocalHostsCollection | undefined;
  /** Host records by router prefix (null: no such host), each trusted for `cacheMs`. */
  private readonly hostCache = new Map<string, { at: number; host: LocalHost | null }>();

  constructor(config: LaptopProbeConfig) {
    this.tunnelDomain = config.tunnelDomain;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheMs = config.cacheMs ?? DEFAULT_CACHE_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.localHosts = config.localHosts;
  }

  /**
   * Whether `model` can be served right now. A Local Host router name (`local/<prefix>/<id>`, with
   * or without Kernal's `litellm/`) is online when its host is online and the model is on the
   * server the host's tunnel forwards to (local-host.md §1.8). The record is cached `cacheMs` per
   * prefix; the status is worked out on each call. Any other name is the legacy tunnel's isOnline().
   */
  async isOnlineFor(model: string): Promise<boolean> {
    const parsed = parseRouterModelName(model);
    if (!parsed) return this.isOnline();
    if (!this.localHosts) return false;
    const now = Date.now();
    let entry = this.hostCache.get(parsed.routerPrefix);
    if (!entry || now - entry.at >= this.cacheMs) {
      try {
        entry = { at: now, host: await this.localHosts.findByRouterPrefix(parsed.routerPrefix) };
      } catch {
        return false;
      }
      this.hostCache.set(parsed.routerPrefix, entry);
    }
    const host = entry.host;
    if (!host || hostStatus(host, new Date(now)) !== "online") return false;
    return sharedModels(host).some((m) => m.id === parsed.modelId);
  }

  /**
   * Whether the laptop's LM Studio is reachable right now. Cached for `cacheMs`; a cache hit does
   * no network I/O at all. GETs `/v1/models` on the tunnel: ngrok answers with its own offline
   * error page when the laptop agent is down, LM Studio answers with the model list when up, so
   * this one probe covers both failure modes (protocol.md / EPIC.md E2.8).
   */
  async isOnline(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedAt !== undefined && now - this.cachedAt < this.cacheMs) {
      return this.cachedOnline ?? false;
    }
    const online = await this.probe();
    this.cachedOnline = online;
    this.cachedAt = now;
    return online;
  }

  /** Forces the cached state, e.g. from the ngrok webhook (routes/hooks.ts). Resets the cache window. */
  setOnline(online: boolean): void {
    this.cachedOnline = online;
    this.cachedAt = Date.now();
  }

  private async probe(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`https://${this.tunnelDomain}/v1/models`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      // network error, non-2xx thrown by a fetch polyfill, or the abort from the timeout
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ResolveRunModelInput {
  /** The guru's own model, or the session's modelOverride if it has one. */
  wanted: string;
  /** The guru's configured fallback, if any. */
  guruFallbackModel?: string;
  /** Config.localModels: model ids that require the laptop preflight. */
  localModels: string[];
  /** Config.defaultCloudModel: used when the guru has no fallbackModel of its own. */
  defaultCloudModel: string;
  /** Result of LaptopProbe.isOnlineFor(wanted) for this decision. */
  laptopOnline: boolean;
}

export interface ResolveRunModelResult {
  /** The model to actually put in run.spec.guru.model. */
  model: string;
  /** Present only when a substitution happened, for Run.modelFallback. */
  fallback?: { wanted: string; used: string };
}

/**
 * Pure decision function behind the E2.8 preflight: substitutes a cloud model for a laptop-only
 * one when the laptop is offline. Kept separate from LaptopProbe so it's testable without async
 * fetch stubbing (see test/laptop.test.ts "fallback substitution").
 */
export function resolveRunModel(input: ResolveRunModelInput): ResolveRunModelResult {
  const { wanted, guruFallbackModel, localModels, defaultCloudModel, laptopOnline } = input;
  // Local Host router names (local-host.md §1.8) are laptop models whether listed or not.
  const local = localModels.includes(wanted) || parseRouterModelName(wanted) !== undefined;
  if (!local || laptopOnline) {
    return { model: wanted };
  }
  const used = guruFallbackModel ?? defaultCloudModel;
  return { model: used, fallback: { wanted, used } };
}
