/**
 * WebSocket client for the agentd <-> api link (protocol.md "agentd ⇄ api"). Owns:
 *  - reconnect with exponential backoff
 *  - monotonic `seq` numbering for `entry`/`event` up-frames
 *  - buffering sent seq-frames until the api `ack`s them, so a reconnect can safely resend
 *  - the `hello` handshake with `lastAckedSeq` on every (re)connect
 *  - proactive reconnect before Cloud Run's 60-minute connection cap (EPIC.md E2.4: "Cloud Run 60
 *    min cap: agentd reconnects at 55 min")
 *
 * `ws` is the one runtime dependency (per the deliverable spec); everything else here is plain
 * Node. Connection setup (URL, auth) is the caller's job via `connect()` params -- link.ts does not
 * know about GCE metadata or run.spec. `headers` is a *provider*, not a static object: the GCE
 * metadata server's identity tokens are short-lived, so a long-running agentd process must fetch a
 * fresh one on every (re)connect rather than reusing whatever was valid at startup (main.ts:58's
 * bug -- a token that expired hours into a run would make every reconnect fail with 401 forever).
 */
import WebSocket from "ws";
import { isSeqUpMessage, WIRE_PROTOCOL_VERSION, type BootTimings, type DownMessage, type UpMessage } from "./protocol.js";

/** Close codes the api sends to mean "don't bother reconnecting" -- observed in the first real Cloud
 * Run execution: the api accepted the token, upgraded, then immediately closed with 4404 because the
 * run had already vanished server-side. Without this, agentd treated every close code as transient
 * and reconnected twice a second forever. 4400 bad request / 4401 unauthorized are agentd
 * misconfiguration (exit 1); 4404 run/session/guru not found / 4409 run in a terminal state mean
 * there's simply nothing left to do (exit 0); 4412 means the run cannot start because it has no
 * usable secret (e.g. a repo session with no GitHub token) -- that will never resolve itself on
 * retry, so it's terminal too (exit 1). See docs/protocol.md's close-codes table. 1011 (server
 * internal error) and everything else stay transient and keep reconnecting. */
export const TERMINAL_CLOSE_CODES = new Set([4400, 4401, 4404, 4409, 4412]);

/** Non-seq frames kept while a reconnect waits for the api. They are status/spend/heartbeat-like
 * (the next one supersedes the last), so dropping the oldest past this is harmless. */
const HELD_CAP = 64;

export type TerminalHandler = (code: number, reason: string) => void;
/** Every socket close, terminal or not, with the code the server (or the proxy) actually sent. The
 * first cloud session on the round-two stack closed server-side and agentd left no trace of it. */
export type CloseHandler = (code: number, reason: string, terminal: boolean) => void;
export type UnspecTimeoutHandler = () => void;

export interface LinkOptions {
  url: string;
  /** Invoked fresh on every open()/reconnect so the Authorization header always carries a live
   * token. */
  headers: () => Promise<Record<string, string>>;
  runId: string;
  /** RUN_TOKEN (main.ts), echoed back in every `hello` frame so AgentLink can bind this connection
   * to the specific run it was launched for (docs/reports/security-review-pr1.md finding #2). */
  runToken: string;
  sessionId: string;
  agentdVersion: string;
  piVersion: string;
  /** Base delay for exponential backoff, ms. Default 500. */
  backoffBaseMs?: number;
  /** Backoff cap, ms. Default 30_000. */
  backoffMaxMs?: number;
  /** Injectable WebSocket constructor, for tests. */
  WebSocketImpl?: typeof WebSocket;
  /** Proactively close and reconnect once a connection has been open this long, ahead of Cloud
   * Run's 60-minute cap. Default 55 minutes. */
  maxConnectionAgeMs?: number;
  /** How long a connection must stay open before a flapping server's backoff resets to the base
   * delay. Reset also happens immediately on the first `ack`/`run.spec` of a connection, whichever
   * comes first. Default 10_000 (10s). */
  stableAfterMs?: number;
  /** Total time to keep retrying without ever receiving `run.spec`, before giving up entirely (see
   * `onUnspecTimeout`) rather than retrying quietly until the job's own (much longer) timeout.
   * Default 600_000 (10 min). */
  maxUnspecMs?: number;
  /** Injectable timer functions, for tests. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Called when the `headers` provider itself rejects (e.g. a failed identity-token fetch) --
   * before any socket is even attempted. Reconnect is scheduled exactly as before regardless of
   * whether this is set (#157: this used to be swallowed with no log line at all, which made a
   * real failure indistinguishable from a slow network). The caller's callback must not log the
   * error's raw text if it could ever carry a secret; `main.ts`'s own `headers` provider never puts
   * one in an Error message. Default: no-op. */
  onHeadersError?: (err: unknown) => void;
  /** Read as each `hello` is built: this sandbox's boot timings (protocol.ts's BootTimings), or
   * undefined to leave the field out. */
  bootTimings?: () => BootTimings | undefined;
}

export type LinkHandler = (msg: DownMessage) => void;

export class Link {
  private ws: WebSocket | undefined;
  private nextSeq = 1;
  /** Sent seq-frames not yet acked, in send order, for resend after reconnect. */
  private pending: UpMessage[] = [];
  private lastAckedSeq = 0;
  private attempt = 0;
  private closed = false;
  private handlers: LinkHandler[] = [];
  private openHandlers: Array<() => void> = [];
  private terminalHandlers: TerminalHandler[] = [];
  private closeHandlers: CloseHandler[] = [];
  private unspecTimeoutHandlers: UnspecTimeoutHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionAgeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Armed on every `open`, cleared on `close`; only fires (resetting `attempt`) once the current
   * connection has stayed open for `stableAfterMs`. See `armStableTimer`. */
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  /** Armed once, on the first `connect()`, until `run.spec` arrives. See `armUnspecTimer`. */
  private unspecTimer: ReturnType<typeof setTimeout> | undefined;
  private unspecTimerArmed = false;
  private specReceived = false;
  /** This connection is a reconnect the api hasn't answered yet: only `hello` has gone out. */
  private awaitingApi = false;
  /** Non-seq frames (status, spend, heartbeat, ...) sent while `awaitingApi`, newest HELD_CAP. */
  private held: UpMessage[] = [];
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxConnectionAgeMs: number;
  private readonly stableAfterMs: number;
  private readonly maxUnspecMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  /** Mutable because the sessionId isn't known until `run.spec` arrives on the first connection --
   * only later reconnects can send it in `hello`. See main.ts / run.ts's `begin()`. */
  private sessionId: string;

  constructor(private readonly opts: LinkOptions) {
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.maxConnectionAgeMs = opts.maxConnectionAgeMs ?? 55 * 60 * 1000;
    this.stableAfterMs = opts.stableAfterMs ?? 10_000;
    this.maxUnspecMs = opts.maxUnspecMs ?? 10 * 60 * 1000;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.sessionId = opts.sessionId;
  }

  onMessage(handler: LinkHandler): void {
    this.handlers.push(handler);
  }

  /** The WebSocket opened (initial connect and every reconnect), after `hello` is queued. */
  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  /** Invoked when the server closes the socket with a code in `TERMINAL_CLOSE_CODES` -- there's
   * nothing left to reconnect for (see the module doc). The caller (RunController/main) decides the
   * exit code; Link itself has already stopped reconnecting by the time this fires. */
  onTerminal(handler: TerminalHandler): void {
    this.terminalHandlers.push(handler);
  }

  onClose(handler: CloseHandler): void {
    this.closeHandlers.push(handler);
  }

  /** Invoked once if `maxUnspecMs` elapses without ever receiving `run.spec` -- a misconfigured job
   * would otherwise retry quietly until it hits its own (much longer, e.g. 24h) timeout. */
  onUnspecTimeout(handler: UnspecTimeoutHandler): void {
    this.unspecTimeoutHandlers.push(handler);
  }

  /** Learned from `run.spec` on first connect; subsequent reconnects' `hello` frames use it. */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  connect(): void {
    this.closed = false;
    if (!this.specReceived && !this.unspecTimerArmed) this.armUnspecTimer();
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
    this.clearConnectionAgeTimer();
    this.clearStableTimer();
    if (this.unspecTimer) {
      this.clearTimeoutFn(this.unspecTimer);
      this.unspecTimer = undefined;
    }
    this.ws?.close();
  }

  /** Assigns the next seq and sends an `entry`/`event` frame, buffering it until acked. */
  sendSeq(build: (seq: number) => UpMessage): number {
    const seq = this.nextSeq++;
    const msg = build(seq);
    this.pending.push(msg);
    this.transmit(msg);
    return seq;
  }

  /** Sends a frame that carries no seq (status, spend, checkpoint, heartbeat, bye, github.request)
   * -- not buffered, since replay-on-reconnect only applies to the seq-numbered entry/event stream.
   * A dropped link does not resend `github.request`; the broker socket fails that reqId (a read
   * may be sent once more by the socket, never by this buffer). */
  send(msg: UpMessage): void {
    this.transmit(msg);
  }

  /** Like `send`, but resolves only once the OS has actually accepted the write (or immediately, if
   * not connected) -- `ws.send()` queues and returns before that happens, so a `process.exit()`
   * right after a plain `send()` can drop the frame entirely. Use this for the final `bye` before
   * exiting (protocol.md calls `bye` "last frame" -- it has to actually arrive). */
  sendAndFlush(msg: UpMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
        this.ws.send(JSON.stringify(msg), () => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Drops buffered frames the api has acked up to and including `seq`. */
  private ack(seq: number): void {
    if (seq > this.lastAckedSeq) this.lastAckedSeq = seq;
    this.pending = this.pending.filter((m) => !isSeqUpMessage(m) || m.seq > seq);
  }

  getLastAckedSeq(): number {
    return this.lastAckedSeq;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  private transmit(msg: UpMessage): void {
    if (!(this.ws && this.ws.readyState === this.WebSocketImpl.OPEN)) {
      // Not open: the frame stays in `pending` (for seq frames) or is simply dropped (for non-seq
      // frames like heartbeat, which the next heartbeat tick will re-send anyway).
      return;
    }
    if (this.awaitingApi) {
      // A reconnect the api hasn't answered yet (see `awaitingApi`). Seq frames are already in
      // `pending` and go out on the flush; the rest wait in `held`.
      if (!isSeqUpMessage(msg)) {
        this.held.push(msg);
        if (this.held.length > HELD_CAP) this.held.shift();
      }
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** The api answered a reconnect: send what it would have refused before, in order. */
  private flushAfterApiAnswered(): void {
    this.awaitingApi = false;
    const held = this.held;
    this.held = [];
    for (const msg of this.pending) this.transmit(msg);
    for (const msg of held) this.transmit(msg);
  }

  /** Fetches fresh headers (a live identity token) and opens the socket with them. Called on the
   * initial connect and on every reconnect -- never reuses a header snapshot from an earlier
   * (re)connect, since GCE metadata identity tokens are short-lived. */
  private open(): void {
    if (this.closed) return;
    this.opts.headers().then(
      (headers) => this.openWithHeaders(headers),
      (err) => {
        // The headers provider failed (e.g. a transient metadata-server hiccup). Treat it like a
        // failed connection attempt and retry with backoff rather than throwing out of here --
        // but tell the caller first (#157), since this used to be silently swallowed.
        this.opts.onHeadersError?.(err);
        if (this.closed) return;
        this.scheduleReconnect();
      },
    );
  }

  private openWithHeaders(headers: Record<string, string>): void {
    if (this.closed) return;
    const ws = new this.WebSocketImpl(this.opts.url, { headers });
    this.ws = ws;

    ws.on("open", () => {
      // Don't reset `attempt` here -- a server that accepts the upgrade and then closes right away
      // (the 4404 case observed in the first real Cloud Run execution) would otherwise make every
      // reconnect look like a fresh success and retry at the base delay forever. Only a connection
      // that stays open `stableAfterMs`, or the first ack/run.spec, counts as real progress -- see
      // `armStableTimer` and the "message" handler below.
      const boot = this.opts.bootTimings?.();
      const hello: UpMessage = {
        t: "hello",
        runId: this.opts.runId,
        sessionId: this.sessionId,
        agentdVersion: this.opts.agentdVersion,
        piVersion: this.opts.piVersion,
        lastAckedSeq: this.lastAckedSeq,
        runToken: this.opts.runToken,
        protocolVersion: WIRE_PROTOCOL_VERSION,
        ...(boot ? { boot } : {}),
      };
      // A reconnect of a run that already has its spec (the 55-minute rotation, or a dropped
      // socket) sends `hello` alone and waits for the api's first frame before anything else. The
      // api buffers at most 256 frames before it has checked `hello` and rebuilt run.spec, and
      // refuses the connection terminally past that (4400). A model streaming tokens produces that
      // many in seconds, so replaying unacked frames and carrying on live used to kill the run
      // mid-turn (session 5873e689, #185). The first connect has nothing to send before run.spec.
      this.awaitingApi = this.specReceived;
      this.held = [];
      this.ws!.send(JSON.stringify(hello));
      // Resend everything still unacked, in original order, so the api can replay/dedupe past
      // lastAckedSeq -- now, or once the api answers a reconnect.
      if (!this.awaitingApi) for (const msg of this.pending) this.transmit(msg);
      this.armConnectionAgeTimer();
      this.armStableTimer();
      for (const h of this.openHandlers) h();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let parsed: DownMessage;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (parsed.t === "ack") this.ack(parsed.seq);
      // Any frame means the api has accepted this connection (it re-sends run.spec on every hello).
      if (this.awaitingApi) this.flushAfterApiAnswered();
      if (parsed.t === "ack" || parsed.t === "run.spec") {
        // The api actually spoke to us -- real progress, not just a TCP-level open. Reset backoff
        // immediately rather than waiting out the stability window.
        this.attempt = 0;
        this.clearStableTimer();
      }
      if (parsed.t === "run.spec") {
        this.specReceived = true;
        if (this.unspecTimer) {
          this.clearTimeoutFn(this.unspecTimer);
          this.unspecTimer = undefined;
        }
      }
      for (const h of this.handlers) h(parsed);
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      this.clearConnectionAgeTimer();
      this.clearStableTimer();
      for (const h of this.closeHandlers) h(code, reasonBuf ? reasonBuf.toString() : "", TERMINAL_CLOSE_CODES.has(code));
      if (this.closed) return;
      if (TERMINAL_CLOSE_CODES.has(code)) {
        this.closed = true;
        if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
        if (this.unspecTimer) {
          this.clearTimeoutFn(this.unspecTimer);
          this.unspecTimer = undefined;
        }
        const reason = reasonBuf ? reasonBuf.toString() : "";
        for (const h of this.terminalHandlers) h(code, reason);
        return;
      }
      this.scheduleReconnect();
    });

    ws.on("error", () => {
      // 'close' follows 'error' for ws; reconnect is scheduled there. Swallow here to avoid an
      // unhandled 'error' event crashing the process.
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /** Cloud Run caps a connection at 60 minutes (EPIC.md E2.4); proactively close and reconnect
   * before hitting that cap instead of waiting for the platform to kill the socket mid-frame. */
  private armConnectionAgeTimer(): void {
    this.clearConnectionAgeTimer();
    this.connectionAgeTimer = this.setTimeoutFn(() => {
      if (this.closed) return;
      // A planned rotation, not a failure: reconnect promptly (no backoff) once the current socket
      // closes -- resetting `attempt` here means the 'close' handler's scheduleReconnect() uses the
      // base delay, not whatever backoff the last real failure left `attempt` at.
      this.attempt = 0;
      this.ws?.close();
    }, this.maxConnectionAgeMs);
    // Don't let this timer alone keep the process alive -- the open WebSocket handle (and, while a
    // run is live, the heartbeat interval / pi child / tailer) already do that. Unref'ing matters
    // most for tests, which would otherwise hang for up to `maxConnectionAgeMs` waiting on this
    // handle to clear.
    this.connectionAgeTimer?.unref?.();
  }

  private clearConnectionAgeTimer(): void {
    if (this.connectionAgeTimer) this.clearTimeoutFn(this.connectionAgeTimer);
    this.connectionAgeTimer = undefined;
  }

  /** A connection that stays open this long counts as real progress -- reset backoff so a server
   * that flaps (accept, then close quickly, repeatedly) is retried at the *backoff* cap (30s), not
   * hammered every `backoffBaseMs`. Cleared (without ever firing) on close or on the first
   * ack/run.spec, whichever comes first. */
  private armStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = this.setTimeoutFn(() => {
      this.attempt = 0;
    }, this.stableAfterMs);
    this.stableTimer?.unref?.();
  }

  private clearStableTimer(): void {
    if (this.stableTimer) this.clearTimeoutFn(this.stableTimer);
    this.stableTimer = undefined;
  }

  /** See `onUnspecTimeout`: gives up (once) if `run.spec` never arrives within `maxUnspecMs` of the
   * first `connect()`, across any number of reconnects. */
  private armUnspecTimer(): void {
    this.unspecTimerArmed = true;
    this.unspecTimer = this.setTimeoutFn(() => {
      this.unspecTimer = undefined;
      if (this.specReceived) return;
      for (const h of this.unspecTimeoutHandlers) h();
    }, this.maxUnspecMs);
    this.unspecTimer?.unref?.();
  }
}
