// agentd <-> api WebSocket ingress: GET /agent/ws?run=<runId>. Implements the "agentd <-> api"
// table in docs/protocol.md — verifies the agent's token, sends run.spec, persists entry frames
// idempotently, fans event frames to SSE, acks seq, and delivers down-messages queued while no
// socket was connected or the run was still provisioning (REST calls queue in the store; the
// queue drains once agentd reports the run running/idle — on that first "status", or on a later
// reconnect's "hello" if it was already ready).

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Config } from "./config.ts";
import type { Store, Run, Session, Guru, PiEntry, DownMessage } from "./store/types.ts";
import type { SecretsBroker } from "./secrets.ts";
import type { SseHub } from "./sse.ts";
import { verifyAgentToken, bearerFromHeader } from "./auth.ts";
import type { LaptopProbe } from "./laptop.ts";
import { resolveRunModel } from "./laptop.ts";
import { validateSnapshotUrl, snapshotHostAllowlist } from "./snapshot-url.ts";
import { MAIL_LEASE_MS, MAIL_MAX_ATTEMPTS, type MailService } from "./mail.ts";

const REQUEST_TIMEOUT_MS = 15_000;

/** Bug 6 (docs/reports/cloud-fixes.md): pi's rpc.md "Extension UI Protocol" section splits
 * `extension_ui_request` into dialog methods (select/confirm/input/editor -- pi blocks for an
 * `extension_ui_response`) and fire-and-forget display methods (notify/setStatus/setWidget/
 * setTitle/set_editor_text -- no response expected). Only the former are ever worth storing as
 * `Run.pendingUiRequest`; per protocol.md's own "not persisted except extension_ui_request" note,
 * the persistence is meant for a question the run is actually waiting on. */
const INTERACTIVE_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Thrown by buildRunSpec when a repo session has no usable GitHub token secret; handleConnection
 * catches it specifically to close the socket with the terminal 4412 code (docs/protocol.md) and
 * mark the run failed, instead of the generic "internal error" other buildRunSpec failures get. A
 * 1011 here would make agentd (TERMINAL_CLOSE_CODES, link.ts) treat it as transient and retry for
 * up to ten minutes with the run stuck in provisioning -- this secret is never going to appear on
 * its own, so there is nothing to retry for. */
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
  // litellmBaseUrl is server-controlled (config.litellmBaseUrl), never guru-editable -- see
  // security-review-pr15.md finding #1: agentd pins it into the pi child's env after guru.env so a
  // guru-supplied LITELLM_BASE_URL can't redirect where the real litellmKey gets sent.
  secrets: { githubToken: string; litellmKey: string; litellmBaseUrl: string };
  idleStopSeconds: number;
  checkpointEvery: string;
}

// protocol.md leaves the clone URL format implicit; session.repo is stored either as a full URL
// or an "owner/repo" shorthand, resolved to an https GitHub URL here.
function cloneUrlFor(repo: string): string {
  return repo.includes("://") || repo.startsWith("git@") ? repo : `https://github.com/${repo}.git`;
}

/** Maps an agentd `status.state` (protocol.md: cloning|restoring|starting|running|idle|
 * checkpointing|stopping) to the Run.state this api stores. `checkpointing` is a transient blip
 * inside whatever the run was already doing (a mid-turn checkpoint push) so it leaves the run's
 * current state untouched rather than falling through to "provisioning" and spuriously re-queuing
 * down-messages or hiding the run's real state from the UI. `stopping` maps to the run state of the
 * same name (routes/sessions.ts's graceful `/stop` also sets it directly, ahead of agentd ever
 * reporting it). Anything else not yet running/idle (cloning/restoring/starting) is "provisioning". */
function mapStatusToRunState(status: string, currentState: Run["state"]): Run["state"] {
  if (status === "running") return "running";
  if (status === "idle") return "idle";
  if (status === "checkpointing") return currentState;
  if (status === "stopping") return "stopping";
  return "provisioning";
}

/** A run is "ready" once agentd has reported it running or idle -- i.e. pi is up and can actually
 * receive a prompt/steer/etc -- or once this api itself has asked it to stop (`stopping`): the
 * agent is still live and connected in that state, just draining toward a graceful `bye`, so a
 * queued `stop` down-message (or anything else still pending) must still be delivered rather than
 * held back. Before "ready" (provisioning) down-messages must stay queued -- there's no pi process
 * listening yet. */
function isReadyState(state: Run["state"]): boolean {
  return state === "running" || state === "idle" || state === "stopping";
}

/** True once a run has reached a terminal state (bye already processed it, or it failed). Used to
 * make `bye` final: a `status`/`heartbeat` frame that arrives after it (e.g. a straggler the socket
 * still delivers post-bye) must not resurrect the run into a non-terminal state. */
function isTerminalState(state: Run["state"]): boolean {
  return state === "stopped" || state === "failed";
}

/** Mail goes only to a run whose pi is up and not draining: a follow-up accepted by a `stopping`
 * run would start a turn that the stop then cuts off, after agentd had already acked it. */
function acceptsMail(state: Run["state"]): boolean {
  return state === "running" || state === "idle";
}

export class AgentLink {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly store: Store;
  private readonly config: Config;
  private readonly secretsBroker: SecretsBroker;
  private readonly sse: SseHub;
  private readonly laptopProbe: LaptopProbe;
  private readonly mail: MailService;

  constructor(
    store: Store,
    config: Config,
    secretsBroker: SecretsBroker,
    sse: SseHub,
    laptopProbe: LaptopProbe,
    mail: MailService,
  ) {
    this.store = store;
    this.config = config;
    this.secretsBroker = secretsBroker;
    this.sse = sse;
    this.laptopProbe = laptopProbe;
    this.mail = mail;
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
      if (acceptsMail(run.state)) await this.deliverMail(runId, run.sessionId, socket);
    }
  }

  /** Delivers a session's deliverable mail now if its active run's socket lives in this process;
   * otherwise the owning link instance's poller picks it up on its next tick. */
  async deliverMailForSession(sessionId: string): Promise<void> {
    const run = await this.store.runs.findActiveForSession(sessionId);
    if (!run || !acceptsMail(run.state)) return;
    const socket = this.sockets.get(run.id);
    if (!socket || socket.readyState !== socket.OPEN) return;
    await this.deliverMail(run.id, sessionId, socket);
  }

  /** One delivery loop per run at a time (the poller, a status frame and a post can all trigger
   * one), so mail goes out in claim order. Sockets only live in this process, so an in-process chain
   * is enough; each caller still sees its own loop's error. */
  private deliverMail(runId: string, sessionId: string, socket: WebSocket): Promise<void> {
    const previous = this.deliveries.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.deliverMailNow(runId, sessionId, socket));
    this.deliveries.set(runId, next);
    const clear = () => {
      if (this.deliveries.get(runId) === next) this.deliveries.delete(runId);
    };
    next.then(clear, clear);
    return next;
  }

  /** Claims mail one message at a time (oldest first) under a lease and sends each as a `mail`
   * frame. The claim is atomic, so two processes delivering to the same run never double-send;
   * anything agentd doesn't ack before the lease expires becomes claimable again. */
  private async deliverMailNow(runId: string, sessionId: string, socket: WebSocket): Promise<void> {
    for (;;) {
      if (socket.readyState !== socket.OPEN) return;
      const now = Date.now();
      const mail = await this.store.mail.claimNext(
        sessionId,
        runId,
        new Date(now).toISOString(),
        new Date(now + MAIL_LEASE_MS).toISOString(),
        MAIL_MAX_ATTEMPTS,
      );
      if (!mail) return;
      socket.send(JSON.stringify({ t: "mail", id: mail.id, text: mail.text, behavior: mail.behavior }));
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

    // Bug fix: agentd sends `hello` immediately once the WS upgrade completes -- it doesn't wait
    // for anything from us first. This handler used to await verifyAgentToken (a network call for
    // Google certs on Cloud Run) and three store lookups *before* attaching any 'message' listener;
    // ws emits 'message' with no listener attached, so a hello that arrived during those awaits was
    // silently dropped, and the connection then sat waiting for a hello that was never going to be
    // resent (agentd only sends it once per connection) until it gave up and reconnected. Attach a
    // buffering listener synchronously, before any await, so no frame sent this early is ever lost.
    const buffer = new FrameBuffer(socket);

    try {
      await verifyAgentToken(bearerFromHeader(request), this.config);
    } catch {
      buffer.stop();
      return closeQuietly(socket, 4401, "unauthorized");
    }

    const run = await this.store.runs.findById(runId);
    if (!run) {
      buffer.stop();
      return closeQuietly(socket, 4404, "run not found");
    }
    if (!["provisioning", "running", "idle", "stopping"].includes(run.state)) {
      buffer.stop();
      return closeQuietly(socket, 4409, `run is ${run.state}`);
    }

    const session = await this.store.sessions.findById(run.sessionId);
    if (!session) {
      buffer.stop();
      return closeQuietly(socket, 4404, "session not found");
    }
    const guru = await this.store.gurus.findById(session.guruId);
    if (!guru) {
      buffer.stop();
      return closeQuietly(socket, 4404, "guru not found");
    }

    // Finding #2 (docs/reports/security-review-pr1.md): every Cloud Run Job execution for
    // outfitter-agent shares one service-account identity, so a valid agent id token only proves
    // the caller is *some* execution of that job -- not that it's the specific execution the api
    // itself started for this run. Wait for the first frame (hello, protocol.md's "first frame
    // after connect") and require it to carry the per-run secret RunManager.wake generated
    // (RUN_TOKEN, handed to the provider at launch) before touching the run any further: no
    // run.spec, no other frame handling, no socket registration until the hash checks out.
    // waitForHello consumes from `buffer` first (anything that arrived during the awaits above),
    // then live frames -- either way it's the connection's actual first frame, same as before.
    const hello = await waitForHello(buffer);
    if (!hello || !runTokenMatches(hello.runToken, run.runTokenHash)) {
      request.log.warn({ runId }, "agentlink: closing connection with a missing or invalid run token");
      buffer.stop();
      return closeQuietly(socket, 4401, "unauthorized");
    }
    if (buffer.overflowed) {
      request.log.warn({ runId }, "agentlink: closing connection, too many frames buffered before hello");
      buffer.stop();
      return closeQuietly(socket, 4400, "too many buffered frames");
    }

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

    let spec: RunSpecMessage;
    try {
      spec = await this.buildRunSpec(runId, session, guru);
    } catch (err) {
      if (err instanceof MissingGithubTokenError) {
        request.log.warn(err, "run.spec build failed: missing github token secret");
        const now = new Date().toISOString();
        await this.store.runs.update(runId, {
          state: "failed",
          reason: err.message,
          updatedAt: now,
        });
        this.sockets.delete(runId);
        buffer.stop();
        return closeQuietly(socket, 4412, err.message);
      }
      throw err;
    }
    socket.send(JSON.stringify(spec));

    // Existing hello behaviour, now run against the same frame the run-token check above already
    // consumed: record first contact and drain anything queued while this run was ready before this
    // connection (a reconnect). A first connect's run is always still `provisioning` here, so this
    // never drains then -- see the "status" case in handleUpFrame for why that's deliberate.
    const now = new Date().toISOString();
    const updated = await this.store.runs.update(runId, { lastSeenAt: now, updatedAt: now });
    if (updated && isReadyState(updated.state)) {
      const pending = await this.store.runs.drainDownMessages(runId);
      for (const message of pending) socket.send(JSON.stringify(message));
    }
    if (updated && acceptsMail(updated.state)) await this.deliverMail(runId, session.id, socket);

    // Replay, in order, any further frames that arrived (and got buffered) while we were still
    // verifying the token / looking up the run / building run.spec -- before switching over to the
    // normal per-connection listener below, so nothing sent this early is lost or reordered.
    for (let raw = buffer.shiftQueued(); raw !== undefined; raw = buffer.shiftQueued()) {
      await this.handleUpFrame(runId, session.id, socket, raw).catch((err) => {
        request.log.error(err, "agentlink up-frame failed");
      });
    }
    buffer.stop();

    // Bug fix: up-frames used to be handed to handleUpFrame per-message with no await on the
    // previous call, so two frames on the same connection (e.g. a `status` frame immediately
    // followed by `bye`) were handled concurrently instead of in arrival order. Each call does its
    // own async store round-trips (findById, then update), so whichever call's update happened to
    // land last won regardless of which frame arrived first -- observed in production as a `bye`'s
    // terminal "stopped" getting silently overwritten back to "provisioning" by a `status:
    // stopping` frame that arrived first but finished its store update after `bye`'s. `chain`
    // serializes handling per connection: each frame's handleUpFrame only starts once the previous
    // one has fully settled. Errors are caught and logged (matching the previous per-message
    // behavior) rather than left to reject `chain`, so one bad frame never wedges every frame after
    // it on this connection.
    let chain: Promise<void> = Promise.resolve();
    socket.on("message", (raw: Buffer | string) => {
      chain = chain.then(() =>
        this.handleUpFrame(runId, session.id, socket, raw).catch((err) => {
          request.log.error(err, "agentlink up-frame failed");
        }),
      );
    });
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
    // with a reason the agentd/operator can act on. Dev mode is exempt: it means "no secrets
    // available" (MemorySecretsBroker defaults githubToken to ""), and a dev/test repo session
    // should still be able to clone a public repo anonymously rather than being blocked here.
    if (session.repo && !secrets.githubToken && !this.config.devMode) {
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
      secrets: { ...secrets, litellmBaseUrl: this.config.litellmBaseUrl },
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
      // "hello" is not handled here: it's always the first frame of a connection (protocol.md), and
      // handleConnection now consumes it itself (via waitForHello) before this listener is even
      // attached, to check the per-run token (finding #2) before doing anything else with the
      // socket. That's also where its lastSeenAt/drain behaviour now lives.
      case "status": {
        const before = await this.store.runs.findById(runId);
        // Make `bye` final: once a run has reached a terminal state, a straggler status frame
        // (e.g. one already in flight when `bye` landed) must not resurrect it.
        if (before && isTerminalState(before.state)) break;
        const state = mapStatusToRunState(String(frame.state), before?.state ?? "provisioning");
        const wasReady = !!before && isReadyState(before.state);
        await this.store.runs.update(runId, { state, lastSeenAt: now, updatedAt: now });
        this.sse.publish(sessionId, { type: "status", data: frame });
        // First transition into running/idle/stopping: drain anything queued while provisioning
        // (in order).
        if (!wasReady && isReadyState(state)) {
          const pending = await this.store.runs.drainDownMessages(runId);
          for (const message of pending) socket.send(JSON.stringify(message));
        }
        if (!(before && acceptsMail(before.state)) && acceptsMail(state)) {
          await this.deliverMail(runId, sessionId, socket);
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
        // Not gated on `inserted`: the mail id is derived from the entry id, so a replay is a no-op,
        // and a send that threw on the first delivery (entry stored, no ack) is retried on replay.
        const recipient = await this.mail.handleAgentSend(sessionId, entry);
        if (recipient) await this.deliverMailForSession(recipient);
        await this.ack(runId, socket, seq, now);
        break;
      }
      case "event": {
        const seq = Number(frame.seq);
        const event = frame.event as { type?: string; t?: string; method?: string; [key: string]: unknown };
        this.sse.publish(sessionId, { type: "event", data: event });
        const eventType = event.type ?? event.t;
        // Bug 6 (docs/reports/cloud-fixes.md): pi's rpc.md distinguishes dialog methods (select,
        // confirm, input, editor -- block on an extension_ui_response) from fire-and-forget
        // display methods (notify, setStatus, setWidget, setTitle, set_editor_text -- no response
        // expected, "the client can display the information or ignore it"). Only the dialog
        // methods are actually a question the run is waiting on; storing a display-only event here
        // left Run.pendingUiRequest (and so the session's questions UI) showing a stale "pending"
        // notify/setStatus/etc that no one was ever going to answer.
        if (eventType === "extension_ui_request" && INTERACTIVE_UI_METHODS.has(String(event.method))) {
          await this.store.runs.update(runId, { pendingUiRequest: event, updatedAt: now });
        }
        await this.ack(runId, socket, seq, now);
        break;
      }
      case "spend": {
        this.sse.publish(sessionId, { type: "spend", data: frame });
        // E2.11: `estimate` is agentd's own running total (pi-extension/outfitter-spend.ts's usage,
        // accumulated by agentd's SpendTailer) -- a straight assignment, not a delta to fold into
        // anything, and populated independently of `keySpend` below (a guru whose route returns no
        // LiteLLM headers at all still gets a real Run.costEstimate).
        if (typeof frame.estimate === "number") {
          await this.store.runs.update(runId, { costEstimate: frame.estimate, updatedAt: now });
        }
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
        // Finding #3 (docs/reports/security-review-pr1.md): snapshotUrl/workspaceUrl round-trip
        // back out as run.spec.snapshot.url / run.spec.workspace.snapshotUrl on the *next* run and
        // get fetched there -- validate before persisting rather than storing whatever a
        // (potentially forged, see finding #2) checkpoint frame claims.
        const allowlist = snapshotHostAllowlist();
        const devMode = this.config.devMode;
        if (frame.snapshotUrl !== undefined) {
          const url = String(frame.snapshotUrl);
          try {
            validateSnapshotUrl(url, { allowlist, devMode });
            checkpoint.snapshotUrl = url;
          } catch {
            // Rejected (not https, or host not in SNAPSHOT_HOST_ALLOWLIST): drop this field rather
            // than persist a URL agentd would refuse to fetch on resume anyway (workspace.ts /
            // run.ts run the same validation). branch/head/workspaceUrl still get saved below.
          }
        }
        if (frame.workspaceUrl !== undefined) {
          const url = String(frame.workspaceUrl);
          try {
            validateSnapshotUrl(url, { allowlist, devMode });
            checkpoint.workspaceUrl = url;
          } catch {
            // See snapshotUrl above.
          }
        }
        await this.store.sessions.update(sessionId, { checkpoint, updatedAt: now });
        this.sse.publish(sessionId, { type: "checkpoint", data: frame });
        break;
      }
      case "heartbeat": {
        const before = await this.store.runs.findById(runId);
        // See the "status" case above: bye is final, a late heartbeat must not touch a terminal run.
        if (before && isTerminalState(before.state)) break;
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
      case "mail.ack": {
        if (typeof frame.id === "string") await this.store.mail.ack(frame.id, runId, now);
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
        // Mail this run was handed but never acked goes back to the queue now rather than after its
        // lease. Then start the next run for it, and for mail held back while this run was stopping
        // -- except after an explicit stop, which the /tick sweep may still override later.
        await this.store.mail.releaseRun(runId);
        if (reason !== "stop") await this.mail.wakeIfMail(sessionId);
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

/** How many raw frames FrameBuffer holds for a connection that hasn't been fully accepted yet
 * (still verifying its token / hello / building run.spec). A well-behaved agentd sends at most
 * `hello` plus a handful of frames before it's heard back; this is generous headroom against a
 * misbehaving or malicious client flooding the socket before it's ever registered. */
const FRAME_BUFFER_CAP = 256;

/** How long handleConnection waits for `hello` after the socket is otherwise ready to accept it.
 * agentd sends `hello` as the very first thing it does after the WS upgrade completes -- there is
 * nothing for it to wait on -- so this only needs to cover a slow connect, not agentd doing real
 * work; 30s is generous. (Previously unbounded: a hello frame lost to the listener-attachment race
 * this file used to have -- see handleConnection -- meant the connection just hung until agentd's
 * own ~5min reconnect gave up and tried again.) */
const HELLO_TIMEOUT_MS = 30_000;

/**
 * Buffers raw WebSocket frames from the moment it's constructed (synchronously, before any await
 * a caller might otherwise do first) so nothing sent this early is lost to the classic "ws emits
 * 'message' with no listener attached" gap. `next()` consumes one frame at a time -- first from
 * whatever's already queued, then from the live socket -- for `waitForHello`; `shiftQueued()` lets
 * a caller drain (without waiting) anything that piled up in the meantime, for replay once the
 * connection is fully accepted. `stop()` detaches the buffering listener; from then on the caller
 * owns `socket`'s 'message' events.
 */
class FrameBuffer {
  private readonly queue: Array<Buffer | string> = [];
  private waiter: ((raw: Buffer | string | undefined) => void) | undefined;
  /** Set once `queue` would have exceeded FRAME_BUFFER_CAP; handleConnection checks this and
   * closes the connection (4400) rather than let it grow unbounded. */
  overflowed = false;

  private readonly onMessage = (raw: Buffer | string): void => {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(raw);
      return;
    }
    if (this.queue.length >= FRAME_BUFFER_CAP) {
      this.overflowed = true;
      return;
    }
    this.queue.push(raw);
  };

  private readonly onClose = (): void => {
    if (!this.waiter) return;
    const resolve = this.waiter;
    this.waiter = undefined;
    resolve(undefined);
  };

  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", this.onMessage);
    socket.on("close", this.onClose);
  }

  /** Resolves with the next frame (queued or live), or `undefined` if the socket closes first
   * without one arriving. */
  next(): Promise<Buffer | string | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Pops one already-queued frame without waiting, or `undefined` if none are queued right now. */
  shiftQueued(): Buffer | string | undefined {
    return this.queue.shift();
  }

  /** Detaches the buffering listener. Idempotent. */
  stop(): void {
    this.socket.off("message", this.onMessage);
    this.socket.off("close", this.onClose);
  }
}

/** Waits (up to HELLO_TIMEOUT_MS) for the connection's first message frame -- consumed from
 * `buffer`, so a hello that arrived before this was even called still counts -- and returns it
 * only if it's a well-formed `hello`; resolves `undefined` on malformed JSON, a non-hello first
 * frame, the socket closing, or the timeout. Used by handleConnection to gate everything else
 * (run.spec, socket registration, other frame handling) on the run-token check -- finding #2. */
function waitForHello(buffer: FrameBuffer, timeoutMs = HELLO_TIMEOUT_MS): Promise<UpFrame | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: UpFrame | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    buffer.next().then((raw) => {
      if (raw === undefined) return finish(undefined);
      try {
        const frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as UpFrame;
        finish(frame.t === "hello" ? frame : undefined);
      } catch {
        finish(undefined);
      }
    });
  });
}

/** Constant-time check that `candidate` (hello.runToken, untrusted) hashes to `expectedHashHex`
 * (Run.runTokenHash, from RunManager.wake). false for a missing/non-string candidate or a run with
 * no stored hash -- never treated as "no check needed". */
function runTokenMatches(candidate: unknown, expectedHashHex: string | undefined): boolean {
  if (typeof candidate !== "string" || !candidate || !expectedHashHex) return false;
  const candidateHash = createHash("sha256").update(candidate).digest();
  let expectedHash: Buffer;
  try {
    expectedHash = Buffer.from(expectedHashHex, "hex");
  } catch {
    return false;
  }
  if (candidateHash.length !== expectedHash.length) return false;
  return timingSafeEqual(candidateHash, expectedHash);
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
