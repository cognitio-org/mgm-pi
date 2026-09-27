// Tiny SSE helper: one hub of per-session subscriber lists, written to directly (no framework
// dependency beyond Fastify's raw response). See protocol.md "browser <-> api": GET
// /api/sessions/:id/stream sends `status` on connect, then live entry|event|status|spend|checkpoint|liveness.

import type { FastifyReply } from "fastify";
import type { Store } from "./store/types.ts";
import { entryForWire } from "./entry-wire.ts";
import { summarizeStartup } from "./startup.ts";

export type SseEventType = "entry" | "event" | "status" | "spend" | "checkpoint" | "liveness";

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

  /** Ends every stream on the channel (#208: its session was formatted). The browser's reconnect
   * then gets a 404, and the poller drops the session once it has no subscribers. */
  close(channel: string): void {
    const set = this.subscribers.get(channel);
    this.subscribers.delete(channel);
    for (const reply of set ?? []) reply.raw.end();
  }

  /** Writes an SSE comment line to every subscriber: keeps idle streams from being cut by a proxy
   * that times out a silent connection (EventSource ignores comments). */
  keepalive(): void {
    for (const set of this.subscribers.values()) for (const reply of set) reply.raw.write(": keepalive\n\n");
  }

  subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }
}

/** Entries fetched per poll. Far more than a session writes in one interval (entries are whole
 * messages/tool results, not token deltas); a bulk import can exceed it, and the overflow is then
 * only seen on the next page load. */
const SSE_RECENT_WINDOW = 100;
/** How often idle SSE streams get a comment line. */
const SSE_KEEPALIVE_MS = 25_000;

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
      /** Ids in the last polled recent-entries window (already published or already known). */
      seenEntryIds?: Set<string>;
      lastState?: string;
      lastCostEstimate?: number;
      lastUiRequestKey?: string;
      lastStatusDetail?: string;
      /** JSON of the last startup summary published (startup.ts), so it goes out only on change. */
      lastStartupKey?: string;
      /** Which run the fields above describe, so a note belonging to the previous run isn't left
       * standing over a new one -- see the `detail` handling in pollOne. */
      lastRunId?: string;
      /** The active run's lastSeenAt/lastActivityAt as last published in a `liveness` frame. */
      lastLivenessKey?: string;
    }
  >();
  private timer?: ReturnType<typeof setInterval>;
  /** A pollAll still running when the next tick fires is not overlapped by a second one: two
   * concurrent polls would read the same cursor and publish the same frames twice. */
  private polling = false;
  private lastKeepaliveAt = Date.now();
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
        if (this.polling) return;
        this.polling = true;
        this.pollAll()
          .catch(() => {})
          .finally(() => {
            this.polling = false;
          });
        if (Date.now() - this.lastKeepaliveAt >= SSE_KEEPALIVE_MS) {
          this.lastKeepaliveAt = Date.now();
          this.hub.keepalive();
        }
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

    // Not a seq cursor: agentd's seq restarts at 1 in every run and is shared with `event` frames,
    // so a second run's new entries carry lower seqs than the first run's last entry and a
    // `seq > last` cursor would skip them. Instead: the most recently inserted entries, minus the
    // ones already seen in the previous window. The first poll publishes the whole window, which
    // covers entries written between the browser's GET .../entries and this subscription (the
    // browser dedupes by id).
    const recent = await this.store.entries.listRecent(sessionId, SSE_RECENT_WINDOW);
    for (const e of recent) {
      if (cursor.seenEntryIds?.has(e.entry.id)) continue;
      this.hub.publish(sessionId, { type: "entry", data: entryForWire(e) });
    }
    cursor.seenEntryIds = new Set(recent.map((e) => e.entry.id));

    const run = await this.store.runs.findActiveForSession(sessionId);
    // Bug 3 (docs/reports/cloud-fixes.md): no *active* run doesn't mean "stopped" -- it could be
    // "failed" too, and the two must read differently in the UI. Fall back to the most recent run
    // (of any state) so a transition into "failed" is actually observed, not flattened to "stopped".
    const terminal = run ?? (await this.store.runs.findLatestForSession(sessionId));
    const state = terminal?.state ?? "stopped";
    const detail = terminal?.statusDetail;
    // A status event with no `detail` means "nothing new to say" and deliberately leaves the last
    // note standing (an ordinary state-only frame from agentd must not wipe it -- see the Run.
    // statusDetail doc and useSessionStream), while a new run naturally starts with no statusDetail
    // of its own. Together those two rules used to pin a dead run's note over its successor: press
    // Play after a run the api refused and the old "no GitHub token" alert stayed on screen until a
    // reload. So the first poll that observes a different run sends an explicit null, which the
    // browser reads as "drop it".
    const runChanged = terminal !== null && terminal.id !== cursor.lastRunId;
    if (runChanged) {
      cursor.lastStatusDetail = undefined;
      cursor.lastStartupKey = undefined;
    }
    // The run's start-up timing (startup.ts). Sent whenever it changes (ready, then "pi ready"), and
    // as an explicit null on a new run with none yet, so the browser drops the previous run's.
    const startup = terminal ? summarizeStartup(terminal) : null;
    const startupKey = JSON.stringify(startup);
    const startupChanged = startupKey !== cursor.lastStartupKey;
    if (
      state !== cursor.lastState ||
      runChanged ||
      startupChanged ||
      (detail !== undefined && detail !== cursor.lastStatusDetail)
    ) {
      this.hub.publish(sessionId, {
        type: "status",
        data: {
          t: "status",
          state,
          reason: run ? undefined : terminal?.reason,
          detail: runChanged ? (detail ?? null) : detail,
          ...(startupChanged ? { startup } : {}),
        },
      });
      cursor.lastState = state;
      cursor.lastRunId = terminal?.id;
      cursor.lastStartupKey = startupKey;
      if (detail !== undefined) cursor.lastStatusDetail = detail;
    }
    // Liveness (#182): pi's own events never cross from the link role to this one, so the page
    // can't see a long turn streaming. It gets how long ago agentd last spoke (heartbeats every
    // 15 s) and how long ago pi last did anything, as ages rather than timestamps so the browser's
    // clock never has to agree with ours. Sent whenever either changes.
    if (run && (run.lastSeenAt || run.lastActivityAt)) {
      const key = `${run.id}|${run.lastSeenAt ?? ""}|${run.lastActivityAt ?? ""}`;
      if (key !== cursor.lastLivenessKey) {
        const now = Date.now();
        const age = (iso?: string) => (iso ? Math.max(0, now - Date.parse(iso)) : undefined);
        this.hub.publish(sessionId, {
          type: "liveness",
          data: { seenAgoMs: age(run.lastSeenAt), activityAgoMs: age(run.lastActivityAt) },
        });
        cursor.lastLivenessKey = key;
      }
    }
    if (run && typeof run.costEstimate === "number" && run.costEstimate !== cursor.lastCostEstimate) {
      this.hub.publish(sessionId, { type: "spend", data: { t: "spend", estimate: run.costEstimate } });
      cursor.lastCostEstimate = run.costEstimate;
    }
    const uiKey = run?.pendingUiRequest ? JSON.stringify(run.pendingUiRequest) : undefined;
    if (uiKey && uiKey !== cursor.lastUiRequestKey) {
      this.hub.publish(sessionId, { type: "event", data: run?.pendingUiRequest });
      cursor.lastUiRequestKey = uiKey;
    } else if (!uiKey && cursor.lastUiRequestKey) {
      // The question was published and is now gone (answered, or the run left the active set).
      // Resetting the cursor alone left the browser's lamp blue. One clear frame; a session that
      // never had a question has no lastUiRequestKey, so its first poll sends nothing.
      this.hub.publish(sessionId, { type: "event", data: { type: "extension_ui_request", cleared: true } });
      cursor.lastUiRequestKey = undefined;
    }

    this.cursors.set(sessionId, cursor);
  }
}
