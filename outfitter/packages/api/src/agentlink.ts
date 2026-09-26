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
import type { Store, Run, Session, Guru, PiEntry, DownMessage, User } from "./store/types.ts";
import type { SecretsBroker } from "./secrets.ts";
import type { SseHub } from "./sse.ts";
import { verifyAgentToken, bearerFromHeader } from "./auth.ts";
import type { LaptopProbe } from "./laptop.ts";
import { resolveRunModel } from "./laptop.ts";
import { validateSnapshotUrl, snapshotHostAllowlist } from "./snapshot-url.ts";
import { MAIL_LEASE_MS, MAIL_MAX_ATTEMPTS, type MailService } from "./mail.ts";
import { isBrowserActionKind, parseBrowserAction } from "./browser-action.ts";
import { GithubBroker } from "./github-broker.ts";
import { branchAllowed, branchPrefixOf } from "./branch-policy.ts";
import { entryForWire } from "./entry-wire.ts";
import { refreshDelayMs } from "./github-app.ts";
import { parseBootTimings, parseStartupPhases, startupLogLine, summarizeStartup, type StartupSummary } from "./startup.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_REFRESH_RETRY_MS = 60_000;
const GITHUB_REFRESH_MAX_ATTEMPTS = 5;

/** Test seam for the installation-token refresh timers. Production omits it. */
export interface GithubRefreshTiming {
  floorMs?: number;
  retryMs?: number;
  maxAttempts?: number;
}

/** Bug 6 (docs/reports/cloud-fixes.md): pi's rpc.md "Extension UI Protocol" section splits
 * `extension_ui_request` into dialog methods (select/confirm/input/editor -- pi blocks for an
 * `extension_ui_response`) and fire-and-forget display methods (notify/setStatus/setWidget/
 * setTitle/set_editor_text -- no response expected). Only the former are ever worth storing as
 * `Run.pendingUiRequest`; per protocol.md's own "not persisted except extension_ui_request" note,
 * the persistence is meant for a question the run is actually waiting on. */
const INTERACTIVE_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Bug 9 (docs/reports/cloud-fixes.md): agentd's `hello.protocolVersion` is compared with this.
 * The packages can't share a module. Version 2 adds `github.request` / `github.result`
 * (docs/protocol.md). An agentd still speaking an older version — including one that omits the
 * field, treated as 0 — is refused with WS close 4409 instead of silently ignoring frames it
 * doesn't understand. agentd keeps the same number in `WIRE_PROTOCOL_VERSION`. */
export const API_PROTOCOL_VERSION = 2;

/** Thrown by buildRunSpec when a repo session has no usable GitHub token secret; handleConnection
 * catches it specifically to close the socket with the terminal 4412 code (docs/protocol.md) and
 * mark the run failed, instead of the retryable 1011 other buildRunSpec failures get. A
 * 1011 here would make agentd (TERMINAL_CLOSE_CODES, link.ts) treat it as transient and retry for
 * up to ten minutes with the run stuck in provisioning -- this secret is never going to appear on
 * its own, so there is nothing to retry for. `detail` is the session page's note for it. */
export class MissingGithubTokenError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string = MISSING_GITHUB_TOKEN_DETAIL) {
    super(message);
    this.detail = detail;
  }
}

/** #158: the GitHub App is configured but couldn't mint a token just now (network, timeout, a
 * 5xx, a Secret Manager blip). Not terminal: handleConnection's generic catch closes with 1011 so
 * agentd retries, and writes this message as the run's note. Never a reason to fall back to the
 * shared PAT. */
class GithubAppUnavailableError extends Error {}

interface BuiltRunSpec {
  spec: RunSpecMessage;
  githubTokenExpiresAt?: string;
  /** #158: a reconnect whose mint failed. The spec carries no token, and agentd keeps the one it
   * has; handleConnection schedules another mint instead of cancelling the refresh. */
  keepCurrentGithubToken: boolean;
}

/** #158: the session page's note when some GitHub App secret is set but the three aren't usable. */
const GITHUB_APP_MISCONFIGURED_DETAIL =
  "the Outfitter GitHub App's secrets are set but can't be used (a numeric App id, a numeric installation id, " +
  "and the App's PEM private key are all needed), so this run has no GitHub access. An operator has to fix them.";

/** #158: the session page's note when the App is configured but can't reach the session's repo. */
function githubAppNotInstalledDetail(repo: string): string {
  return (
    `the Outfitter GitHub App is not installed on ${repo}, so this run has no GitHub access. ` +
    "Install the App on that repository (or its organization), then start the run again."
  );
}

/** The session page's note for a run refused because its GitHub token secret was never created.
 * Longer and more actionable than the 123-byte-capped close reason: a per-session
 * `outfitter-github-token-<sessionId>` is not operator-managed (src/operator.ts deliberately
 * excludes it from isManagedSecretName), so the fix is out-of-band -- deploy/README.md group (b).
 * The secret's own name stays in the server log, not in a page anyone with the link can read. */
const MISSING_GITHUB_TOKEN_DETAIL =
  "no GitHub token is stored for this session, so its sandbox can't clone the repo. " +
  "An operator has to create the session's GitHub token secret before it can run.";

/** What `refuse` writes onto the run so a refusal is visible in the browser rather than only in
 * Cloud Logging. `detail` lands in Run.statusDetail -- the field the session page renders as its own
 * note and the only one sse.ts forwards while a run is still in an active state; `fail` additionally
 * moves the run to `failed` with the close reason, which is right only for a refusal agentd treats
 * as terminal (link.ts's TERMINAL_CLOSE_CODES) and so will never come back from. */
interface RefusalNotice {
  runId: string;
  detail: string;
  fail: boolean;
}

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
  repo?: { cloneUrl: string; branch: string; baseBranch: string; createBranch: boolean; branchPrefix?: string };
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
    /** Copied from the guru only when it is exactly true. Absent means the check is off. */
    playwrightBeforeCheckpoint?: boolean;
    /** The run's recorded value (Run.allowExternalHtmlResources), sent only when true. Absent means
     * agentd appends the sealed HTML preview paragraph. */
    allowExternalHtmlResources?: boolean;
  };
  snapshot: { url?: string; jsonl?: string };
  // litellmBaseUrl is server-controlled (config.litellmBaseUrl), never guru-editable -- see
  // security-review-pr15.md finding #1: agentd pins it into the pi child's env after guru.env so a
  // guru-supplied LITELLM_BASE_URL can't redirect where the real litellmKey gets sent.
  secrets: { githubToken: string; litellmKey: string; litellmBaseUrl: string };
  /** The session's person, credited on cloud commits (the Outfitter bot authors and commits them;
   * agentd adds `Co-authored-by`/`On-behalf-of` trailers from this). Omitted when the session has
   * no owner on record; agentd then commits as the bot alone. See docs/protocol.md. */
  author?: { name: string; email: string; login?: string };
  idleStopSeconds: number;
  checkpointEvery: string;
}

/** run.spec.author from the session owner's user record, or undefined -- the bot alone, no
 * trailers. Only sent once the record has a `githubEmail`: the trailers land in commit messages on
 * GitHub (public repos included) for good, and the fallback would otherwise be the person's
 * sign-in (work) email. `name` falls back to the email's local part. */
export function authorFor(ownerEmail: string | undefined, user: User | null): RunSpecMessage["author"] {
  // Mongo documents aren't schema-checked: treat anything but a non-blank string as unset.
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const email = str(user?.githubEmail);
  if (!ownerEmail || !email) return undefined;
  const login = str(user?.githubLogin);
  return {
    name: str(user?.name) ?? (str(user?.email) ?? ownerEmail).split("@")[0],
    email,
    ...(login ? { login } : {}),
  };
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
  /** Last time each live agent socket was heard from (its `hello`, then every up-frame). Feeds the
   * single-live-connection rule in handleConnection; a WeakMap so a closed socket's entry goes with
   * the socket itself. */
  private readonly socketSeenAt = new WeakMap<WebSocket, number>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly store: Store;
  private readonly config: Config;
  private readonly secretsBroker: SecretsBroker;
  private readonly sse: SseHub;
  private readonly laptopProbe: LaptopProbe;
  private readonly mail: MailService;
  private readonly github: GithubBroker;
  /** Installation-token refresh timers, one per run. Cleared only when that run's current socket closes. */
  private readonly githubRefresh = new Map<string, ReturnType<typeof setTimeout>>();
  /** Failed mint attempts since the last token was delivered. Capped, then the current token stays. */
  private readonly githubRefreshAttempts = new Map<string, number>();
  private readonly githubRefreshTiming: GithubRefreshTiming;

  constructor(
    store: Store,
    config: Config,
    secretsBroker: SecretsBroker,
    sse: SseHub,
    laptopProbe: LaptopProbe,
    mail: MailService,
    github?: GithubBroker,
    refreshTiming?: GithubRefreshTiming,
  ) {
    this.store = store;
    this.config = config;
    this.secretsBroker = secretsBroker;
    this.sse = sse;
    this.laptopProbe = laptopProbe;
    this.mail = mail;
    this.github = github ?? new GithubBroker(store, secretsBroker);
    this.githubRefreshTiming = refreshTiming ?? {};
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
   * Hands a browser-capture transcript entry to the session's agentd (`browser.capture.entry`),
   * which emits it as a normal `entry` up-frame so the seq comes from agentd's counter.
   * A ready local socket gets the frame now; otherwise it is queued like any other down-frame
   * (drained on the first ready status, a reconnect hello, or the down-queue poller).
   * Returns false only when no run is connected and none is provisioning — nothing else is
   * allocating seqs, and the caller may insert with maxSeq+1. Does not touch leafId.
   */
  async sendCaptureEntry(sessionId: string, entry: PiEntry): Promise<boolean> {
    const run = await this.store.runs.findActiveForSession(sessionId);
    if (!run) return false;
    const agentOwnsSeq =
      this.hasSocket(run.id) ||
      run.state === "provisioning" ||
      run.state === "running" ||
      run.state === "idle" ||
      run.state === "stopping";
    if (!agentOwnsSeq) return false;
    await this.send(run.id, { t: "browser.capture.entry", entry });
    return true;
  }

  /**
   * Tells the session's agentd how a `browser.capture.request` finished. No transcript seq —
   * `sendCaptureEntry` is the entry path. Dropped when nothing is connected or provisioning,
   * because there is no Drive waiting. A repeat of a finished request is the caller's choice;
   * this just delivers the frame.
   */
  async sendCaptureResult(
    sessionId: string,
    frame: {
      t: "browser.capture.result";
      requestId: string;
      captureId?: string;
      title?: string;
      url?: string;
      error?: string;
    },
  ): Promise<void> {
    const run = await this.store.runs.findActiveForSession(sessionId);
    if (!run) return;
    await this.send(run.id, frame);
  }

  /** The run's own sandbox may download a capture jpeg. The bearer is the agent id token
   * (checked by the caller); this is the RUN_TOKEN half, bound to the active run for `sessionId`.
   * A user Dongle is a different credential and does not come through here. */
  async runMayDownloadCapture(sessionId: string, runToken: unknown): Promise<boolean> {
    const run = await this.store.runs.findActiveForSession(sessionId);
    if (!run) return false;
    return runTokenMatches(runToken, run.runTokenHash);
  }

  /** `{t:"browser.capture.request"}` from the Drive. One row per requestId. `no_share` and a
   * repeat of an already-finished id are answered immediately; a new pending row waits for the
   * upload, a revoke, or a capture-failure report to send `browser.capture.result`. */
  private async handleBrowserCaptureRequest(sessionId: string, frame: UpFrame): Promise<void> {
    const requestId = frame.requestId;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) return;
    const now = new Date().toISOString();
    const session = await this.store.sessions.findById(sessionId);
    const saved = await this.store.browserRequests.insertPendingIfShared(sessionId, {
      id: requestId,
      sessionId,
      requesterEmail: session?.ownerEmail?.trim() || "drive",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    if (saved === "no_share") {
      await this.sendCaptureResult(sessionId, { t: "browser.capture.result", requestId, error: "no_share" });
      return;
    }
    if (saved.status === "skipped") {
      await this.sendCaptureResult(sessionId, { t: "browser.capture.result", requestId, error: "skipped" });
      return;
    }
    if (saved.status === "failed" && saved.error) {
      await this.sendCaptureResult(sessionId, { t: "browser.capture.result", requestId, error: saved.error });
      return;
    }
    if (saved.status !== "done") return;
    const capture = saved.captureId
      ? await this.store.browserCaptures.findById(sessionId, saved.captureId)
      : await this.store.browserCaptures.findByRequestId(sessionId, saved.id);
    if (!capture) return;
    await this.sendCaptureResult(sessionId, {
      t: "browser.capture.result",
      requestId,
      captureId: capture.id,
      title: capture.title,
      url: capture.url,
    });
  }

  /** Tells the session's agentd how a `browser.action.request` finished. No transcript seq. */
  async sendActionResult(
    sessionId: string,
    frame: {
      t: "browser.action.result";
      requestId: string;
      error?: string;
    },
  ): Promise<void> {
    const run = await this.store.runs.findActiveForSession(sessionId);
    if (!run) return;
    await this.send(run.id, frame);
  }

  /** `{t:"browser.action.request"}` from the Drive. One action row per requestId. */
  private async handleBrowserActionRequest(sessionId: string, frame: UpFrame): Promise<void> {
    const requestId = frame.requestId;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) return;
    const action = parseBrowserAction({ kind: frame.kind, selector: frame.selector, ...(frame.text !== undefined ? { text: frame.text } : {}) });
    if (!action) {
      await this.sendActionResult(sessionId, { t: "browser.action.result", requestId, error: "rejected" });
      return;
    }
    const now = new Date().toISOString();
    const session = await this.store.sessions.findById(sessionId);
    const saved = await this.store.browserRequests.insertPendingIfShared(sessionId, {
      id: requestId,
      sessionId,
      requesterEmail: session?.ownerEmail?.trim() || "drive",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      kind: action.kind,
      selector: action.selector,
      ...(action.kind === "type" ? { text: action.text } : {}),
    });
    if (saved === "no_share") {
      await this.sendActionResult(sessionId, { t: "browser.action.result", requestId, error: "no_share" });
      return;
    }
    if (!isBrowserActionKind(saved.kind) || saved.kind !== action.kind || saved.selector !== action.selector) {
      await this.sendActionResult(sessionId, { t: "browser.action.result", requestId, error: "rejected" });
      return;
    }
    if (saved.status === "skipped") {
      await this.sendActionResult(sessionId, { t: "browser.action.result", requestId, error: "skipped" });
      return;
    }
    if (saved.status === "failed" && saved.error) {
      await this.sendActionResult(sessionId, { t: "browser.action.result", requestId, error: saved.error });
      return;
    }
    if (saved.status === "done") {
      await this.sendActionResult(sessionId, { t: "browser.action.result", requestId });
    }
  }

  /** Tells the session's agentd how a `browser.inspect.request` finished. No transcript seq. */
  async sendInspectResult(
    sessionId: string,
    frame: {
      t: "browser.inspect.result";
      requestId: string;
      messages?: string[];
      element?: string | null;
      error?: string;
    },
  ): Promise<void> {
    const run = await this.store.runs.findActiveForSession(sessionId);
    if (!run) return;
    await this.send(run.id, frame);
  }

  /** `{t:"browser.inspect.request"}` from the Drive. One inspect row per requestId. No tab id. */
  private async handleBrowserInspectRequest(sessionId: string, frame: UpFrame): Promise<void> {
    const requestId = frame.requestId;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) return;
    const now = new Date().toISOString();
    const session = await this.store.sessions.findById(sessionId);
    const saved = await this.store.browserRequests.insertPendingIfShared(sessionId, {
      id: requestId,
      sessionId,
      requesterEmail: session?.ownerEmail?.trim() || "drive",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      kind: "inspect",
    });
    if (saved === "no_share") {
      await this.sendInspectResult(sessionId, { t: "browser.inspect.result", requestId, error: "no_share" });
      return;
    }
    if (saved.kind !== "inspect") {
      await this.sendInspectResult(sessionId, { t: "browser.inspect.result", requestId, error: "rejected" });
      return;
    }
    if (saved.status === "skipped") {
      await this.sendInspectResult(sessionId, { t: "browser.inspect.result", requestId, error: "skipped" });
      return;
    }
    if (saved.status === "failed" && saved.error) {
      await this.sendInspectResult(sessionId, { t: "browser.inspect.result", requestId, error: saved.error });
      return;
    }
    if (saved.status === "done") {
      await this.sendInspectResult(sessionId, {
        t: "browser.inspect.result",
        requestId,
        messages: saved.inspectMessages ?? [],
        element: saved.inspectElement ?? null,
      });
    }
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
    // The one refusal that can't go through `refuse`: with no run id there is no run to write a
    // notice onto, and no FrameBuffer yet either.
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
      // No notice: nothing has yet tied this caller to `runId` -- see refuse() on why an unproven
      // caller never gets to write on a run.
      request.log.warn({ runId }, "agentlink: closing connection, the agent bearer token did not verify");
      return this.refuse(socket, buffer, 4401, "unauthorized");
    }

    const run = await this.store.runs.findById(runId);
    if (!run) {
      // Nothing to write a notice onto, by definition.
      request.log.warn({ runId }, "agentlink: closing connection, no such run");
      return this.refuse(socket, buffer, 4404, "run not found");
    }
    if (!["provisioning", "running", "idle", "stopping"].includes(run.state)) {
      // No notice on purpose: this run already holds the state and reason it really ended with
      // (stopped by the user, failed by the reconciler), which the UI reads correctly -- a late
      // connection for it must not overwrite that with "refused".
      request.log.info({ runId, state: run.state }, "agentlink: closing connection, run is no longer connectable");
      return this.refuse(socket, buffer, 4409, `run is ${run.state}`);
    }

    // A missing session or guru is a fact about the run, not about whoever is calling (see
    // refuse()): the run can never be built whoever asks, so it is safe -- and useful -- to say so
    // before the run token has been checked.
    const session = await this.store.sessions.findById(run.sessionId);
    if (!session) {
      request.log.error({ runId, sessionId: run.sessionId }, "agentlink: run's session record is missing");
      return this.refuse(socket, buffer, 4404, "session not found", {
        runId,
        detail: "this run's session record is missing from the store, so the api can't build its run spec. Start a new session.",
        fail: true,
      });
    }
    const guru = await this.store.gurus.findById(session.guruId);
    if (!guru) {
      request.log.error({ runId, guruId: session.guruId }, "agentlink: session's guru record is missing");
      return this.refuse(socket, buffer, 4404, "guru not found", {
        runId,
        detail: `this session's guru (${session.guruId}) no longer exists, so the api can't build its run spec. Point the session at a guru that does, or start a new one.`,
        fail: true,
      });
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
      // Deliberately no notice, and the one case where that leaves a run without an explanation of
      // its own: this is precisely the refusal an impostor triggers, so writing to the run here
      // would be the cross-run failure primitive refuse() describes. A sandbox whose RUN_TOKEN is
      // genuinely wrong never heartbeats either, so reconcileOnce (runs.ts) fails the run with "no
      // heartbeat" and a note pointing at this log line -- later than a notice here, but on
      // evidence the api gathered rather than on an unproven caller's word.
      return this.refuse(socket, buffer, 4401, "unauthorized");
    }
    // Past the run token: from here on this really is the run's own sandbox, so a refusal is safe to
    // record against the run.
    if (buffer.overflowed) {
      request.log.warn({ runId }, "agentlink: closing connection, too many frames buffered before hello");
      return this.refuse(socket, buffer, 4400, "too many buffered frames", {
        runId,
        // 4400 is terminal for agentd (link.ts), so nothing will move this run on by itself.
        detail: "this run's sandbox sent more frames than the api will buffer before its hello, so the api refused the connection.",
        fail: true,
      });
    }
    // Bug 9 (docs/reports/cloud-fixes.md): fail loudly on version skew instead of the silent
    // breakage a mismatched deploy caused before (an older agentd ignoring frames a newer web role
    // sent). A missing protocolVersion (an agentd build that predates this field) counts as older.
    const agentProtocolVersion = typeof hello.protocolVersion === "number" ? hello.protocolVersion : 0;
    if (agentProtocolVersion < API_PROTOCOL_VERSION) {
      request.log.warn(
        { runId, agentProtocolVersion, apiProtocolVersion: API_PROTOCOL_VERSION },
        "agentlink: closing connection, agentd protocol version is older than the API's -- redeploy the agent image",
      );
      const reason = `agentd protocol v${agentProtocolVersion} is older than the API's v${API_PROTOCOL_VERSION} -- redeploy the outfitter-agent image`;
      // 4409 is terminal for agentd (it exits), so nothing will ever move this run on: fail it now
      // with the reason, as for 4412, instead of leaving it "provisioning" until the stale-run
      // reconciler notices -- which also pins the session (no wake, no Retry) in the meantime.
      return this.refuse(socket, buffer, 4409, reason, {
        runId,
        detail:
          `this run's sandbox speaks agent protocol v${agentProtocolVersion} but the api speaks ` +
          `v${API_PROTOCOL_VERSION}. The outfitter-agent image needs redeploying before this session can run.`,
        fail: true,
      });
    }

    // Finding #1 (docs/reports/security-review-pr41.md): a valid run token is no longer enough on
    // its own -- a run gets *one* live agent connection at a time. Before this, any second hello
    // carrying the token was handed a fresh run.spec (GitHub token + LiteLLM key) and silently
    // replaced agentd in `this.sockets`, taking over the run's down-channel. agentd's own
    // reconnects are unaffected: it only ever reconnects after its previous socket has closed
    // (link.ts -- the 55-minute rotation calls ws.close() and waits for the 'close' event), and a
    // closed socket is gone from the map by then.
    //
    // The incumbent still counts as live only while it is OPEN *and* was heard from within
    // config.agentSocketGraceMs (default 60s = four of agentd's 15s heartbeats, which start as
    // soon as pi does -- run.ts). A socket silent past that is a dead half-open connection the api
    // was never told about (a partitioned sandbox, a killed instance), so the newcomer replaces it
    // rather than leaving the run wedged until TCP notices. That grace window is not a hole a live
    // sandbox can slip through: it only opens when agentd has stopped heartbeating, which means pi
    // -- the process the model lives in -- is not running.
    //
    // Scope: `sockets` is per-process, so this cannot see a socket held by another link instance
    // (the roles run as separate Cloud Run services, see startDownQueuePoller). The real isolation
    // fix is that the model never sees RUN_TOKEN at all (agentd's pi.ts env allowlist); this is
    // defense in depth for a token that leaks some other way.
    const incumbent = this.sockets.get(runId);
    if (incumbent && incumbent !== socket && this.incumbentIsLive(incumbent)) {
      request.log.warn(
        { runId },
        "agentlink: refusing a second agent connection for a run that already has a live one",
      );
      // No notice: nothing is wrong with this run -- its own agent is connected and heartbeating.
      // 4429 isn't terminal either, so a legitimate newcomer (the incumbent dying moments later)
      // just reconnects.
      return this.refuse(socket, buffer, 4429, "run already has a live agent connection");
    }
    if (incumbent && incumbent !== socket) {
      request.log.info({ runId }, "agentlink: replacing a presumed-dead agent connection");
      if (this.sockets.get(runId) === incumbent) this.sockets.delete(runId);
      // 1001 (going away), not a 44xx: if this socket turns out to be a live agentd after all, it
      // must reconnect rather than treat the close as terminal and exit (link.ts's
      // TERMINAL_CLOSE_CODES).
      closeQuietly(incumbent, 1001, "replaced by a newer agent connection");
    }
    // Claimed synchronously, in the same event-loop turn as the check above and before any further
    // await: two connections racing here (say an impostor timed against agentd's own first connect)
    // must not both see an empty slot and both be handed run.spec.
    this.sockets.set(runId, socket);
    this.socketSeenAt.set(socket, Date.now());
    socket.on("close", () => {
      this.onAgentSocketClosed(runId, socket);
      // any in-flight diff/read request on this run's connection can never be answered now
      for (const [reqId, pending] of this.pendingRequests) {
        if (pending.runId !== runId) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error("agent connection closed"));
        this.pendingRequests.delete(reqId);
      }
    });

    // Past every check: this hello is accepted. `reconnect` says whether startup.helloAt was already
    // stamped (false: this is the run's first hello), or "unknown" when the timing write itself
    // failed. Runs created before Run.startup existed get no stamps at all (without wakeAt a partial
    // set would only mislead), so there it is left out.
    let reconnect: boolean | "unknown" | undefined;
    if (run.startup) {
      try {
        const stamped = await this.store.runs.mergeStartup(
          runId,
          { helloAt: new Date().toISOString(), agentd: parseBootTimings(hello.boot) },
          "helloAt",
        );
        reconnect = stamped === null;
      } catch {
        reconnect = "unknown";
      }
    }
    // agentd-supplied strings: bounded before they go into a log line.
    const logString = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : undefined);
    request.log.info(
      {
        runId,
        agentdVersion: logString(hello.agentdVersion),
        piVersion: logString(hello.piVersion),
        protocolVersion: agentProtocolVersion,
        lastAckedSeq: typeof hello.lastAckedSeq === "number" ? hello.lastAckedSeq : undefined,
        reconnect,
      },
      "agentlink: hello accepted",
    );

    // Bug 10 (docs/reports/cloud-fixes.md): a run created specifically to deliver mail
    // (Run.mailWakePending, set by MailService.wakeForMail) just proved -- token + protocol
    // version both checked out -- that it can genuinely speak the protocol, so charge the
    // mailbox attempt here, once per run (guarded by Run.protocolAcked so a reconnect on the
    // same run doesn't charge again), instead of blindly at wake() time before any of that was
    // known. A run started for some other reason (a browser Start/Wake button) that happens to
    // also have deliverable mail is left alone here -- its mail still gets delivered and counted
    // once, by deliverMail's own claimNext call below, not charged twice.
    if (run.mailWakePending && !run.protocolAcked) {
      const chargeNow = new Date().toISOString();
      await this.store.mail.chargeWake(run.sessionId, chargeNow, MAIL_MAX_ATTEMPTS);
      await this.store.runs.update(runId, { protocolAcked: true, updatedAt: chargeNow });
    }
    // Cloud-fixes 13: this run speaks the protocol, so the session's wakes weren't wasted (reset
    // Mail.unvalidatedWakes), and whatever deploy mismatch parked mail as `held` -- for this
    // session or any other -- is evidently fixed: return it all to the queue. This session's mail
    // goes out over this socket below; other sessions' is woken by the next /tick sweep.
    await this.store.mail.markValidated(run.sessionId);
    const released = await this.store.mail.releaseHeld();
    if (released.length > 0) request.log.info({ runId, sessions: released }, "agentlink: protocol validated, released held mail");

    let built: BuiltRunSpec;
    try {
      built = await this.buildRunSpec(run, session, guru);
    } catch (err) {
      if (err instanceof MissingGithubTokenError) {
        request.log.warn(err, "run.spec build failed: no usable GitHub token for this repo session");
        return this.refuse(socket, buffer, 4412, err.message, {
          runId,
          detail: err.detail,
          fail: true,
        });
      }
      // Any other failure (the secrets broker itself erroring, a store round-trip failing) is
      // treated as transient: register()'s catch closes with 1011, which agentd retries (link.ts),
      // so the run keeps its state and may yet start. It still has to say something -- before this,
      // the run just sat in `provisioning` with the cause visible only in the server log, the same
      // silence refuse() exists to end.
      await this.store.runs
        .update(runId, {
          statusDetail: `the api could not build this run's spec: ${err instanceof Error ? err.message : String(err)}. Retrying.`,
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {});
      throw err;
    }
    // A hello that lost the socket while buildRunSpec was awaiting must not send, and must not
    // replace the timer the new hello just armed.
    if (this.sockets.get(runId) !== socket) return;
    const spec = built.spec;
    socket.send(JSON.stringify(spec));
    if (run.startup) {
      await this.store.runs.mergeStartup(runId, { specSentAt: new Date().toISOString() }, "specSentAt").catch(() => null);
    }
    // agentd applies run.spec once. A reconnect ignores the second one, including when this
    // process is new and its mint cache is empty, so the token has to ride this frame too.
    if (spec.secrets.githubToken) this.deliverGithubCredential(runId, socket, spec.secrets.githubToken);
    if (built.keepCurrentGithubToken) {
      // A new hello gets the full retry budget, not what a replaced connection left of it.
      this.githubRefreshAttempts.delete(runId);
      this.scheduleGithubRetry(runId, session.id);
    } else {
      this.scheduleGithubRefresh(runId, session.id, built.githubTokenExpiresAt);
    }

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

  /** Whether the run's current agent socket should still be treated as the one live connection when
   * a second one shows up (see handleConnection). OPEN is necessary but not sufficient: a socket
   * whose peer vanished without a close frame stays OPEN here indefinitely, so it also has to have
   * been heard from within the grace window. `agentSocketGraceMs: 0` disables the rule entirely. */
  private incumbentIsLive(socket: WebSocket): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    const seenAt = this.socketSeenAt.get(socket);
    if (seenAt === undefined) return false;
    return Date.now() - seenAt < this.config.agentSocketGraceMs;
  }

  /** Single exit for every api-side refusal in handleConnection: record why (somewhere the browser
   * will actually see it), stop buffering frames, and close with the code docs/protocol.md assigns.
   *
   * The motivating incident (session 2cc9494a on cognitio-org/testit, 2026-09-23): a repo session
   * whose `outfitter-github-token-<sessionId>` had never been created was refused here, its sandbox
   * went away, and the run sat in `provisioning` forever. The only evidence anywhere was two Cloud
   * Logging lines; the session page showed an indefinite spinner and the Drives list showed the
   * session as plain "stopped".
   *
   * Not every refusal may write to the run, and the line is the run token. That token is the only
   * thing that proves this socket belongs to this run at all -- a valid agent id token proves just
   * that the caller is *some* execution of the shared agent job (security-review-pr1.md finding
   * #2). So a refusal decided before the token check is decided on the caller's say-so, and
   * persisting it would hand anyone holding an agent token a way to fail other people's runs; those
   * paths pass no notice, and a sandbox that genuinely cannot present its run token is failed by
   * the stale-run reconciler instead (runs.ts's reconcileOnce), on evidence the api gathered
   * itself. The exception is a refusal that is a fact about the run rather than about the caller --
   * its session or guru record is gone -- since such a run is unrunnable whoever asks. */
  private async refuse(
    socket: WebSocket,
    buffer: FrameBuffer,
    code: number,
    reason: string,
    notice?: RefusalNotice,
  ): Promise<void> {
    if (notice) {
      // Best-effort: a store failure here must not turn a deliberate refusal into a rejected
      // handleConnection, whose catch would close with a bare 1011 -- a code agentd retries
      // (link.ts) instead of the terminal one it needs to see.
      await this.store.runs
        .update(notice.runId, {
          statusDetail: notice.detail,
          ...(notice.fail ? { state: "failed" as const, reason } : {}),
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {});
      // Only ever this socket's own entry: a refused newcomer must not unregister the incumbent's.
      if (notice.fail && this.sockets.get(notice.runId) === socket) this.sockets.delete(notice.runId);
    }
    buffer.stop();
    closeQuietly(socket, code, reason);
  }

  private async buildRunSpec(run: Run, session: Session, guru: Guru): Promise<BuiltRunSpec> {
    const runId = run.id;
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
    // Issue #132: the first spec decides the HTML preview paragraph for the whole run (agentd acts on
    // its first run.spec only), so a reconnect reuses what the run recorded rather than a Tape
    // edited since.
    const allowExternalHtmlResources = run.allowExternalHtmlResources ?? guru.allowExternalHtmlResources === true;
    await this.store.runs.update(runId, {
      modelFallback: resolved.fallback,
      allowExternalHtmlResources,
      updatedAt: new Date().toISOString(),
    });

    const secrets = await this.secretsBroker.secretsForRun(session, guru);
    // GcpSecretsBroker (secrets.ts) resolves a missing `outfitter-github-token-<sessionId>` secret
    // to "" rather than throwing -- after a GitHub App installation token, then the shared
    // `outfitter-github-token-default` -- so a session with no repo (which needs no GitHub token at
    // all) is never blocked by it, and a repo session whose own token was never minted still gets
    // one. Reaching here with an empty token therefore means none of those produced one. A repo
    // session in that state would otherwise agentd-clone with no credentials and fail confusingly
    // deep inside the sandbox; fail fast here instead, with a reason the agentd/operator can act
    // on. Dev mode is exempt: it means "no secrets available" (MemorySecretsBroker defaults
    // githubToken to ""), and a dev/test repo session should still be able to clone a public repo
    // anonymously rather than being blocked here.
    // #158: a reconnect of a run whose pi is already going. agentd applies only its first run.spec,
    // so it still holds the token that spec (or a later github.credential) gave it.
    const reconnect = isReadyState(run.state);
    let keepCurrentGithubToken = false;
    if (session.repo && !secrets.githubToken && !this.config.devMode) {
      if (reconnect && (secrets.githubAppFailure === "unavailable" || secrets.githubAppFailure === "misconfigured")) {
        // Keep the token agentd already has, and try the mint again on the refresh schedule. Failing
        // the run, or handing it the shared PAT, both used to happen here. Not for `not-installed`:
        // the token a run keeps could be the shared PAT from before the App was configured.
        keepCurrentGithubToken = true;
      } else if (secrets.githubAppFailure === "misconfigured") {
        throw new MissingGithubTokenError(`github app secrets unusable for session ${session.id}`, GITHUB_APP_MISCONFIGURED_DETAIL);
      } else if (secrets.githubAppFailure === "unavailable") {
        throw new GithubAppUnavailableError(
          `the GitHub App could not mint a token for ${session.repo} just now; the run will retry`,
        );
      } else if (secrets.githubAppFailure === "not-installed") {
        throw new MissingGithubTokenError(
          `github app not installed on session ${session.id}'s repo`,
          githubAppNotInstalledDetail(session.repo),
        );
      } else {
        // Close reasons are capped at 123 UTF-8 bytes by the WebSocket protocol; keep this short
        // even for a long (e.g. UUID) session id. The full secret name is in the server log line
        // above instead.
        throw new MissingGithubTokenError(`missing github token secret for session ${session.id}`);
      }
    }
    const owner = session.ownerEmail ? await this.store.users.findByEmail(session.ownerEmail) : null;
    const author = authorFor(session.ownerEmail, owner);
    return {
      githubTokenExpiresAt: secrets.githubTokenExpiresAt,
      keepCurrentGithubToken,
      spec: {
      t: "run.spec",
      session: { id: session.id, name: session.name ?? session.id, cwd: "/workspace" },
      ...(session.repo
        ? {
            repo: {
              cloneUrl: cloneUrlFor(session.repo),
              branch: session.branch ?? `outfitter/${session.id}`,
              baseBranch: session.baseBranch ?? "main",
              branchPrefix: branchPrefixOf(guru.branchPrefix),
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
        ...(guru.playwrightBeforeCheckpoint === true ? { playwrightBeforeCheckpoint: true } : {}),
        ...(allowExternalHtmlResources ? { allowExternalHtmlResources: true } : {}),
      },
      snapshot: { url: session.checkpoint?.snapshotUrl },
      secrets: { githubToken: secrets.githubToken, litellmKey: secrets.litellmKey, litellmBaseUrl: this.config.litellmBaseUrl },
      ...(author ? { author } : {}),
      idleStopSeconds: this.config.idleStopSeconds,
      // Deviation from protocol.md (checkpointEvery isn't specced further, and agentd's
      // protocol.ts types it as a string rather than a number): checkpoint after every turn.
      checkpointEvery: "turn",
      },
    };
  }

  /** A superseded connection closes after `buildRunSpec` has armed the replacement's timer.
   * Only the socket still in `sockets` may clear that timer. */
  private onAgentSocketClosed(runId: string, socket: WebSocket): void {
    if (this.sockets.get(runId) !== socket) return;
    const timer = this.githubRefresh.get(runId);
    if (timer) clearTimeout(timer);
    this.githubRefresh.delete(runId);
    this.githubRefreshAttempts.delete(runId);
    this.sockets.delete(runId);
  }

  /** Asks agentd for a new installation token before the current one expires. No-op for a PAT. */
  private scheduleGithubRefresh(runId: string, sessionId: string, expiresAt: string | undefined): void {
    const existing = this.githubRefresh.get(runId);
    if (existing) clearTimeout(existing);
    this.githubRefresh.delete(runId);
    this.githubRefreshAttempts.delete(runId);
    if (!expiresAt) return;
    const delay = refreshDelayMs(expiresAt, Date.now(), this.githubRefreshTiming.floorMs);
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      void this.refreshGithubCredential(runId, sessionId).catch((err) => {
        console.warn(`[agentlink] github credential refresh failed: ${githubRefreshError(err)}`);
      });
    }, delay);
    timer.unref?.();
    this.githubRefresh.set(runId, timer);
  }

  /** Another mint while this process still holds the run's socket. Stops after the cap and leaves
   * the token agentd already has; a later reconnect mints again from `secretsForRun`. */
  private scheduleGithubRetry(runId: string, sessionId: string): void {
    const socket = this.sockets.get(runId);
    if (!socket || socket.readyState !== socket.OPEN) return;
    const attempt = (this.githubRefreshAttempts.get(runId) ?? 0) + 1;
    const max = this.githubRefreshTiming.maxAttempts ?? GITHUB_REFRESH_MAX_ATTEMPTS;
    if (attempt > max) {
      this.githubRefreshAttempts.delete(runId);
      console.warn(`[agentlink] github credential refresh stopped after ${max} tries; the current token stays until it expires`);
      return;
    }
    this.githubRefreshAttempts.set(runId, attempt);
    const existing = this.githubRefresh.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.refreshGithubCredential(runId, sessionId).catch((err) => {
        console.warn(`[agentlink] github credential refresh failed: ${githubRefreshError(err)}`);
      });
    }, this.githubRefreshTiming.retryMs ?? GITHUB_REFRESH_RETRY_MS);
    timer.unref?.();
    this.githubRefresh.set(runId, timer);
  }

  private async refreshGithubCredential(runId: string, sessionId: string): Promise<void> {
    this.githubRefresh.delete(runId);
    const socket = this.sockets.get(runId);
    if (!socket || socket.readyState !== socket.OPEN) return;
    try {
      const session = await this.store.sessions.findById(sessionId);
      const refresh = this.secretsBroker.refreshGithubAppToken;
      if (this.sockets.get(runId) !== socket) return;
      if (!session || !refresh) return;
      const next = await refresh.call(this.secretsBroker, session);
      // A hello that arrived while this mint was in flight owns the timer now.
      if (this.sockets.get(runId) !== socket) return;
      if (!next?.token || !this.deliverGithubCredential(runId, socket, next.token, next.expiresAt)) {
        this.scheduleGithubRetry(runId, sessionId);
        return;
      }
      this.githubRefreshAttempts.delete(runId);
      this.scheduleGithubRefresh(runId, sessionId, next.expiresAt);
    } catch (err) {
      if (this.sockets.get(runId) !== socket) return;
      console.warn(`[agentlink] github credential refresh failed: ${githubRefreshError(err)}`);
      this.scheduleGithubRetry(runId, sessionId);
    }
  }

  /** Sends on this hello's socket only. Never `send()`: that queues the token onto `Run.pending`. */
  private deliverGithubCredential(runId: string, socket: WebSocket, token: string, expiresAt?: string): boolean {
    if (this.sockets.get(runId) !== socket || socket.readyState !== socket.OPEN) return false;
    socket.send(JSON.stringify({ t: "github.credential", token, ...(expiresAt ? { expiresAt } : {}) }));
    return true;
  }

  private async handleUpFrame(runId: string, sessionId: string, socket: WebSocket, raw: Buffer | string): Promise<void> {
    let frame: UpFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return; // malformed frame, ignore rather than kill the connection
    }
    // Any frame from the run's registered socket is proof it's alive -- see incumbentIsLive. Only
    // the registered one counts, so a connection being torn down can't keep itself "live".
    if (this.sockets.get(runId) === socket) this.socketSeenAt.set(socket, Date.now());
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
        // Bug 7 (docs/reports/cloud-fixes.md): a status frame's optional `detail` (protocol.md) now
        // also carries agentd's "pi rejected <command>: <error>" notices (run.ts's
        // sendStatusDetail) -- persist it on the run so it survives a reload / a split-role
        // deployment where the browser's own subscriber isn't on this process (see sse.ts's
        // SsePoller), not just the live in-process SSE push below. Only overwritten when a frame
        // actually carries a new detail, so an ordinary state-only frame (the vast majority) right
        // after a notice doesn't immediately wipe it before anyone sees it.
        const patch: Partial<Run> = { state, lastSeenAt: now, updatedAt: now };
        if (typeof frame.detail === "string") patch.statusDetail = frame.detail;
        await this.store.runs.update(runId, patch);
        // `startup` on a browser status event is the api's own summary, never something agentd put
        // on its frame.
        const { startup: _agentStartup, ...statusData } = frame;
        let startup: StartupSummary | null | undefined;
        // First time the run can take a prompt: stamp startup.readyAt (pi is spawned; agentd's
        // "pi ready" follows in a `startup` frame).
        if (before?.startup && !before.startup.readyAt && (state === "running" || state === "idle")) {
          const stamped = await this.store.runs.mergeStartup(runId, { readyAt: now }, "readyAt").catch(() => null);
          if (stamped) startup = summarizeStartup(stamped);
        }
        this.sse.publish(sessionId, { type: "status", data: startup ? { ...statusData, startup } : statusData });
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
        const inserted = await this.store.entries.insertIfNew(sessionId, seq, entry, { runId });
        if (inserted) {
          await this.store.sessions.update(sessionId, { leafId: entry.id, updatedAt: now });
          this.sse.publish(sessionId, { type: "entry", data: entryForWire({ entry, runId }) });
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
        // workspaceUrl instead. A reported branch replaces session.branch only when it is
        // that branch or under the guru's prefix.
        const checkpoint: NonNullable<Session["checkpoint"]> = {};
        const session = await this.store.sessions.findById(sessionId);
        const guru = session ? await this.store.gurus.findById(session.guruId) : null;
        const reported = frame.branch !== undefined ? String(frame.branch) : undefined;
        const current = session?.branch;
        const prefix = branchPrefixOf(guru?.branchPrefix);
        const pushed = frame.pushed === true;
        // A pushed:false frame must not walk session.branch back to an earlier allowed name.
        const takeBranch =
          reported !== undefined &&
          current !== undefined &&
          branchAllowed(reported, current, prefix) &&
          (pushed || reported === current);
        if (reported !== undefined && current !== undefined) checkpoint.branch = takeBranch ? reported : current;
        if (takeBranch && pushed && frame.head !== undefined) checkpoint.head = String(frame.head);
        else if (session?.checkpoint?.head) checkpoint.head = session.checkpoint.head;
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
        const sessionPatch: Partial<Session> = { checkpoint, updatedAt: now };
        if (takeBranch && reported && reported !== current) sessionPatch.branch = reported;
        await this.store.sessions.update(sessionId, sessionPatch);
        this.sse.publish(sessionId, { type: "checkpoint", data: frame });
        break;
      }
      case "startup": {
        // agentd's run phases through "pi ready", sent once (docs/protocol.md). Agent-supplied, so
        // parseStartupPhases keeps known names and clamped numbers only; written once per run.
        const phases = parseStartupPhases(frame.phases);
        if (!phases) break;
        const before = await this.store.runs.findById(runId);
        if (!before?.startup || isTerminalState(before.state)) break;
        const stamped = await this.store.runs.mergeStartup(runId, { phases }, "phases").catch(() => null);
        const summary = stamped ? summarizeStartup(stamped) : null;
        if (!summary) break;
        console.log(JSON.stringify(startupLogLine(summary)));
        this.sse.publish(sessionId, { type: "status", data: { t: "status", state: stamped!.state, startup: summary } });
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
      case "browser.capture.request": {
        await this.handleBrowserCaptureRequest(sessionId, frame);
        break;
      }
      case "github.request": {
        // Not seq/ack replayed, and not on this chain. A GitHub call can take longer than the
        // stale-run window; heartbeats and bye have to keep moving while it runs.
        const reqId = typeof frame.reqId === "string" ? frame.reqId : "";
        void this.github.handle({
          runId,
          op: frame.op,
          args: frame.args,
          idempotencyKey: frame.idempotencyKey,
        }).then((result) => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ t: "github.result", reqId, ...result }));
        }).catch(() => {});
        break;
      }
      case "browser.action.request": {
        await this.handleBrowserActionRequest(sessionId, frame);
        break;
      }
      case "browser.inspect.request": {
        await this.handleBrowserInspectRequest(sessionId, frame);
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

function githubRefreshError(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") {
    return `${name} status ${err.status}`;
  }
  return name;
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
