// E9 §4 cost: an Agent Engine session holds its sandbox pair until `agent_idle_ttl_seconds` (default
// 600) unless it is stopped, and runtime is billed per vCPU-second. So when an Outfitter session
// closes -- no active run, archived, or formatted -- the api stops each Agent Engine session it
// opened (aeSessions, written by ae.invoke): POST …/workspaces/{w}/runtime-sessions/{id}/stop.
//
// Best effort. Whether a service-account token may call that route is UNVERIFIED (spec §4); if it
// can't (401/403), or the route isn't there, the row is marked stopped with the error and the idle
// TTL applies. Network and server errors are retried on later ticks, at most MAX_STOP_ATTEMPTS.
//
// The tick (routes/hooks.ts) sweeps; archive and format stop a session's rows at once.

import type { AgentsService } from "./agentengine/index.ts";
import { AgentEngineError } from "./agentengine/index.ts";
import type { AeSession, Store } from "./store/types.ts";

/** A row used this recently is left alone: its invoke may still be streaming on a run that is
 * just ending. */
const GRACE_MS = 2 * 60_000;
const MAX_STOP_ATTEMPTS = 3;
const STOP_TIMEOUT_MS = 10_000;
const SWEEP_LIMIT = 500;
/** E9.10: a laptop's Agent Engine session (keyed `laptop:…`, admin/ae-ops.ts aeSessionKey) has no
 * Outfitter session or run to close: it counts as closed once unused this long. Kernal also stops
 * it itself (`ae.close`) when the laptop session ends. */
const LAPTOP_IDLE_MS = 15 * 60_000;

export interface AeSessionsDeps {
  store: Store;
  /** Undefined while the agents project is off: there is nothing to stop. */
  agents?: AgentsService;
  log?: (message: string) => void;
  now?: () => number;
  graceMs?: number;
}

export interface AeSweepResult {
  stopped: number;
  failed: number;
}

export class AeSessions {
  private readonly deps: AeSessionsDeps;

  constructor(deps: AeSessionsDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Stops the open rows whose Outfitter session has closed. Undefined when the feature is off or
   * there was nothing to do. */
  async sweep(): Promise<AeSweepResult | undefined> {
    if (!this.deps.agents) return undefined;
    const grace = this.deps.graceMs ?? GRACE_MS;
    const rows = await this.deps.store.aeSessions.listOpen(SWEEP_LIMIT, new Date(this.now() - grace).toISOString());
    const out: AeSweepResult = { stopped: 0, failed: 0 };
    const open = new Map<string, boolean>();
    for (const row of rows) {
      const laptop = row.outfitterSessionId.startsWith("laptop:");
      let isOpen = laptop ? Date.parse(row.lastUsedAt) > this.now() - LAPTOP_IDLE_MS : open.get(row.outfitterSessionId);
      if (isOpen === undefined) {
        isOpen = await this.sessionOpen(row.outfitterSessionId);
        open.set(row.outfitterSessionId, isOpen);
      }
      if (isOpen) continue;
      if (await this.stop(row)) out.stopped++;
      else out.failed++;
      // A laptop's rows stay (stopped) so its executions remain reachable with get; the next
      // invoke reopens them.
      if (laptop) continue;
      // A formatted session's rows go once nothing is left to stop (forgetSession).
      if (!(await this.deps.store.sessions.findById(row.outfitterSessionId)) && !(await this.deps.store.aeSessions.listOpenForSession(row.outfitterSessionId)).length) {
        await this.deps.store.aeSessions.deleteForSession(row.outfitterSessionId);
      }
    }
    return out.stopped || out.failed ? out : undefined;
  }

  /** Stops every open row of one Outfitter session now (archive). A no-op where the agents project
   * isn't configured (the web role holds no credentials): the link role's tick sweeps instead. */
  async closeSession(outfitterSessionId: string): Promise<void> {
    if (!this.deps.agents) return;
    for (const row of await this.deps.store.aeSessions.listOpenForSession(outfitterSessionId)) await this.stop(row);
  }

  /** #208 format: removes the session's rows once nothing is left to stop. Open rows stay where
   * this instance can't stop them, for the link role's sweep, which removes them after. */
  async forgetSession(outfitterSessionId: string): Promise<void> {
    await this.closeSession(outfitterSessionId);
    if ((await this.deps.store.aeSessions.listOpenForSession(outfitterSessionId)).length === 0) {
      await this.deps.store.aeSessions.deleteForSession(outfitterSessionId);
    }
  }

  /** Open: the session exists, isn't archived, and has an active run. */
  private async sessionOpen(sessionId: string): Promise<boolean> {
    const session = await this.deps.store.sessions.findById(sessionId);
    if (!session || session.archivedAt) return false;
    return !!(await this.deps.store.runs.findActiveForSession(sessionId));
  }

  /** True when the row is done with (stopped, gone, or given up on). */
  private async stop(row: AeSession): Promise<boolean> {
    const { store, agents, log } = this.deps;
    const iso = new Date(this.now()).toISOString();
    try {
      await agents!.stopRuntimeSession(row.workspaceId, row.aeSessionId, { signal: AbortSignal.timeout(STOP_TIMEOUT_MS) });
      await store.aeSessions.markStopped(row.id, row.lastUsedAt, iso);
      return true;
    } catch (err) {
      const kind = err instanceof AgentEngineError ? err.kind : undefined;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      // Already released (idle TTL, or never created): nothing to stop.
      if (kind === "not_found") {
        await store.aeSessions.markStopped(row.id, row.lastUsedAt, iso, "not found");
        return true;
      }
      // Refused: the service account may not be allowed this route (unverified). The idle TTL
      // releases the session; asking again would be refused again.
      if (kind === "auth" || kind === "bad_request" || kind === "off") {
        log?.(`Agent Engine session ${row.aeSessionId} not stopped (${message}); its idle TTL releases it`);
        await store.aeSessions.markStopped(row.id, row.lastUsedAt, iso, message);
        return false;
      }
      const attempts = await store.aeSessions.recordStopFailure(row.id, row.lastUsedAt, message);
      if (attempts !== null && attempts >= MAX_STOP_ATTEMPTS) {
        log?.(`Agent Engine session ${row.aeSessionId} not stopped after ${attempts} tries (${message}); its idle TTL releases it`);
        await store.aeSessions.markStopped(row.id, row.lastUsedAt, iso, message);
      }
      return false;
    }
  }
}
