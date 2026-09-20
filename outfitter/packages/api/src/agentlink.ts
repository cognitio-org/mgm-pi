// agentd <-> api WebSocket ingress: GET /agent/ws?run=<runId>. Implements the "agentd <-> api"
// table in docs/protocol.md — verifies the agent's token, sends run.spec, persists entry frames
// idempotently, fans event frames to SSE, acks seq, and delivers down-messages queued while no
// socket was connected or the run was still provisioning (REST calls queue in the store; the
// queue drains once agentd reports the run running/idle — on that first "status", or on a later
// reconnect's "hello" if it was already ready).

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Config } from "./config.ts";
import type { Store, Run, Session, Guru, PiEntry, DownMessage } from "./store/types.ts";
import type { SecretsBroker } from "./secrets.ts";
import type { SseHub } from "./sse.ts";
import { verifyAgentToken, bearerFromHeader } from "./auth.ts";
import type { LaptopProbe } from "./laptop.ts";
import { resolveRunModel } from "./laptop.ts";

const REQUEST_TIMEOUT_MS = 15_000;

/** Thrown by buildRunSpec when a repo session has no usable GitHub token secret; handleConnection
 * catches it specifically to close the socket with a clear 1011 reason instead of the generic
 * "internal error" other buildRunSpec failures get. */
export class MissingGithubTokenError extends Error {}

interface PendingRequest {
  runId: string;
  resolve: (frame: UpFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface UpFrame {
  t: string;
  [key: string]: unknown;
}

export interface RunSpecMessage {
  t: "run.spec";
  session: { id: string; name: string; cwd: string };
  /** Absent for a repo-less session (Session.repo === null): agentd starts with an empty
   * /workspace, or restores `workspace.snapshotUrl`, instead of cloning. */
  repo?: { cloneUrl: string; branch: string; baseBranch: string; createBranch: boolean };
  workspace?: { snapshotUrl?: string };
  guru: {
    systemPrompt?: string;
    appendSystemPrompt?: string;
    model: string;
    thinking?: string;
    tools?: string[];
    excludeTools?: string[];
    packages?: string[];
    env?: Record<string, string>;
  };
  snapshot: { url?: string; jsonl?: string };
  secrets: { githubToken: string; litellmKey: string };
  idleStopSeconds: number;
  checkpointEvery: string;
}

// protocol.md leaves the clone URL format implicit; session.repo is stored either as a full URL
// or an "owner/repo" shorthand, resolved to an https GitHub URL here.
function cloneUrlFor(repo: string): string {
  return repo.includes("://") || repo.startsWith("git@") ? repo : `https://github.com/${repo}.git`;
}

function mapStatusToRunState(status: string): Run["state"] {
  if (status === "running") return "running";
  if (status === "idle") return "idle";
  return "provisioning";
}

/** A run is "ready" once agentd has reported it running or idle — i.e. pi is up and can actually
 * receive a prompt/steer/etc. Before that (provisioning) down-messages must stay queued. */
function isReadyState(state: Run["state"]): boolean {
  return state === "running" || state === "idle";
}

export class AgentLink {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly store: Store;
  private readonly config: Config;
  private readonly secretsBroker: SecretsBroker;
  private readonly sse: SseHub;
  private readonly laptopProbe: LaptopProbe;

  constructor(store: Store, config: Config, secretsBroker: SecretsBroker, sse: SseHub, laptopProbe: LaptopProbe) {
    this.store = store;
    this.config = config;
    this.secretsBroker = secretsBroker;
    this.sse = sse;
    this.laptopProbe = laptopProbe;
  }

  register(app: FastifyInstance): void {
    app.get("/agent/ws", { websocket: true }, (socket, request) => {
      this.handleConnection(socket, request).catch((err) => {
        request.log.error(err, "agentlink connection failed");
        closeQuietly(socket, 1011, "internal error");
      });
    });
  }

  hasSocket(runId: string): boolean {
    const socket = this.sockets.get(runId);
    return !!socket && socket.readyState === socket.OPEN;
  }

  /**
   * Starts the down-message queue poller: every `intervalMs` (config.downQueuePollMs), for each
   * run whose socket lives in *this* process and whose state is running/idle, drains anything
   * queued in the store and sends it. Needed because outfitter-api (web role) and outfitter-link
   * (link role) are separate Cloud Run services sharing one Atlas store: a message posted by the
   * web role for a run whose socket is on a link instance only reaches the store
   * (`enqueueDownMessage`, in `send` below), and would otherwise sit there until that run's next
   * `hello`/first-ready `status` frame. `drainDownMessages` is an atomic pop (MongoStore:
   * findOneAndUpdate; MemoryStore: single-threaded swap), so two processes racing to drain the
   * same run's queue never double-deliver. Only meant for the "link" (or "all") role — the web
   * role never holds agentd sockets, so server.ts doesn't start this there.
   */
  startDownQueuePoller(intervalMs = this.config.downQueuePollMs): () => void {
    const timer = setInterval(() => {
      this.pollDownQueuesOnce().catch(() => {
        // transient store hiccup; next tick retries
      });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** One poll pass, run by startDownQueuePoller's interval. Public so tests can trigger a drain
   * deterministically instead of racing a real timer (an unref'd interval with nothing else
   * keeping the event loop alive may never actually fire in a short-lived test process). */
  async pollDownQueuesOnce(): Promise<void> {
    for (const [runId, socket] of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      const run = await this.store.runs.findById(runId);
      if (!run || !isReadyState(run.state)) continue;
      const pending = await this.store.runs.drainDownMessages(runId);
      for (const message of pending) socket.send(JSON.stringify(message));
    }
  }

  /**
   * Sends a down-message now if the run has a live socket *and* agentd has already reported it
   * running/idle, else queues it in the store for delivery once that happens (the "hello" and
   * "status" handlers below both drain the queue when the run becomes ready). A run that is still
   * provisioning has no pi process listening yet, so delivering early would just be lost.
   */
  async send(runId: string, message: DownMessage): Promise<void> {
    const socket = this.sockets.get(runId);
    const run = await this.store.runs.findById(runId);
    const ready = !!run && isReadyState(run.state);
    if (socket && socket.readyState === socket.OPEN && ready) {
      socket.send(JSON.stringify(message));
      return;
    }
    await this.store.runs.enqueueDownMessage(runId, message);
  }

  /**
   * Sends a request down-message (diff) and waits for the matching `<t>.result` up frame,
   * correlated by reqId. Requires a live socket: there is nothing to diff on a stopped sandbox.
   */
  async request(runId: string, message: { t: "diff" }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<UpFrame> {
    const socket = this.sockets.get(runId);
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new Error("run has no live agent connection");
    }
    const reqId = randomUUID();
    const result = new Promise<UpFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error("timed out waiting for agentd reply"));
      }, timeoutMs);
      this.pendingRequests.set(reqId, { runId, resolve, reject, timer });
    });
    socket.send(JSON.stringify({ ...message, reqId }));
    return result;
  }

  private async handleConnection(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const runId = String((request.query as Record<string, unknown> | undefined)?.run ?? "");
    if (!runId) return closeQuietly(socket, 4400, "missing run query param");

    try {
      await verifyAgentToken(bearerFromHeader(request), this.config);
    } catch {
      return closeQuietly(socket, 4401, "unauthorized");
    }

    const run = await this.store.runs.findById(runId);
    if (!run) return closeQuietly(socket, 4404, "run not found");
    if (!["provisioning", "running", "idle"].includes(run.state)) {
      return closeQuietly(socket, 4409, `run is ${run.state}`);
    }

    const session = await this.store.sessions.findById(run.sessionId);
    if (!session) return closeQuietly(socket, 4404, "session not found");
    const guru = await this.store.gurus.findById(session.guruId);
    if (!guru) return closeQuietly(socket, 4404, "guru not found");

    this.sockets.set(runId, socket);
    socket.on("close", () => {
      if (this.sockets.get(runId) === socket) this.sockets.delete(runId);
      // any in-flight diff/read request on this run's connection can never be answered now
      for (const [reqId, pending] of this.pendingRequests) {
        if (pending.runId !== runId) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error("agent connection closed"));
        this.pendingRequests.delete(reqId);
      }
    });
    socket.on("message", (raw: Buffer | string) => {
      this.handleUpFrame(runId, session.id, socket, raw).catch((err) => {
        request.log.error(err, "agentlink up-frame failed");
      });
    });

    let spec: RunSpecMessage;
    try {
      spec = await this.buildRunSpec(runId, session, guru);
    } catch (err) {
      if (err instanceof MissingGithubTokenError) {
        request.log.warn(err, "run.spec build failed: missing github token secret");
        return closeQuietly(socket, 1011, err.message);
      }
      throw err;
    }
    socket.send(JSON.stringify(spec));
  }

  private async buildRunSpec(runId: string, session: Session, guru: Guru): Promise<RunSpecMessage> {
    // E2.8 laptop model preflight (src/laptop.ts): swap a laptop-only model for the guru's cloud
    // fallback when the laptop tunnel probes offline, and record it on the run for the UI.
    const wanted = session.modelOverride ?? guru.model;
    const online = await this.laptopProbe.isOnline();
    const resolved = resolveRunModel({
      wanted,
      guruFallbackModel: guru.fallbackModel,
      localModels: this.config.localModels,
      defaultCloudModel: this.config.defaultCloudModel,
      laptopOnline: online,
    });
    await this.store.runs.update(runId, {
      modelFallback: resolved.fallback,
      updatedAt: new Date().toISOString(),
    });

    const secrets = await this.secretsBroker.secretsForRun(session, guru);
    // GcpSecretsBroker (secrets.ts) resolves a missing `outfitter-github-token-<sessionId>` secret
    // to "" rather than throwing, so a session with no repo (which needs no GitHub token at all)
    // is never blocked by it. A *repo* session with an empty token would otherwise agentd-clone
    // with no credentials and fail confusingly deep inside the sandbox; fail fast here instead,
    // with a reason the agentd/operator can act on.
    if (session.repo && !secrets.githubToken) {
      // Close reasons are capped at 123 UTF-8 bytes by the WebSocket protocol; keep this short
      // even for a long (e.g. UUID) session id. The full secret name is in the server log line
      // above instead.
      throw new MissingGithubTokenError(`missing github token secret for session ${session.id}`);
    }
    return {
      t: "run.spec",
      session: { id: session.id, name: session.name ?? session.id, cwd: "/workspace" },
      ...(session.repo
        ? {
            repo: {
              cloneUrl: cloneUrlFor(session.repo),
              branch: session.branch ?? `outfitter/${session.id}`,
              baseBranch: session.baseBranch ?? "main",
              // Deviation from protocol.md (createBranch isn't specced further): true only for a
              // session's first run, inferred from having no checkpoint yet.
              createBranch: !session.checkpoint,
            },
          }
        : { workspace: { snapshotUrl: session.checkpoint?.workspaceUrl } }),
      guru: {
        systemPrompt: guru.systemPrompt,
        appendSystemPrompt: guru.appendSystemPrompt,
        model: resolved.model,
        thinking: guru.thinking,
        tools: guru.tools,
        excludeTools: guru.excludeTools,
        packages: guru.packages,
        env: guru.env,
      },
      snapshot: { url: session.checkpoint?.snapshotUrl },
      secrets,
      idleStopSeconds: this.config.idleStopSeconds,
      // Deviation from protocol.md (checkpointEvery isn't specced further, and agentd's
      // protocol.ts types it as a string rather than a number): checkpoint after every turn.
      checkpointEvery: "turn",
    };
  }

  private async handleUpFrame(runId: string, sessionId: string, socket: WebSocket, raw: Buffer | string): Promise<void> {
    let frame: UpFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return; // malformed frame, ignore rather than kill the connection
    }
    const now = new Date().toISOString();

    switch (frame.t) {
      case "hello": {
        // Reconnect tolerance: only drain here if the run was already ready before this hello (a
        // reconnect after running/idle). A first connect's hello arrives before agentd has ever
        // reported running/idle, so draining then would deliver down-messages (e.g. the initial
        // prompt) before pi exists to receive them; the "status" case below drains once instead,
        // the first time the run actually becomes ready.
        const updated = await this.store.runs.update(runId, { lastSeenAt: now, updatedAt: now });
        if (updated && isReadyState(updated.state)) {
          const pending = await this.store.runs.drainDownMessages(runId);
          for (const message of pending) socket.send(JSON.stringify(message));
        }
        break;
      }
      case "status": {
        const state = mapStatusToRunState(String(frame.state));
        const before = await this.store.runs.findById(runId);
        const wasReady = !!before && isReadyState(before.state);
        await this.store.runs.update(runId, { state, lastSeenAt: now, updatedAt: now });
        this.sse.publish(sessionId, { type: "status", data: frame });
        // First transition into running/idle: drain anything queued while provisioning (in order).
        if (!wasReady && isReadyState(state)) {
          const pending = await this.store.runs.drainDownMessages(runId);
          for (const message of pending) socket.send(JSON.stringify(message));
        }
        break;
      }
      case "entry": {
        const seq = Number(frame.seq);
        const entry = frame.entry as PiEntry;
        const inserted = await this.store.entries.insertIfNew(sessionId, seq, entry);
        if (inserted) {
          await this.store.sessions.update(sessionId, { leafId: entry.id, updatedAt: now });
          this.sse.publish(sessionId, { type: "entry", data: entry });
        }
        await this.ack(runId, socket, seq, now);
        break;
      }
      case "event": {
        const seq = Number(frame.seq);
        const event = frame.event as { type?: string; t?: string; [key: string]: unknown };
        this.sse.publish(sessionId, { type: "event", data: event });
        const eventType = event.type ?? event.t;
        if (eventType === "extension_ui_request") {
          await this.store.runs.update(runId, { pendingUiRequest: event, updatedAt: now });
        }
        await this.ack(runId, socket, seq, now);
        break;
      }
      case "spend": {
        this.sse.publish(sessionId, { type: "spend", data: frame });
        if (typeof frame.keySpend === "number") {
          // frame.keySpend is the LiteLLM *key's* cumulative spend, shared by every run and
          // session using that guru's key — not this run's own cost. Pin keySpendStart to the
          // key's balance the first time this run sees a spend frame, then this run's cost is only
          // what it added since: max(0, keySpend - keySpendStart). session.cost is kept as the sum
          // of its runs' costs by applying this run's delta to it directly, run-cost -> +delta.
          const run = await this.store.runs.findById(runId);
          if (run) {
            const keySpendStart = run.keySpendStart ?? frame.keySpend;
            const cost = Math.max(0, frame.keySpend - keySpendStart);
            const previousCost = run.cost ?? 0;
            const patch: Partial<Run> = { cost, updatedAt: now };
            if (run.keySpendStart === undefined) patch.keySpendStart = keySpendStart;
            await this.store.runs.update(runId, patch);

            const session = await this.store.sessions.findById(sessionId);
            const sessionCost = Math.max(0, (session?.cost ?? 0) - previousCost + cost);
            await this.store.sessions.update(sessionId, { cost: sessionCost, updatedAt: now });
          }
        }
        break;
      }
      case "checkpoint": {
        // protocol.md: branch/head are for a repo session; a repo-less session sends
        // workspaceUrl instead. Store whichever fields this frame actually carries.
        const checkpoint: NonNullable<Session["checkpoint"]> = {};
        if (frame.branch !== undefined) checkpoint.branch = String(frame.branch);
        if (frame.head !== undefined) checkpoint.head = String(frame.head);
        if (frame.snapshotUrl !== undefined) checkpoint.snapshotUrl = String(frame.snapshotUrl);
        if (frame.workspaceUrl !== undefined) checkpoint.workspaceUrl = String(frame.workspaceUrl);
        await this.store.sessions.update(sessionId, { checkpoint, updatedAt: now });
        this.sse.publish(sessionId, { type: "checkpoint", data: frame });
        break;
      }
      case "heartbeat": {
        await this.store.runs.update(runId, { lastSeenAt: now, updatedAt: now });
        break;
      }
      case "diff.result": {
        const reqId = String(frame.reqId ?? "");
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(reqId);
          pending.resolve(frame);
        }
        break;
      }
      case "bye": {
        const reason = String(frame.reason ?? "stop");
        await this.store.runs.update(runId, {
          state: reason === "error" ? "failed" : "stopped",
          reason,
          lastSeenAt: now,
          updatedAt: now,
        });
        this.sockets.delete(runId);
        closeQuietly(socket, 1000, reason);
        break;
      }
      default:
        break; // unknown frame type: ignore, forward-compatible
    }
  }

  private async ack(runId: string, socket: WebSocket, seq: number, now: string): Promise<void> {
    socket.send(JSON.stringify({ t: "ack", seq }));
    await this.store.runs.update(runId, { lastAckedSeq: seq, lastSeenAt: now, updatedAt: now });
  }
}

const CLOSE_HANDSHAKE_GRACE_MS = 2000;

// A graceful close() waits for the peer's close-frame ack before the socket fully ends; ws keeps a
// ref'd ~30s timer alive in the meantime. Cloud Run only grants 10s after SIGTERM, and a stalled
// peer (or a dropped connection) shouldn't hold a handle open that long, so force-terminate if the
// handshake hasn't finished shortly after we initiate it.
function closeQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    return; // already closed
  }
  const timer = setTimeout(() => {
    if (socket.readyState !== socket.CLOSED) socket.terminate();
  }, CLOSE_HANDSHAKE_GRACE_MS);
  timer.unref?.();
}
