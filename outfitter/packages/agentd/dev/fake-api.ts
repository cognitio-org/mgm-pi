#!/usr/bin/env node
/**
 * Minimal local stand-in for outfitter-api's agent WebSocket ingress (protocol.md "agentd ⇄ api").
 * Reads a run.spec from a JSON file, serves it to the first agentd that connects and says hello,
 * acks every seq'd frame, prints every up-frame it receives, and -- once the run reports its first
 * `idle` status (pi has started and is waiting for input) -- sends the JSON file's "prompt" field
 * down as a `prompt` message, so a whole turn can be driven end to end without a real outfitter-api.
 * Dev tooling only, not part of the api package. See README.md for the run command.
 *
 * Usage: node dist/dev/fake-api.js <run-spec.json> [port]
 */
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import type { DownMessage, RunSpec, UpMessage } from "../src/protocol.js";

const specPath = process.argv[2];
const port = Number(process.argv[3] ?? process.env.OUTFITTER_FAKE_API_PORT ?? 8787);
if (!specPath) {
  console.error("usage: fake-api.js <run-spec.json> [port]");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(specPath, "utf8")) as RunSpec & { prompt?: string };
const prompt = raw.prompt;
const spec: RunSpec = { ...raw };
delete (spec as any).prompt;

const wss = new WebSocketServer({ port, path: "/agent/ws" });
console.log(`[fake-api] listening on ws://localhost:${port}/agent/ws?run=<runId>`);
console.log(`[fake-api] serving run.spec from ${specPath}${prompt ? `, will auto-prompt: "${prompt}"` : ""}`);

wss.on("connection", (ws: WebSocket, req) => {
  console.log(`[fake-api] agentd connected (${req.url}), auth=${req.headers.authorization ? "present" : "none"}`);
  let sentPrompt = false;

  const send = (msg: DownMessage) => ws.send(JSON.stringify(msg));

  ws.on("message", (data) => {
    let msg: UpMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log("[fake-api] <- (unparseable)", data.toString());
      return;
    }
    console.log("[fake-api] <-", JSON.stringify(msg));

    if (msg.t === "hello") {
      send({ t: "run.spec", ...spec });
      return;
    }
    if ((msg.t === "entry" || msg.t === "event") && typeof msg.seq === "number") {
      send({ t: "ack", seq: msg.seq });
    }
    if (msg.t === "status" && msg.state === "idle" && !sentPrompt && prompt) {
      sentPrompt = true;
      console.log(`[fake-api] -> prompt: ${prompt}`);
      send({ t: "prompt", text: prompt });
    }
    if (msg.t === "bye") {
      console.log(`[fake-api] agentd said bye: ${msg.reason}${msg.message ? ` (${msg.message})` : ""}`);
    }
  });

  ws.on("close", () => console.log("[fake-api] agentd disconnected"));
});
