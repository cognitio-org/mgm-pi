#!/usr/bin/env node
// Keep-alive shim between ngrok and LM Studio (openllm#10).
//
// LM Studio holds a tool call's arguments back and sends them in one chunk once the call is
// complete, so a long tool call (a report written as one `write` call) leaves the stream silent for
// minutes. A hop between LiteLLM and the laptop drops a stream that has been silent for about five
// minutes. This passes every request through to LM Studio unchanged, and while an event stream is
// silent it writes an SSE comment (": keep-alive") every KEEPALIVE_MS, only between events. SSE
// clients (the OpenAI SDK, LiteLLM, pi) ignore comment lines.
//
//   node keepalive.mjs            # listens on 127.0.0.1:1235, forwards to 127.0.0.1:1234
//   KEEPALIVE_PORT, UPSTREAM_PORT, KEEPALIVE_MS override the defaults.
import http from "node:http";

const PORT = Number(process.env.KEEPALIVE_PORT ?? 1235);
const UPSTREAM = Number(process.env.UPSTREAM_PORT ?? 1234);
const EVERY_MS = Number(process.env.KEEPALIVE_MS ?? 15_000);
const COMMENT = Buffer.from(": keep-alive\n\n");

const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = http.createServer((req, res) => {
  const started = Date.now();
  const upstream = http.request(
    { host: "127.0.0.1", port: UPSTREAM, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      if (!String(up.headers["content-type"] ?? "").includes("text/event-stream")) {
        up.pipe(res);
        return;
      }
      let lastWrite = Date.now();
      // Only a stream that ended its last event (a blank line) may take a comment: one written
      // mid-event would be read as part of that event's data.
      let atBoundary = true;
      let pings = 0;
      const timer = setInterval(() => {
        if (!atBoundary || Date.now() - lastWrite < EVERY_MS) return;
        res.write(COMMENT);
        lastWrite = Date.now();
        pings++;
      }, 1000);
      up.on("data", (chunk) => {
        res.write(chunk);
        lastWrite = Date.now();
        atBoundary = chunk.length >= 2 && chunk[chunk.length - 1] === 0x0a && chunk[chunk.length - 2] === 0x0a;
      });
      up.on("end", () => {
        clearInterval(timer);
        res.end();
        log(`${req.method} ${req.url} stream done in ${Math.round((Date.now() - started) / 1000)}s, ${pings} keep-alive(s)`);
      });
      up.on("error", () => {
        clearInterval(timer);
        res.destroy();
      });
      res.on("close", () => clearInterval(timer));
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `LM Studio unreachable: ${err.message}` } }));
  });
  // The caller hung up (pi aborted, or a hop dropped us): stop LM Studio generating for nobody.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

server.requestTimeout = 0; // a long generation is the point; Node's default would cut it at 300 s
server.listen(PORT, "127.0.0.1", () => log(`keep-alive shim on 127.0.0.1:${PORT} -> 127.0.0.1:${UPSTREAM}, every ${EVERY_MS / 1000}s`));
