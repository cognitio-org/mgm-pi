/**
 * The /admin HTTP server: node:http only (works under Node and pi's Bun-compiled binary), bound to
 * 127.0.0.1 on a port the OS picks. A local config server is an attack surface, so every request
 * passes the same gate before anything else runs:
 *
 *   Host     must be 127.0.0.1:<port> or localhost:<port>    (DNS rebinding)
 *   Origin   absent (curl) or exactly this server             (cross-site requests, CSRF)
 *   token    /api/* needs the per-start random token in the x-mgm-admin-token header. A header, not a
 *            cookie, so a cross-site form or image can never carry it. The page gets it from the URL
 *            fragment, which browsers never send to any server.
 *   writes   POST with application/json only, so a cross-origin write always needs a CORS preflight,
 *            which this server never grants.
 *
 * The static shell (HTML, CSS, JS) holds no data and is served without the token; everything with
 * data in it is under /api. The server stops on stop(), after `idleMs` without a request that was not
 * a background poll, and when the process exits.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { MAX_BODY, POLL_HEADER, TOKEN_HEADER, hostAllowed, originAllowed, tokenMatches } from "./lib.ts";

export type ApiRequest = { method: string; path: string; query: URLSearchParams; body: any };
export type ApiResult = { status?: number; body: unknown };
export type Api = (req: ApiRequest) => Promise<ApiResult>;
export type Asset = { type: string; body: string };

export type AdminServer = {
  url: string; port: number; token: string; startedAt: number; idleMs: number;
  /** Milliseconds until the idle stop. */
  idleRemaining(): number;
  stop(reason?: string): Promise<void>;
  readonly stopped: boolean;
};

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  // Same-origin script and style only, no inline script, nothing framed, no form posts anywhere.
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8") {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value));

/** The body as text, or undefined when it is over MAX_BODY (the rest is drained, not kept). */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on("end", () => resolve(size > MAX_BODY ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startAdminServer(opts: { api: Api; assets: Record<string, Asset>; idleMs: number; token?: string; onStop?: (reason: string) => void; checkResponse?: (text: string) => boolean }): Promise<AdminServer> {
  const token = opts.token ?? randomBytes(32).toString("base64url");
  let port = 0;
  let lastActivity = Date.now();
  let stopped = false;
  let idleTimer: ReturnType<typeof setInterval> | undefined;

  const server: Server = createServer(async (req, res) => {
    try {
      // 1. the gate: host, origin, fetch metadata
      if (!hostAllowed(req.headers.host, port)) return json(res, 403, { error: "host not allowed" });
      if (!originAllowed(req.headers.origin as string | undefined, port)) return json(res, 403, { error: "cross-origin request refused" });
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") return json(res, 403, { error: "cross-site request refused" });

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const method = (req.method ?? "GET").toUpperCase();

      // 2. the static shell: no data in it, so no token
      if (!url.pathname.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "method not allowed" });
        const asset = opts.assets[url.pathname === "/" ? "/index.html" : url.pathname];
        if (!asset) return json(res, 404, { error: "not found" });
        return send(res, 200, asset.body, asset.type);
      }

      // 3. the API: token on every request, JSON on every write
      if (!tokenMatches(req.headers[TOKEN_HEADER], token)) return json(res, 401, { error: "missing or wrong admin token; reopen the page with /admin" });
      if (method !== "GET" && method !== "POST") return json(res, 405, { error: "method not allowed" });
      let body: any = undefined;
      if (method === "POST") {
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "send application/json" });
        if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) { res.setHeader("connection", "close"); return json(res, 413, { error: "request too large" }); }
        const text = await readBody(req).catch(() => undefined);
        if (text === undefined) return json(res, 413, { error: "request too large" });
        try { body = text ? JSON.parse(text) : {}; } catch { return json(res, 400, { error: "invalid JSON" }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "expected a JSON object" });
      }
      if (req.headers[POLL_HEADER] !== "1") lastActivity = Date.now();
      const result = await opts.api({ method, path: url.pathname.slice(4), query: url.searchParams, body });
      const text = JSON.stringify(result.body ?? null);
      // Last line of defence: a response that would carry a secret in full is not sent.
      if (opts.checkResponse && !opts.checkResponse(text)) return json(res, 500, { error: "response withheld: it would have contained a secret" });
      return send(res, result.status ?? 200, text);
    } catch (e: any) {
      // Messages only; never a request body, which may hold a key.
      return json(res, 500, { error: String(e?.message ?? e).slice(0, 300) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  server.unref?.();   // never the reason the agent stays running

  const stop = async (reason = "stopped") => {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearInterval(idleTimer);
    process.off("exit", onExit);
    await new Promise<void>((resolve) => { server.close(() => resolve()); (server as any).closeAllConnections?.(); });
    opts.onStop?.(reason);
  };
  const onExit = () => { try { (server as any).closeAllConnections?.(); server.close(); } catch {} };
  process.on("exit", onExit);

  idleTimer = setInterval(() => { if (Date.now() - lastActivity >= opts.idleMs) void stop("idle"); }, Math.max(20, Math.min(30_000, Math.floor(opts.idleMs / 4))));
  (idleTimer as any).unref?.();

  return {
    url: `http://127.0.0.1:${port}/`, port, token, startedAt: Date.now(), idleMs: opts.idleMs,
    idleRemaining: () => Math.max(0, opts.idleMs - (Date.now() - lastActivity)),
    stop,
    get stopped() { return stopped; },
  };
}
