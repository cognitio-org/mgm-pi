/**
 * The local hop between the ngrok agent and a Drive's dev server (docs/specs/drive-previews.md).
 * It forwards HTTP and WebSocket upgrades to `127.0.0.1:<port>` and nowhere else, whatever the
 * request says, so a preview can't be turned into a proxy into the cluster or the metadata server.
 *
 * - `Host` becomes `localhost:<port>` (vite, next and webpack reject hosts they don't know);
 *   the public host goes in `X-Forwarded-Host`.
 * - Hop-by-hop headers are dropped both ways; an upgrade keeps `connection`/`upgrade`.
 * - `onActivity` fires for real page requests only (a navigation, or a request that accepts HTML),
 *   never for WebSocket traffic, HMR pings or asset fetches, so an open tab alone doesn't keep a
 *   Drive awake.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "proxy-connection",
]);

export interface LocalPreviewProxyOptions {
  /** The dev server's port on 127.0.0.1. */
  port: number;
  onActivity?: () => void;
  onLog?: (line: string) => void;
}

/** Whether a request is someone looking at a page, as opposed to the page's own background traffic. */
export function isPageRequest(req: Pick<IncomingMessage, "method" | "headers">): boolean {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return false;
  if (String(req.headers.upgrade ?? "") !== "") return false;
  const mode = String(req.headers["sec-fetch-mode"] ?? "");
  if (mode === "navigate") return true;
  if (mode !== "" && mode !== "navigate") return false; // cors / no-cors / websocket: page's own fetches
  return String(req.headers.accept ?? "").includes("text/html");
}

/** Request headers as the dev server should see them. */
export function upstreamHeaders(headers: IncomingHttpHeaders, port: number, upgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const listed = new Set(String(headers.connection ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (key === "host") continue;
    if (HOP_BY_HOP.has(key) || listed.has(key)) {
      if (!(upgrade && (key === "connection" || key === "upgrade"))) continue;
    }
    out[key] = value;
  }
  const publicHost = headers.host;
  if (publicHost && !out["x-forwarded-host"]) out["x-forwarded-host"] = publicHost;
  if (!out["x-forwarded-proto"]) out["x-forwarded-proto"] = "https";
  out.host = `localhost:${port}`;
  if (upgrade) {
    out.connection = "Upgrade";
    // Dev servers that check Origin on the HMR socket expect their own.
    if (out.origin) out.origin = `http://localhost:${port}`;
  }
  return out;
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

export class LocalPreviewProxy {
  port: number | undefined;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly opts: LocalPreviewProxyOptions;

  constructor(opts: LocalPreviewProxyOptions) {
    this.opts = opts;
  }

  get target(): number {
    return this.opts.port;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const target = this.opts.port;
    const onLog = this.opts.onLog ?? (() => {});
    const server = createServer((req, res) => {
      if (isPageRequest(req)) this.opts.onActivity?.();
      const up = httpRequest(
        { host: "127.0.0.1", port: target, method: req.method, path: req.url ?? "/", headers: upstreamHeaders(req.headers, target, false) },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, responseHeaders(upRes.headers));
          upRes.pipe(res);
        },
      );
      up.on("error", (err) => {
        onLog(`preview ${target}: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end(`Nothing answered on port ${target} in the Drive (${err.message}).\n`);
        } else {
          res.destroy();
        }
      });
      req.pipe(up);
    });
    server.on("upgrade", (req, client: Socket, head: Buffer) => {
      this.track(client);
      const upstream = connect(target, "127.0.0.1");
      this.track(upstream);
      upstream.once("connect", () => {
        const headers = upstreamHeaders(req.headers, target, true);
        let raw = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) raw += `${k}: ${one}\r\n`;
        upstream.write(`${raw}\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const close = () => { client.destroy(); upstream.destroy(); };
      upstream.on("error", close);
      client.on("error", close);
      upstream.on("close", close);
      client.on("close", close);
    });
    server.on("connection", (s) => this.track(s));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("preview proxy did not bind");
    this.port = addr.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private track(s: Socket): void {
    this.sockets.add(s);
    s.once("close", () => this.sockets.delete(s));
  }
}
