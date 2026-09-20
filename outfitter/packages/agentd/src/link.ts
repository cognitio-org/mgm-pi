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
import { isSeqUpMessage, type DownMessage, type UpMessage } from "./protocol.js";

export interface LinkOptions {
  url: string;
  /** Invoked fresh on every open()/reconnect so the Authorization header always carries a live
   * token. */
  headers: () => Promise<Record<string, string>>;
  runId: string;
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
  /** Injectable timer functions, for tests. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
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
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionAgeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxConnectionAgeMs: number;
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
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.sessionId = opts.sessionId;
  }

  onMessage(handler: LinkHandler): void {
    this.handlers.push(handler);
  }

  /** Learned from `run.spec` on first connect; subsequent reconnects' `hello` frames use it. */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearConnectionAgeTimer();
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

  /** Sends a frame that carries no seq (status, spend, checkpoint, heartbeat, bye) -- not buffered,
   * since replay-on-reconnect only applies to the seq-numbered entry/event stream. */
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
    if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // If not open, the frame stays in `pending` (for seq frames) or is simply dropped (for
    // non-seq frames like heartbeat, which the next heartbeat tick will re-send anyway).
  }

  /** Fetches fresh headers (a live identity token) and opens the socket with them. Called on the
   * initial connect and on every reconnect -- never reuses a header snapshot from an earlier
   * (re)connect, since GCE metadata identity tokens are short-lived. */
  private open(): void {
    if (this.closed) return;
    this.opts.headers().then(
      (headers) => this.openWithHeaders(headers),
      () => {
        // The headers provider failed (e.g. a transient metadata-server hiccup). Treat it like a
        // failed connection attempt and retry with backoff rather than throwing out of here.
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
      this.attempt = 0;
      const hello: UpMessage = {
        t: "hello",
        runId: this.opts.runId,
        sessionId: this.sessionId,
        agentdVersion: this.opts.agentdVersion,
        piVersion: this.opts.piVersion,
        lastAckedSeq: this.lastAckedSeq,
      };
      this.transmit(hello);
      // Resend everything still unacked, in original order, so the api can replay/dedupe past
      // lastAckedSeq.
      for (const msg of this.pending) this.transmit(msg);
      this.armConnectionAgeTimer();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let parsed: DownMessage;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (parsed.t === "ack") this.ack(parsed.seq);
      for (const h of this.handlers) h(parsed);
    });

    ws.on("close", () => {
      this.clearConnectionAgeTimer();
      if (this.closed) return;
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
}
