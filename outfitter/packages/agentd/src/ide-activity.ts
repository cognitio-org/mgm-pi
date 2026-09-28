/**
 * Browser IDE (#242, docs/specs/browser-ide.md §5): is someone using the IDE? code-server is a
 * single-page app on WebSockets, so after the first load, editing makes no page requests; the
 * signal is what the browser sends up those sockets, measured at the IDE's own proxy (so only
 * traffic that came through ngrok's sign-in counts; the model can't fake it from inside).
 *
 * A minute counts as activity when the client sent at least IDE_ACTIVE_FRAMES frames or
 * IDE_ACTIVE_BYTES bytes in it. Spike S4 under gVisor: an idle tab, focused or in the background,
 * sends 31-39 frames and under 740 bytes a minute (keepalives); scrolling 111 frames, a terminal
 * 219, typing 845. code-server's own heartbeat file isn't used: it ticks while a tab is merely open,
 * and it sits in the agent-writable data dir.
 */

export const IDE_ACTIVE_FRAMES = 60;
export const IDE_ACTIVE_BYTES = 2048;
export const IDE_WINDOW_MS = 60_000;

/** Counts WebSocket frames in the client's byte stream for one connection. Client frames are always
 * masked (RFC 6455 §5.3). Only data frames (text, binary, continuation) count; pings, pongs and
 * closes don't, so a browser's own keepalive pings can't tip a minute over. */
export class ClientFrameCounter {
  private buf: Buffer = Buffer.alloc(0);

  /** Returns how many complete data frames `chunk` finished, and its size. */
  push(chunk: Buffer): { frames: number; bytes: number } {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let frames = 0;
    for (;;) {
      if (this.buf.length < 2) break;
      const opcode = this.buf[0]! & 0x0f;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        // Anything past 2^53 isn't a real frame from a browser; drop the stream's framing.
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) { this.buf = Buffer.alloc(0); break; }
        len = Number(big);
        off = 10;
      }
      if (this.buf[1]! & 0x80) off += 4;
      if (this.buf.length < off + len) break;
      if (opcode === 0 || opcode === 1 || opcode === 2) frames++;
      this.buf = this.buf.subarray(off + len);
    }
    // Keep only what an incomplete frame needs; a huge partial frame is counted in bytes anyway.
    if (this.buf.length > 1 << 20) this.buf = Buffer.alloc(0);
    return { frames, bytes: chunk.length };
  }
}

/** Sums frames and bytes over fixed one-minute windows and calls `onActive` once per window that
 * crosses either threshold, as soon as it does. */
export class IdeActivityMeter {
  private windowStart: number;
  private frames = 0;
  private bytes = 0;
  private fired = false;
  private readonly now: () => number;
  private readonly onActive: () => void;

  constructor(opts: { onActive: () => void; now?: () => number }) {
    this.onActive = opts.onActive;
    this.now = opts.now ?? Date.now;
    this.windowStart = this.now();
  }

  record(frames: number, bytes: number): void {
    const now = this.now();
    if (now - this.windowStart >= IDE_WINDOW_MS) {
      this.windowStart = now;
      this.frames = 0;
      this.bytes = 0;
      this.fired = false;
    }
    this.frames += frames;
    this.bytes += bytes;
    if (!this.fired && (this.frames >= IDE_ACTIVE_FRAMES || this.bytes >= IDE_ACTIVE_BYTES)) {
      this.fired = true;
      this.onActive();
    }
  }

  /** A sink for one upgraded connection (LocalPreviewProxy's `clientData`). */
  connection(): (chunk: Buffer) => void {
    const counter = new ClientFrameCounter();
    return (chunk) => {
      const { frames, bytes } = counter.push(chunk);
      this.record(frames, bytes);
    };
  }
}
