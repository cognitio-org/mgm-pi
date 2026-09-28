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
 * masked (RFC 6455 §5.3); an unmasked frame means this isn't a browser's WebSocket, and the stream
 * stops counting. Only data frames (text, binary, continuation) count; pings, pongs and closes
 * don't, so a browser's own keepalive pings can't tip a minute over. Only headers are kept: payload
 * bytes are skipped, not buffered. */
export class ClientFrameCounter {
  private header: Buffer = Buffer.alloc(0);
  private skip = 0;
  private broken = false;

  /** Returns how many data frames `chunk` started, and its size. */
  push(chunk: Buffer): { frames: number; bytes: number } {
    const bytes = chunk.length;
    let frames = 0;
    let buf = chunk;
    while (!this.broken && buf.length > 0) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, buf.length);
        this.skip -= n;
        buf = buf.subarray(n);
        continue;
      }
      this.header = this.header.length ? Buffer.concat([this.header, buf]) : buf;
      buf = Buffer.alloc(0);
      const h = this.header;
      if (h.length < 2) break;
      if (!(h[1]! & 0x80)) { this.broken = true; break; } // unmasked: not a browser client
      let len = h[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (h.length < 4) break;
        len = h.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (h.length < 10) break;
        const big = h.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) { this.broken = true; break; }
        len = Number(big);
        off = 10;
      }
      off += 4; // mask key
      if (h.length < off) break;
      const opcode = h[0]! & 0x0f;
      if (opcode === 0 || opcode === 1 || opcode === 2) frames++;
      // Whatever followed the header in this buffer is payload (and maybe the next frame).
      const rest = h.subarray(off);
      this.header = Buffer.alloc(0);
      this.skip = len;
      buf = rest;
    }
    return { frames, bytes };
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
