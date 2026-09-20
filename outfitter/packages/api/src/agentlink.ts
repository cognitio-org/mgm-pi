// agentd <-> api WebSocket ingress: GET /agent/ws?run=<runId>. Implements the "agentd <-> api"
// table in docs/protocol.md — verifies the agent's token, sends run.spec, persists entry frames
// idempotently, fans event frames to SSE, acks seq, and delivers down-messages queued while no
// socket was connected (REST calls queue in the store; hello drains the queue).

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

  /** Sends a down-message now if the run has a live socket, else queues it for delivery on connect. */
  async send(runId: string, message: DownMessage): Promise<void> {
    const socket = this.sockets.get(runId);
    if (socket && socket.readyState === socket.OPEN) {
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

    const spec = await this.buildRunSpec(runId, session, guru);
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
        await this.store.runs.update(runId, { lastSeenAt: now, updatedAt: now });
        const pending = await this.store.runs.drainDownMessages(runId);
        for (const message of pending) socket.send(JSON.stringify(message));
        break;
      }
      case "status": {
        const state = mapStatusToRunState(String(frame.state));
        await this.store.runs.update(runId, { state, lastSeenAt: now, updatedAt: now });
        this.sse.publish(sessionId, { type: "status", data: frame });
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
          const session = await this.store.sessions.findById(sessionId);
          const cost = Math.max(session?.cost ?? 0, frame.keySpend);
          await this.store.sessions.update(sessionId, { cost, updatedAt: now });
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
