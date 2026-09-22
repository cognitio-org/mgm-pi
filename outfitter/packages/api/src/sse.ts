// Tiny SSE helper: one hub of per-session subscriber lists, written to directly (no framework
// dependency beyond Fastify's raw response). See protocol.md "browser <-> api": GET
// /api/sessions/:id/stream sends `status` on connect, then live entry|event|status|spend|checkpoint.

import type { FastifyReply } from "fastify";
import type { Store } from "./store/types.ts";

export type SseEventType = "entry" | "event" | "status" | "spend" | "checkpoint";

export interface SseEvent {
  type: SseEventType;
  data: unknown;
}

function formatFrame({ type, data }: SseEvent): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseHub {
  private readonly subscribers = new Map<string, Set<FastifyReply>>();

  /** Starts the SSE response and registers it for the channel until the client disconnects. */
  subscribe(channel: string, reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Fastify buffers the response by default; flush headers immediately so the browser sees the
    // stream open right away instead of after the first event.
    reply.raw.flushHeaders?.();

    let set = this.subscribers.get(channel);
    if (!set) {
      set = new Set();
      this.subscribers.set(channel, set);
    }
    set.add(reply);

    reply.raw.on("close", () => {
      set?.delete(reply);
      if (set && set.size === 0) this.subscribers.delete(channel);
    });
  }

  publish(channel: string, event: SseEvent): void {
    const set = this.subscribers.get(channel);
    if (!set || set.size === 0) return;
    const frame = formatFrame(event);
    for (const reply of set) reply.raw.write(frame);
  }

  subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }
}

/** Bug 2 (docs/reports/cloud-fixes.md): AgentLink.publish (agentlink.ts) writes straight into an
 * SseHub instance, which is a plain in-process Map -- fine for role "all" (one process), but in a
 * split deployment the agentd WebSocket lives on the "link" role's process while browsers
 * subscribe to SSE on the "web" role's process (docs/protocol.md "Two origins"). Those are two
 * separate Cloud Run services/containers, so a publish on one process's hub is never seen by
 * subscribers on the other -- the observed bug (a run went provisioning -> idle -> running and
 * answered, but the session page kept showing STOPPED with no new entries until reload).
 *
 * Fix: poll the store instead of relying on the in-process push for anything that crosses roles.
 * Both roles already write every durable fact into the one shared Atlas store (entries, Run.state,
 * Run.costEstimate, Run.pendingUiRequest) -- see docs/protocol.md's up-frame table, all of which
 * are persisted except the raw `event` frame (only extension_ui_request survives, onto
 * Run.pendingUiRequest, by design). So a short poll against the store can reconstruct everything
 * the browser needs except live intra-turn `event` deltas (message_update, tool_execution_*),
 * which stay best-effort/in-process-only -- an accepted tradeoff, since those are marked
 * explicitly "not persisted" in the protocol and the reported bug is about status/entries going
 * stale, not about losing token-by-token streaming.
 *
 * Why polling and not a Mongo change stream: change streams need a replica set (Atlas M0 is one,
 * so they'd technically work), but they hold a permanent server-side cursor per watcher and need
 * their own reconnect/resume-token handling -- real operational surface for a fleet UI likely to
 * have at most a handful of concurrent sessions open at once. A plain poll on a single shared
 * timer, gated to only the sessions someone is actually watching, is a few dozen lines, needs no
 * new dependency, and degrades to "the browser sees an update up to intervalMs late" instead of
 * "the watcher silently stops" as its failure mode. Runs at 1.5s by default: cheap enough on M0
 * for this fleet's scale, fast enough that it reads as "live" to a person watching the page. This
 * also transparently keeps working for role "all" (single process): the poller and the existing
 * AgentLink push both fire, the browser just dedupes (mergeEntries by id, spend/status are
 * idempotent overwrites). */
export class SsePoller {
  private readonly cursors = new Map<
    string,
    {
      lastEntryId?: string;
      lastState?: string;
      lastCostEstimate?: number;
      lastUiRequestKey?: string;
      lastStatusDetail?: string;
    }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private readonly hub: SseHub;
  private readonly store: Pick<Store, "entries" | "runs">;
  private readonly intervalMs: number;

  constructor(hub: SseHub, store: Pick<Store, "entries" | "runs">, intervalMs = 1500) {
    this.hub = hub;
    this.store = store;
    this.intervalMs = intervalMs;
  }

  /** Starts (or confirms) polling for a session that just gained a subscriber. Idempotent. */
  watch(sessionId: string): void {
    if (!this.cursors.has(sessionId)) this.cursors.set(sessionId, {});
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.pollAll().catch(() => {});
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** Called after a subscriber disconnects; drops the session once nobody is left watching it, so
   * the poll loop's work scales with open browser tabs, not with every session that ever existed. */
  unwatch(sessionId: string): void {
    if (this.hub.subscriberCount(sessionId) === 0) this.cursors.delete(sessionId);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollAll(): Promise<void> {
    for (const sessionId of [...this.cursors.keys()]) {
      if (this.hub.subscriberCount(sessionId) === 0) {
        this.cursors.delete(sessionId);
        continue;
      }
      await this.pollOne(sessionId);
    }
  }

  async pollOne(sessionId: string): Promise<void> {
    const cursor = this.cursors.get(sessionId) ?? {};

    const entries = await this.store.entries.listForSession(sessionId, cursor.lastEntryId);
    for (const e of entries) {
      this.hub.publish(sessionId, { type: "entry", data: e.entry });
      cursor.lastEntryId = e.entry.id;
    }

    const run = await this.store.runs.findActiveForSession(sessionId);
    // Bug 3 (docs/reports/cloud-fixes.md): no *active* run doesn't mean "stopped" -- it could be
    // "failed" too, and the two must read differently in the UI. Fall back to the most recent run
    // (of any state) so a transition into "failed" is actually observed, not flattened to "stopped".
    const terminal = run ?? (await this.store.runs.findLatestForSession(sessionId));
    const state = terminal?.state ?? "stopped";
    const detail = terminal?.statusDetail;
    if (state !== cursor.lastState || (detail !== undefined && detail !== cursor.lastStatusDetail)) {
      this.hub.publish(sessionId, {
        type: "status",
        data: { t: "status", state, reason: run ? undefined : terminal?.reason, detail },
      });
      cursor.lastState = state;
      if (detail !== undefined) cursor.lastStatusDetail = detail;
    }
    if (run && typeof run.costEstimate === "number" && run.costEstimate !== cursor.lastCostEstimate) {
      this.hub.publish(sessionId, { type: "spend", data: { t: "spend", estimate: run.costEstimate } });
      cursor.lastCostEstimate = run.costEstimate;
    }
    const uiKey = run?.pendingUiRequest ? JSON.stringify(run.pendingUiRequest) : undefined;
    if (uiKey && uiKey !== cursor.lastUiRequestKey) {
      this.hub.publish(sessionId, { type: "event", data: run?.pendingUiRequest });
      cursor.lastUiRequestKey = uiKey;
    }
    if (!uiKey) cursor.lastUiRequestKey = undefined;

    this.cursors.set(sessionId, cursor);
  }
}
