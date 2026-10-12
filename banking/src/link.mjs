import http from "node:http";
import https from "node:https";
import { escapeHtml, isLoopback, readCallbackQuery } from "./banking.mjs";

export function waitForCallback({ port, host = "127.0.0.1", expectedState, timeoutMs = 5 * 60 * 1000, tls = null, parse = null }) {
  let settled = false;
  let timer;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const finish = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  const onRequest = (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden.");
      return;
    }
    if ((req.url || "").length > 2048) {
      res.writeHead(414, { "content-type": "text/plain; charset=utf-8" });
      res.end("URL too long.");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed.");
      return;
    }
    const interpret = parse || ((requestUrl) => readCallbackQuery(requestUrl, expectedState));
    const result = interpret(req.url || "/");
    const html = `<!doctype html><meta charset="utf-8"><title>Bank link</title><p>${escapeHtml(result.body)}</p>`;
    res.writeHead(result.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html, () => {
      if (result.code) {
        const userAgent = String(req.headers["user-agent"] || "").replace(/[^\t\x20-\x7e]/g, "").slice(0, 300);
        finish(() => resolveDone({ code: result.code, profileId: result.profileId, userAgent }));
      }
      else if (result.failed) finish(() => rejectDone(new Error(result.body)));
    });
  };
  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, onRequest)
    : http.createServer(onRequest);
  server.on("tlsClientError", () => {});
  server.on("clientError", () => {});

  timer = setTimeout(() => {
    finish(() => rejectDone(new Error("No bank redirect arrived within 5 minutes. Run link again.")));
  }, timeoutMs);

  const ready = new Promise((resolve, reject) => {
    server.once("error", (err) => {
      clearTimeout(timer);
      const wrapped = err.code === "EADDRINUSE"
        ? new Error(`Port ${port} is already in use on this computer. Close the other link command and run link again.`)
        : err;
      reject(wrapped);
    });
    server.listen(port, host, () => resolve());
  });

  return {
    ready,
    done,
    close() {
      clearTimeout(timer);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
