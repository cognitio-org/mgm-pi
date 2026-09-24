// Spawns the real, built agentd (dist/src/main.js) as a child process -- not a unit test of main.ts
// (it has no exports of its own orchestration to call directly), but the only way to observe what
// PR4 actually changed end to end: the env path is unaffected, a GKE-warm-shaped pod waits idle on
// the downward-API files with no dial-out until claimed, and the "startup:" phase lines PR4/#143
// add (waiting for assignment/assigned/identity token fetched/connected to the link) appear in
// order with no secret ever printed to stdout. Stops short of a real run.spec/RunController turn
// (packages/api/test/e2e.test.ts already covers that, against a real API) -- this only needs a
// bare WebSocket server to observe the Link's "open"/hello.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const agentdMain = join(here, "..", "src", "main.js");
const fakePiPath = join(here, "fake-pi.js");

const WAIT_TIMEOUT_MS = 10_000;

function randomToken(label: string): string {
  return `${label}-${randomBytes(8).toString("hex")}`;
}

interface PhaseLine {
  severity: string;
  message: string;
  elapsedMs: number;
  runId?: string;
}

/** A bare `ws` server: accepts the upgrade and records every frame it receives. Enough to observe
 * Link's "open" (and therefore agentd's "connected to the link" phase) and the `hello` frame,
 * without a real api behind it. */
async function startFakeLink(): Promise<{ port: number; received: unknown[]; close(): Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const received: unknown[] = [];
  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => {
      try {
        received.push(JSON.parse(data.toString()));
      } catch {
        // ignore
      }
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

/** Spawns agentd, capturing stdout as parsed JSON lines (agentd emits one JSON object per line when
 * stdout isn't a TTY -- logger.ts/main.ts's `phase`) and raw lines separately, for the "no secret
 * ever appears in stdout" checks (a leak wouldn't necessarily be valid JSON). */
function spawnAgentd(env: NodeJS.ProcessEnv): { child: ChildProcessByStdio<null, Readable, Readable>; rawLines: string[]; jsonLines: PhaseLine[] } {
  const child = spawn(process.execPath, [agentdMain], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rawLines: string[] = [];
  const jsonLines: PhaseLine[] = [];
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      rawLines.push(line);
      try {
        jsonLines.push(JSON.parse(line));
      } catch {
        // a non-JSON stdout line (shouldn't happen outside a TTY) is still kept in rawLines
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => rawLines.push(`[stderr] ${chunk.toString("utf8")}`));
  return { child, rawLines, jsonLines };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function phaseNames(jsonLines: PhaseLine[]): string[] {
  return jsonLines.filter((l) => l.message.startsWith("startup: ")).map((l) => l.message.replace(/^startup: /, ""));
}

/** `WebSocketServer.close()` waits for every still-connected client socket to close before its
 * callback fires -- it does not force-close them. So a fake link server must never be closed while
 * agentd's own socket to it is still open, or the close hangs forever. Kill (and wait for) the
 * child first, every time, so its socket is already gone by the time a link server is closed. */
function killAndWaitForExit(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

test(
  "agentd (env path, Cloud Run/docker/inprocess shape): startup phases in order, connects and sends hello, no secret ever hits stdout",
  { skip: !existsSync(agentdMain) && "packages/agentd is not built -- run npm run build first" },
  async () => {
    const link = await startFakeLink();
    const runToken = randomToken("run-token");
    const devToken = randomToken("dev-token");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      RUN_ID: "run-env-path",
      RUN_TOKEN: runToken,
      OUTFITTER_API: `http://127.0.0.1:${link.port}`,
      OUTFITTER_DEV_TOKEN: devToken,
      PI_BIN: fakePiPath,
    };
    const { child, rawLines, jsonLines } = spawnAgentd(env);
    try {
      await waitFor(() => link.received.length > 0, "the fake link to receive agentd's hello frame");
      const hello = link.received[0] as Record<string, unknown>;
      assert.equal(hello.t, "hello");
      assert.equal(hello.runId, "run-env-path");
      assert.equal(hello.runToken, runToken, "the run token does travel on the wire -- that's the protocol, not a leak");

      await waitFor(() => phaseNames(jsonLines).includes("connected to the link"), "the connected-to-the-link phase");
      const phases = phaseNames(jsonLines);
      const order = ["main entered", "waiting for assignment", "assigned (waitedMs=0)", "connecting to the link", "connected to the link"];
      let cursor = -1;
      for (const name of order) {
        const idx = phases.indexOf(name);
        assert.ok(idx > cursor, `expected "${name}" after position ${cursor} in ${JSON.stringify(phases)}`);
        cursor = idx;
      }
      assert.ok(
        phases.some((p) => /^identity token fetched \(\d+ms\)$/.test(p)),
        `expected an "identity token fetched (<ms>)" phase in ${JSON.stringify(phases)}`,
      );

      const blob = rawLines.join("\n");
      assert.ok(!blob.includes(runToken), "RUN_TOKEN never appears in agentd's own stdout");
      assert.ok(!blob.includes(devToken), "OUTFITTER_DEV_TOKEN never appears in agentd's own stdout");
    } finally {
      await killAndWaitForExit(child);
      await link.close();
    }
  },
);

test(
  "agentd (GKE warm shape): waits idle on the downward-API files with no dial-out, then resolves once claimed",
  { skip: !existsSync(agentdMain) && "packages/agentd is not built -- run npm run build first" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "outfitter-assignment-"));
    // The template's downward-API volume creates these files empty when the pod is unclaimed
    // (an unset annotation), not missing -- see deploy/gke/sandbox-template.yaml.
    await writeFile(join(dir, "run-id"), "");
    await writeFile(join(dir, "run-token"), "");
    await writeFile(join(dir, "api"), "");

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      OUTFITTER_ASSIGNMENT_DIR: dir,
      // getIdToken falls back to this when the GCE metadata server isn't reachable (true of this
      // test, same as the env-path test above) -- without it, Link's headers() provider rejects and
      // the connect attempt is silently retried with backoff (no log line), which would make this
      // test indistinguishable from a real bug.
      OUTFITTER_DEV_TOKEN: randomToken("dev-token"),
      PI_BIN: fakePiPath,
    };
    const { child, rawLines, jsonLines } = spawnAgentd(env);
    let link: Awaited<ReturnType<typeof startFakeLink>> | undefined;
    try {
      await waitFor(() => phaseNames(jsonLines).includes("waiting for assignment"), "the waiting-for-assignment phase");

      // Give it several poll cycles (default 100ms) to prove it's genuinely idle, not erroring out
      // or trying to reach anything -- exit code null means the process is still alive.
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(child.exitCode, null, "a warm pod that is never claimed stays up, it doesn't exit");
      assert.ok(!phaseNames(jsonLines).includes("connecting to the link"), "no attempt to connect before a run is assigned");

      link = await startFakeLink();
      const runId = "run-warm-path";
      const runToken = randomToken("warm-run-token");

      // Simulates the SandboxClaim's additionalPodMetadata.annotations reaching the pod's
      // downward-API files once a claim adopts this warm pod (spec §3.5 Option B).
      await writeFile(join(dir, "run-id"), runId);
      await writeFile(join(dir, "run-token"), runToken);
      await writeFile(join(dir, "api"), `http://127.0.0.1:${link.port}`);

      await waitFor(() => link!.received.length > 0, "the fake link to receive agentd's hello frame after the claim");
      const hello = link.received[0] as Record<string, unknown>;
      assert.equal(hello.runId, runId);
      assert.equal(hello.runToken, runToken);

      const phases = phaseNames(jsonLines);
      assert.ok(phases.some((p) => /^assigned \(waitedMs=\d+\)$/.test(p)), `expected an "assigned (waitedMs=<n>)" phase in ${JSON.stringify(phases)}`);
      assert.ok(phases.includes("connecting to the link"));

      const blob = rawLines.join("\n");
      assert.ok(!blob.includes(runToken), "the warm run token never appears in agentd's own stdout");
    } finally {
      // Kill agentd (and wait for its socket to actually close) before closing the fake link it may
      // be connected to -- see killAndWaitForExit's doc.
      await killAndWaitForExit(child);
      await link?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
