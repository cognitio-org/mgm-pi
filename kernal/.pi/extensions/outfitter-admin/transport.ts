/**
 * How the admin tools reach Outfitter's op registry (outfitter/docs/specs/sysop-tools.md).
 *
 * - In a Drive: agentd's admin socket at OUTFITTER_ADMIN_SOCKET, one JSON object per line.
 *   Request `{"t":"admin.request","reqId","op","args","idempotencyKey"?}`, result
 *   `{"t":"admin.result","reqId","ok":true,"text"}` or `{"ok":false,"error","needsApproval"?}`.
 *   agentd forwards it over its API link; the API runs the op as the session's owner, and holds a
 *   delete until the owner approves it in the web UI, so a write may wait minutes.
 * - On a laptop: POST /api/admin/ops on the link service with this machine's login (`kernal login`),
 *   the same credentials teleport uses (_shared/outfitter-env.ts). `confirmed` is sent only after the person said
 *   yes in the TUI. E9.9: a `memory.*` call also sends `laptop: {sessionId, repo?}`, and an op that
 *   needs the owner's yes in the web app comes back `{needsApproval, approvalId}`; its rerun sends
 *   `approvalId` (outfitter-agentengine/laptop-approval.ts).
 * - Neither: no transport, and the extension registers no admin tools. Inside a Drive
 *   (OUTFITTER_SESSION_ID) it is the socket or nothing, never HTTP.
 *
 * Reads are retried once if the socket closes; writes carry one idempotency key and are not. A
 * write that fails after it was sent may still have run, and the error says so.
 */
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { outfitterBearer, outfitterCredentials, sendWithBearer } from "../_shared/outfitter-env.ts";

/** `approvalId` (E9.9): a laptop op waiting for the owner's yes in the Outfitter web app; `state`:
 * what `approvals.get` says about it (laptop-approval.ts). */
export type AdminReply = { ok: true; text: string; state?: string } | { ok: false; error: string; needsApproval?: boolean; approvalId?: string };

/** E9.9: what a laptop's `memory.*` call is bound to (the API validates both; they only scope). */
export interface LaptopContext {
  /** `laptop:<pi session id>`. */
  sessionId: string;
  /** The working directory's GitHub `owner/name`, lowercased. */
  repo?: string;
}

export interface AdminTransport {
  kind: "drive" | "laptop";
  /** `laptop` goes in the request body next to `args` (HTTP only; a Drive's identity is its session). */
  call(op: string, args: Record<string, unknown>, opts?: { confirmed?: boolean; signal?: AbortSignal; laptop?: LaptopContext; approvalId?: string }): Promise<AdminReply>;
}

export type FetchFn = typeof fetch;

export interface TransportTimeouts {
  readMs?: number;
  writeMs?: number;
}

// `context` (E9): memory.context, the recall read before each prompt.
const READ_ACTIONS = /\.(list|get|meta|search|transcript|context)$/;
const READ_TIMEOUT_MS = 30_000;
/** A Drive write can wait for the owner's approval card (10 min on the API side). */
const DRIVE_WRITE_TIMEOUT_MS = 11 * 60_000;
const LAPTOP_WRITE_TIMEOUT_MS = 60_000;
const MAX_REPLY = 4 * 1024 * 1024;
const MAYBE_APPLIED = "; the write may have been applied, so check with list or get before retrying";

export function isReadOp(op: string): boolean {
  return READ_ACTIONS.test(op);
}

const STATE = /^(pending|approved|denied|expired|used)$/;
const APPROVAL_ID = /^[0-9a-f-]{36}$/;

function reply(msg: any): AdminReply {
  if (msg?.ok === true) {
    const text = typeof msg.text === "string" ? msg.text : "";
    return typeof msg.state === "string" && STATE.test(msg.state) ? { ok: true, text, state: msg.state } : { ok: true, text };
  }
  const error = typeof msg?.error === "string" && msg.error.trim() ? msg.error.trim() : "admin request failed";
  if (msg?.needsApproval !== true) return { ok: false, error };
  return typeof msg.approvalId === "string" && APPROVAL_ID.test(msg.approvalId)
    ? { ok: false, error, needsApproval: true, approvalId: msg.approvalId }
    : { ok: false, error, needsApproval: true };
}

type SocketFailure = Error & { code?: string; sent?: boolean };

function failure(message: string, code?: string, sent = false): SocketFailure {
  return Object.assign(new Error(message), { code, sent });
}

function socketOnce(path: string, frame: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<AdminReply> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure("cancelled", "ABORT_ERR"));
    const socket = connect(path);
    socket.setEncoding("utf8");
    let buf = "";
    let sent = false;
    let settled = false;
    const timer = setTimeout(() => finish(failure(`no reply after ${Math.round(timeoutMs / 1000)}s`, "ETIMEDOUT", sent)), timeoutMs);
    const onAbort = () => finish(failure("cancelled", "ABORT_ERR", sent));
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish(err?: SocketFailure, out?: AdminReply) {
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
    /** Every complete line; blank ones are skipped, like kernal-github's broker. */
    function drain(final: boolean) {
      for (;;) {
        let nl = buf.indexOf("\n");
        if (nl < 0 && final && buf.trim()) nl = buf.length;
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish(failure("invalid reply", undefined, sent));
        }
        if (msg?.t !== "admin.result" || msg.reqId !== frame.reqId) return finish(failure("mismatched reply", undefined, sent));
        return finish(undefined, reply(msg));
      }
    }
    socket.on("error", (err: NodeJS.ErrnoException) => finish(failure(err.message, err.code, sent)));
    const closed = () => {
      drain(true);
      finish(failure("socket closed", "ECONNRESET", sent));
    };
    socket.on("end", closed);
    socket.on("close", closed);
    socket.on("connect", () =>
      socket.write(`${JSON.stringify(frame)}\n`, (err) => {
        if (err) finish(failure(err.message, (err as NodeJS.ErrnoException).code, sent));
        else sent = true;
      }),
    );
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REPLY) return finish(failure("reply too large", undefined, sent));
      drain(false);
    });
  });
}

function retryable(err: unknown): boolean {
  const code = (err as SocketFailure | null)?.code;
  return code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED";
}

function socketError(err: unknown, write: boolean): string {
  const e = err as SocketFailure;
  if (e?.code === "ABORT_ERR") return write && e.sent ? `cancelled${MAYBE_APPLIED}` : "cancelled";
  const base = `admin socket: ${e?.message || "request failed"}`;
  return write && e?.sent ? `${base}${MAYBE_APPLIED}` : base;
}

export function socketTransport(path: string, timeouts: TransportTimeouts = {}): AdminTransport {
  return {
    kind: "drive",
    async call(op, args, opts = {}) {
      const read = isReadOp(op);
      // A Drive never sends `confirmed`: its approval is the owner's web card, asked by the API.
      const frame: Record<string, unknown> = { t: "admin.request", reqId: randomUUID(), op, args };
      if (!read) frame.idempotencyKey = randomUUID();
      const timeout = read ? (timeouts.readMs ?? READ_TIMEOUT_MS) : (timeouts.writeMs ?? DRIVE_WRITE_TIMEOUT_MS);
      try {
        return await socketOnce(path, frame, timeout, opts.signal);
      } catch (err) {
        if (!read || !retryable(err)) return { ok: false, error: socketError(err, !read) };
        try {
          return await socketOnce(path, { ...frame, reqId: randomUUID() }, timeout, opts.signal);
        } catch (err2) {
          return { ok: false, error: socketError(err2, false) };
        }
      }
    },
  };
}

async function errorBody(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" && body.error.length <= 300 ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** `token`: a fixed bearer, or outfitterBearer bound to this process's credentials (which, after a
 * 401, is asked once more with the rejected token; see sendWithBearer). */
export function httpTransport(apiBase: string, token: string | ((rejected?: string) => Promise<string | undefined>), fetchFn: FetchFn = fetch, timeouts: TransportTimeouts = {}): AdminTransport {
  const base = apiBase.replace(/\/+$/, "");
  return {
    kind: "laptop",
    async call(op, args, opts = {}) {
      const read = isReadOp(op);
      const timeout = AbortSignal.timeout(read ? (timeouts.readMs ?? READ_TIMEOUT_MS) : (timeouts.writeMs ?? LAPTOP_WRITE_TIMEOUT_MS));
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        const body = JSON.stringify({
          op,
          args,
          ...(opts.confirmed ? { confirmed: true } : {}),
          ...(opts.laptop ? { laptop: opts.laptop } : {}),
          ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
        });
        res = await sendWithBearer(token, (bearer) =>
          fetchFn(`${base}/api/admin/ops`, {
            method: "POST",
            headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
            body,
            signal,
            redirect: "manual",
          }),
        );
      } catch (err) {
        if (opts.signal?.aborted) return { ok: false, error: read ? "cancelled" : `cancelled${MAYBE_APPLIED}` };
        if (timeout.aborted) return { ok: false, error: `Outfitter did not answer in time${read ? "" : MAYBE_APPLIED}` };
        return { ok: false, error: `Outfitter unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (res.status >= 300 && res.status < 400) {
        return { ok: false, error: "OUTFITTER_API redirected; it should be the link service's origin, not the web UI" };
      }
      if (res.status === 401) {
        return { ok: false, error: "Outfitter refused this machine's login (or OUTFITTER_API is not the link origin); run kernal login" };
      }
      if (res.status === 404) return { ok: false, error: "this Outfitter has no admin ops yet (needs a newer release)" };
      if (!res.ok) return { ok: false, error: (await errorBody(res)) ?? `Outfitter answered ${res.status}` };
      if (!(res.headers?.get?.("content-type") ?? "application/json").includes("json")) {
        return { ok: false, error: "Outfitter sent a page, not JSON; OUTFITTER_API should be the link service's origin" };
      }
      try {
        return reply(await res.json());
      } catch {
        return { ok: false, error: "Outfitter sent an invalid reply" };
      }
    },
  };
}

export type AdminCapability = "admin" | "memory" | "agentEngine";

/**
 * Whether this process may offer the tools for one capability (E9 §3.3). In a Drive, agentd pins
 * OUTFITTER_ADMIN_CAPS to what the tape allows, since it opens the admin socket for memory and Agent
 * Engine too; the API refuses an op the tape lacks either way, so this only keeps tools that would
 * fail out of the prompt. Unset (a laptop, or an agentd from before E9, which opened the socket only
 * for admin tools) means admin only.
 */
export function hasAdminCapability(cap: AdminCapability, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OUTFITTER_ADMIN_CAPS;
  if (raw === undefined) return cap === "admin";
  return raw.split(",").map((s) => s.trim()).includes(cap);
}

/** The transport for this process, or undefined when there is no way in. */
export function adminTransport(env?: NodeJS.ProcessEnv, fetchFn?: FetchFn): AdminTransport | undefined {
  const e = env ?? process.env;
  const socket = e.OUTFITTER_ADMIN_SOCKET?.trim();
  if (socket) return socketTransport(socket);
  // In a Drive the socket is the only way in; never fall back to a laptop login there.
  if (e.OUTFITTER_SESSION_ID) return undefined;
  const creds = outfitterCredentials(env);
  if (creds.api && creds.token) return httpTransport(creds.api, (rejected) => outfitterBearer(creds, rejected), fetchFn);
  return undefined;
}
