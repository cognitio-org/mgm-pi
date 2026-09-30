/**
 * How the admin tools reach Outfitter's op registry (outfitter/docs/specs/sysop-tools.md).
 *
 * - In a Drive: agentd's admin socket at OUTFITTER_ADMIN_SOCKET, one JSON object per line.
 *   Request `{"t":"admin.request","reqId","op","args","idempotencyKey"?}`, result
 *   `{"t":"admin.result","reqId","ok":true,"text"}` or `{"ok":false,"error","needsApproval"?}`.
 *   agentd forwards it over its API link; the API runs the op as the session's owner, and holds a
 *   delete until the owner approves it in the web UI, so a write may wait minutes.
 * - On a laptop: POST /api/admin/ops on OUTFITTER_API with OUTFITTER_TOKEN (a Dongle), the same
 *   pair teleport uses. `confirmed` is sent only after the person said yes in the TUI.
 * - Neither: no transport, and the extension registers no admin tools.
 *
 * Reads are retried once if the socket closes; writes carry one idempotency key and are not.
 */
import { randomUUID } from "node:crypto";
import { connect } from "node:net";

export type AdminReply = { ok: true; text: string } | { ok: false; error: string; needsApproval?: boolean };

export interface AdminTransport {
  kind: "drive" | "laptop";
  call(op: string, args: Record<string, unknown>, opts?: { confirmed?: boolean; signal?: AbortSignal }): Promise<AdminReply>;
}

export type FetchFn = typeof fetch;

const READ_ACTIONS = /\.(list|get|meta|search|transcript)$/;
/** A write can wait for the owner's approval card (10 min on the API side). */
const WRITE_TIMEOUT_MS = 11 * 60_000;
const READ_TIMEOUT_MS = 30_000;
const MAX_REPLY = 4 * 1024 * 1024;

export function isReadOp(op: string): boolean {
  return READ_ACTIONS.test(op);
}

function reply(msg: any): AdminReply {
  if (msg?.ok === true) return { ok: true, text: typeof msg.text === "string" ? msg.text : "" };
  const error = typeof msg?.error === "string" && msg.error.trim() ? msg.error.trim() : "admin request failed";
  return msg?.needsApproval === true ? { ok: false, error, needsApproval: true } : { ok: false, error };
}

function socketOnce(path: string, frame: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<AdminReply> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const socket = connect(path);
    socket.setEncoding("utf8");
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`no reply after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish(err?: Error, out?: AdminReply) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      if (err) reject(err);
      else resolve(out!);
    }
    socket.on("error", (err) => finish(err));
    socket.on("end", () => finish(Object.assign(new Error("admin socket closed"), { code: "ECONNRESET" })));
    socket.on("connect", () => socket.write(`${JSON.stringify(frame)}\n`, (err) => err && finish(err)));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REPLY) return finish(new Error("reply too large"));
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg: any;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(new Error("invalid reply"));
      }
      if (msg?.t !== "admin.result" || msg.reqId !== frame.reqId) return finish(new Error("mismatched reply"));
      finish(undefined, reply(msg));
    });
  });
}

function closed(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED";
}

function errText(err: unknown): string {
  return err instanceof Error && err.message ? `admin socket: ${err.message}` : "admin socket request failed";
}

export function socketTransport(path: string): AdminTransport {
  return {
    kind: "drive",
    async call(op, args, opts = {}) {
      const read = isReadOp(op);
      const frame: Record<string, unknown> = { t: "admin.request", reqId: randomUUID(), op, args };
      if (!read) frame.idempotencyKey = randomUUID();
      const timeout = read ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
      try {
        return await socketOnce(path, frame, timeout, opts.signal);
      } catch (err) {
        if (!read || !closed(err)) return { ok: false, error: errText(err) };
        try {
          return await socketOnce(path, { ...frame, reqId: randomUUID() }, timeout, opts.signal);
        } catch (err2) {
          return { ok: false, error: errText(err2) };
        }
      }
    },
  };
}

export function httpTransport(apiBase: string, token: string, fetchFn: FetchFn = fetch): AdminTransport {
  const base = apiBase.replace(/\/+$/, "");
  return {
    kind: "laptop",
    async call(op, args, opts = {}) {
      let res: Response;
      try {
        res = await fetchFn(`${base}/api/admin/ops`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ op, args, ...(opts.confirmed ? { confirmed: true } : {}) }),
          signal: opts.signal ?? AbortSignal.timeout(isReadOp(op) ? READ_TIMEOUT_MS : 60_000),
        });
      } catch (err) {
        return { ok: false, error: `Outfitter unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (res.status === 401) return { ok: false, error: "OUTFITTER_TOKEN was rejected; create a new one on the Outfitter Tokens page" };
      if (res.status === 404) return { ok: false, error: "this Outfitter has no admin ops yet (needs a newer release)" };
      if (!res.ok) return { ok: false, error: `Outfitter answered ${res.status}` };
      try {
        return reply(await res.json());
      } catch {
        return { ok: false, error: "Outfitter sent an invalid reply" };
      }
    },
  };
}

/** The transport for this process, or undefined when neither a socket nor a Dongle is set. */
export function adminTransport(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchFn): AdminTransport | undefined {
  const socket = env.OUTFITTER_ADMIN_SOCKET?.trim();
  if (socket) return socketTransport(socket);
  const api = env.OUTFITTER_API?.trim();
  const token = env.OUTFITTER_TOKEN?.trim();
  if (api && token) return httpTransport(api, token, fetchFn);
  return undefined;
}
