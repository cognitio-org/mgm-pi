/**
 * The guard proxy every tunnel points at (#380): a loopback HTTP server in front of the model
 * server that applies the access rules a second time, whatever the provider's edge did (defence in
 * depth), and keeps silent event streams alive. Folds in ~/localllm/keepalive.mjs (openllm#10,
 * #281), which tunnel.sh ran by hand.
 *
 * In order, per request: the bearer token when one is set (401, compared in constant time and then
 * removed, so the tunnel's gate never reaches the model server), the rate limit (a sliding window
 * over the requests that passed the token, 429), the method (GET, HEAD or POST; 405) and the path, which must equal an
 * allow-listed one exactly, query aside (404). Anything percent-encoded, doubled or relative is
 * simply not equal, so there is nothing to normalize and nothing to get wrong.
 *
 * The token goes first because every request arrives from the one local agent, so the window is
 * global: charged before the token, a flood at a leaked URL (the case this layer exists for, an
 * edge policy that is wrong or missing) would spend the router's budget and lock it out. A refused
 * token costs a constant-time compare and nothing else; 16+ characters leave nothing to brute-force.
 *
 * Keep-alive: LM Studio holds a tool call's arguments back and sends them in one chunk once the call
 * is complete, so a long tool call leaves the stream silent for minutes, and ngrok drops a stream
 * after about five minutes of silence. While an event stream is silent, and only between events,
 * this writes an SSE comment (": keep-alive"), which SSE clients ignore.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { checkAllowPaths, checkBearerToken, checkRateLimit } from "./policy.ts";
import { DEFAULT_ALLOW_PATHS, DEFAULT_RATE_LIMIT, TunnelError, type RateLimit } from "./types.ts";

export const KEEPALIVE_MS = 15_000;
const COMMENT = Buffer.from(": keep-alive\n\n");
const METHODS = new Set(["GET", "HEAD", "POST"]);
// Hop-by-hop headers (RFC 9110 §7.6.1) and the proxy's own: never forwarded.
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "upgrade"]);

export interface GuardProxyOptions {
  /** The model server, e.g. `http://127.0.0.1:1234`. Plain http on this machine only. */
  upstream: string;
  allowPaths?: readonly string[];
  rateLimit?: RateLimit;
  bearerToken?: string;
  keepAliveMs?: number;
  /** 0 (default): any free port. */
  port?: number;
  now?: () => number;
  onLog?: (line: string) => void;
}

export interface GuardStats {
  forwarded: number;
  refused: { rate: number; auth: number; method: number; path: number };
  keepAlives: number;
}

export interface GuardProxy {
  /** `http://127.0.0.1:<port>`: what the tunnel provider exposes. */
  readonly url: string;
  readonly port: number;
  stats(): GuardStats;
  close(): Promise<void>;
}

/** Whether a chunk ends an SSE event: a blank line, "\n\n" or "\r\n\r\n". */
export function endsEvent(chunk: Buffer): boolean {
  const tail = chunk.subarray(-4).toString("latin1");
  return tail.endsWith("\n\n") || tail.endsWith("\r\n\r\n");
}

/** A sliding window over the last `windowSeconds`: true when one more request fits. */
export function slidingWindow(limit: RateLimit, now: () => number = Date.now): { take(): boolean; retryAfterSeconds(): number } {
  const hits: number[] = [];
  const windowMs = limit.windowSeconds * 1000;
  const prune = (t: number) => { while (hits.length && hits[0] <= t - windowMs) hits.shift(); };
  return {
    take() {
      const t = now();
      prune(t);
      if (hits.length >= limit.requests) return false;
      hits.push(t);
      return true;
    },
    retryAfterSeconds() {
      const t = now();
      prune(t);
      return hits.length ? Math.max(1, Math.ceil((hits[0] + windowMs - t) / 1000)) : 1;
    },
  };
}

function loopbackUpstream(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new TunnelError("failed", `not a URL: ${raw}`); }
  if (u.protocol !== "http:") throw new TunnelError("failed", `the model server must be plain http on this machine, not ${u.protocol}`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new TunnelError("failed", `the model server must be on this machine (127.0.0.1), not ${u.hostname}`);
  return u;
}

function sendJson(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error: { message } }));
}

export function startGuardProxy(opts: GuardProxyOptions): Promise<GuardProxy> {
  const upstream = loopbackUpstream(opts.upstream);
  const allow = new Set(checkAllowPaths(opts.allowPaths ?? DEFAULT_ALLOW_PATHS));
  const limiter = slidingWindow(checkRateLimit(opts.rateLimit ?? DEFAULT_RATE_LIMIT), opts.now);
  const token = opts.bearerToken === undefined ? undefined : Buffer.from(`Bearer ${checkBearerToken(opts.bearerToken)}`);
  const everyMs = opts.keepAliveMs ?? KEEPALIVE_MS;
  const log = opts.onLog ?? (() => {});
  const stats: GuardStats = { forwarded: 0, refused: { rate: 0, auth: 0, method: 0, path: 0 }, keepAlives: 0 };
  const upstreamHost = upstream.host;
  const upstreamPort = Number(upstream.port || 80);
  const upstreamName = upstream.hostname.replace(/^\[|\]$/g, "");

  const authorized = (header: string | undefined) => {
    if (!token) return true;
    const got = Buffer.from(header ?? "");
    return got.length === token.length && timingSafeEqual(got, token);
  };

  const server = http.createServer((req, res) => {
    if (!authorized(req.headers.authorization)) {
      stats.refused.auth++;
      return sendJson(res, 401, "unauthorized");
    }
    if (!limiter.take()) {
      stats.refused.rate++;
      return sendJson(res, 429, "rate limit exceeded", { "retry-after": String(limiter.retryAfterSeconds()) });
    }
    if (!METHODS.has(req.method ?? "")) {
      stats.refused.method++;
      return sendJson(res, 405, "method not allowed", { allow: "GET, HEAD, POST" });
    }
    const raw = req.url ?? "";
    const q = raw.indexOf("?");
    const path = q < 0 ? raw : raw.slice(0, q);
    if (!allow.has(path)) {
      stats.refused.path++;
      return sendJson(res, 404, "not found");
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k) || (token && k === "authorization")) continue;
      headers[k] = v;
    }
    headers.host = upstreamHost;   // LM Studio and friends expect their own host, as tunnel.sh's --host-header did
    stats.forwarded++;
    const started = Date.now();
    const up = http.request({ host: upstreamName, port: upstreamPort, method: req.method, path: raw, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      if (!String(upRes.headers["content-type"] ?? "").includes("text/event-stream")) {
        upRes.pipe(res);
        return;
      }
      let lastWrite = Date.now();
      // Only a stream that ended its last event (a blank line) may take a comment: one written
      // mid-event would be read as part of that event's data.
      let atBoundary = true;
      let pings = 0;
      const timer = setInterval(() => {
        if (!atBoundary || Date.now() - lastWrite < everyMs) return;
        res.write(COMMENT);
        lastWrite = Date.now();
        pings++;
        stats.keepAlives++;
      }, Math.min(1000, everyMs));
      timer.unref?.();
      upRes.on("data", (chunk: Buffer) => {
        res.write(chunk);
        lastWrite = Date.now();
        atBoundary = endsEvent(chunk);
      });
      upRes.on("end", () => {
        clearInterval(timer);
        res.end();
        log(`${req.method} ${path} stream done in ${Math.round((Date.now() - started) / 1000)}s, ${pings} keep-alive(s)`);
      });
      upRes.on("error", () => { clearInterval(timer); res.destroy(); });
      res.on("close", () => clearInterval(timer));
    });
    up.on("error", (err) => sendJson(res, 502, `model server unreachable: ${err.message}`));
    // The caller hung up (the router aborted, or a hop dropped us): stop the model generating for nobody.
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  });
  server.requestTimeout = 0;           // a long generation is the point; Node's default cuts it at 300 s
  // ngrok's agent pools connections to us. Node's 5 s idle close can race a request ngrok just sent
  // on that socket, and a POST that meets a closed socket comes back as a 502. Outlast its pool.
  server.keepAliveTimeout = 120_000;

  return new Promise((resolve, reject) => {
    server.once("error", (err) => reject(new TunnelError("failed", `guard proxy: ${err.message}`)));
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      let closing: Promise<void> | undefined;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        stats: () => ({ ...stats, refused: { ...stats.refused } }),
        close: () => (closing ??= new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        })),
      });
    });
  });
}
