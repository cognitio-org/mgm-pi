// E9 PR6: the system under test for the A2A TCK (a2aproject/a2a-tck, run by run-tck.sh and the
// "Outfitter A2A TCK" workflow). The real link-role app (routes/a2a.ts, OutfitterA2AHandler,
// A2ATasks) on a MemoryStore with the NoopProvider, one plain tape and one A2A key; executor.ts
// plays agentd from the TCK's `tck-*` messageId script.
//
// What the TCK asks for that Outfitter itself never produces is scripted here, by messageId prefix
// as in the reference SUT (tck/sut/a2a-python/sut_agent.py): file, url and data artifacts, a
// chunked artifact, and a Message (not a Task) reply. Everything else is the production path.
//
// Env: PORT (default 9797), KEY_FILE (required: the key is written there, mode 0600, never printed).

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Role, type Artifact, type Message, type Part, type SendMessageRequest, type Task, type TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import type { ServerCallContext } from "@a2a-js/sdk/server";
import { buildTestApp, seedGuru } from "../helpers.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../../src/tokens.ts";
import { OutfitterA2AHandler } from "../../src/a2a/handler.ts";
import type { A2ATask } from "../../src/store/types.ts";
import { TckExecutor } from "./executor.ts";

function part(content: Part["content"], extra: Partial<Part> = {}): Part {
  return { content, metadata: undefined, filename: "", mediaType: "", ...extra };
}

function artifact(task: A2ATask, parts: Part[], suffix = "tck"): Artifact {
  return { artifactId: `${task.id}-${suffix}`, name: "tck", description: "", parts, metadata: undefined, extensions: [] };
}

/** Prefix → the artifact the reference SUT adds. Longest prefixes first (file-url before file). */
const SCRIPTED: Array<[string, (task: A2ATask) => Artifact]> = [
  ["tck-artifact-file-url", (t) => artifact(t, [part({ $case: "url", value: "https://example.com/output.txt" }, { filename: "output.txt", mediaType: "text/plain" })])],
  ["tck-artifact-file", (t) => artifact(t, [part({ $case: "raw", value: Buffer.from("tck") }, { filename: "output.txt", mediaType: "text/plain" })])],
  ["tck-stream-artifact-file", (t) => artifact(t, [part({ $case: "raw", value: Buffer.from("tck") }, { filename: "output.txt", mediaType: "text/plain" })])],
  ["tck-artifact-data", (t) => artifact(t, [part({ $case: "data", value: { key: "value", count: 42 } }, { mediaType: "application/json" })])],
];

class TckHandler extends OutfitterA2AHandler {
  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    const message = params.message;
    if (message?.messageId?.startsWith("tck-message-response") && !message.taskId) {
      return {
        messageId: randomUUID(),
        contextId: message.contextId || randomUUID(),
        taskId: "",
        role: Role.ROLE_AGENT,
        parts: [part({ $case: "text", value: "Direct message response" }, { mediaType: "text/plain" })],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      };
    }
    return super.sendMessage(params, context);
  }

  protected artifactsOf(task: A2ATask): Artifact[] {
    if (task.state !== "completed") return [];
    const id = task.messageId ?? "";
    if (id.startsWith("tck-stream-artifact-chunked")) {
      return [artifact(task, [part({ $case: "text", value: "chunk-1 chunk-2" }, { mediaType: "text/plain" })], "chunked")];
    }
    const scripted = SCRIPTED.find(([prefix]) => id.startsWith(prefix));
    return scripted ? [scripted[1](task)] : super.artifactsOf(task);
  }

  protected artifactEvents(task: A2ATask): TaskArtifactUpdateEvent[] {
    if (task.state === "completed" && (task.messageId ?? "").startsWith("tck-stream-artifact-chunked")) {
      const event = (text: string, append: boolean, lastChunk: boolean): TaskArtifactUpdateEvent => ({
        taskId: task.id,
        contextId: task.contextId,
        artifact: artifact(task, [part({ $case: "text", value: text }, { mediaType: "text/plain" })], "chunked"),
        append,
        lastChunk,
        metadata: undefined,
      });
      return [event("chunk-1 ", false, false), event("chunk-2", true, true)];
    }
    return super.artifactEvents(task);
  }
}

const port = Number(process.env.PORT ?? 9797);
const keyFile = process.env.KEY_FILE;
if (!keyFile) throw new Error("KEY_FILE is required");

const app = await buildTestApp(
  {
    OUTFITTER_ROLE: "link",
    OUTFITTER_ORIGIN: `http://localhost:${port}`,
    // The TCK sends far more than a real client, and expects short streams.
    A2A_REQUESTS_PER_MINUTE: "100000",
    A2A_STREAM_POLL_MS: "200",
    A2A_STREAMS_PER_KEY: "50",
  },
  { a2aHandler: (opts) => new TckHandler(opts) },
);
app.fastify.log.level = "warn";
// PR5's A2A tape rule (a2aTapeProblem): an explicit tools list inside A2A_TAPE_TOOLS.
await seedGuru(app.store, { id: "coder", name: "Coder", tools: ["read", "bash", "edit", "write"] });
const token = generateToken();
const now = Date.now();
await app.store.tokens.insert({
  id: randomUUID(),
  ownerEmail: "tck@outfitter.test",
  name: "tck",
  prefix: tokenPrefix(token),
  hash: hashToken(token),
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
  kind: "a2a",
  a2a: { tapes: ["coder"], repos: [], maxConcurrent: 100_000 },
});
writeFileSync(keyFile, token, { mode: 0o600 });

const executor = new TckExecutor(app);
executor.start();
await app.fastify.listen({ port, host: "127.0.0.1" });
console.log(`tck sut listening on ${port}`);

const shutdown = async () => {
  executor.stop();
  app.stopBackgroundTasks();
  await app.fastify.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
