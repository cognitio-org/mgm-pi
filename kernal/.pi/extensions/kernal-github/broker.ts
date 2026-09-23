/**
 * Cloud GitHub broker. One JSON object per line on the Unix socket at OUTFITTER_GITHUB_SOCKET.
 *
 * Request: {"t":"github.request","reqId","op","args","idempotencyKey"?}
 * Result:  {"t":"github.result","reqId","ok":true,"data"} or {"ok":false,"error"}
 *
 * `data` is what `gh` would have printed for that call (the `--json` value, or `{url}` / `{detail}` /
 * `{resolved}` for the commands that print text). github-tools turns it back into that stdout so the
 * model sees the same text as the local path. Reads omit idempotencyKey and are retried once if the
 * socket closes before a result. Writes send one stable key and are not retried.
 *
 * agentd does not pin the session branch into pi's environment (run.ts's overlay is the session id
 * and OUTFITTER_AUTHOR_*, not a branch). OUTFITTER_SESSION_BRANCH is used when a later agentd sets
 * it; otherwise the refusal says "the session branch".
 */
import { randomUUID } from "node:crypto";
import { connect } from "node:net";

const WRITE_OPS = new Set([
  "github_pr.create",
  "github_pr.edit",
  "github_pr.comment",
  "github_pr.reply",
  "github_pr.review",
  "github_pr.resolve",
  "github_pr.merge",
  "github_issue.create",
  "github_issue.comment",
  "github_issue.edit",
  "github_issue.close",
  "github_issue.reopen",
]);

export type BrokerResponse = { ok: true; data: any } | { ok: false; error: string };

export function githubSocketPath(env?: NodeJS.ProcessEnv): string | undefined {
  const raw = (env ?? process.env).OUTFITTER_GITHUB_SOCKET;
  if (typeof raw !== "string") return undefined;
  const path = raw.trim();
  return path || undefined;
}

export function cloudSessionBranch(env?: NodeJS.ProcessEnv): string {
  const named = (env ?? process.env).OUTFITTER_SESSION_BRANCH?.trim() ?? "";
  const branch = named && !/[\r\n]/.test(named) ? named : "the session branch";
  return `this cloud session works on ${branch}`;
}

function errText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "the github broker request failed";
}

/** A dropped connection, not a refusal and not a timeout. Connection refused is not a close. */
function socketClosed(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") return true;
  return err instanceof Error && err.message === "the github broker socket closed";
}

function once(
  socketPath: string,
  op: string,
  args: Record<string, unknown>,
  idempotencyKey: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("the github broker request was cancelled"));
      return;
    }
    const reqId = randomUUID();
    const payload: Record<string, unknown> = { t: "github.request", reqId, op, args };
    if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
    const socket = connect(socketPath);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`the github broker timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => finish(new Error("the github broker request was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(err?: Error, result?: BrokerResponse) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    }

    socket.on("error", (err) => finish(err));
    socket.on("end", () => finish(new Error("the github broker socket closed")));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) finish(err);
      });
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > 16 * 1024 * 1024) {
        finish(new Error("the github broker response is too large"));
        return;
      }
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          finish(new Error("the github broker returned invalid JSON"));
          return;
        }
        if (!msg || msg.t !== "github.result" || msg.reqId !== reqId) {
          finish(new Error("the github broker returned a result that does not match the request"));
          return;
        }
        if (msg.ok === true) {
          finish(undefined, { ok: true, data: msg.data ?? {} });
          return;
        }
        if (msg.ok === false) {
          const error = typeof msg.error === "string" && msg.error.trim() ? msg.error : "the github broker request failed";
          finish(undefined, { ok: false, error });
          return;
        }
        finish(new Error("the github broker returned a result without ok"));
        return;
      }
    });
  });
}

/** One request, then the socket is closed. Reads are retried once on a close; writes are not. */
export async function brokerCall(opts: {
  socketPath: string;
  op: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BrokerResponse> {
  const args = opts.args && typeof opts.args === "object" && !Array.isArray(opts.args) ? opts.args : {};
  const idempotencyKey = WRITE_OPS.has(opts.op) ? randomUUID() : undefined;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    return await once(opts.socketPath, opts.op, args, idempotencyKey, timeoutMs, opts.signal);
  } catch (err) {
    if (idempotencyKey || !socketClosed(err)) return { ok: false, error: errText(err) };
    try {
      return await once(opts.socketPath, opts.op, args, undefined, timeoutMs, opts.signal);
    } catch (err2) {
      return { ok: false, error: errText(err2) };
    }
  }
}
