// Real end-to-end smoke test (docs/reports/maintainability-review-pr1.md's "e2e is asserted in
// prose but not backed by a test file" finding, EPIC.md E1.2's "done when the local Docker
// provider runs a full turn end to end against a local API"): a real Fastify app (buildApp,
// MemoryStore, dev mode, role "all") listening on a real port, driving a *real built agentd*
// (packages/agentd/dist/src/main.js, spawned by @outfitter/provider-local's InProcessProvider as
// an actual child process) through a full turn over the real WebSocket link -- against
// packages/agentd/test/fake-pi.js standing in for pi (PI_BIN), so this runs with no pi install and
// no Docker.
//
// Requires packages/agentd built first: the root `npm test` does this via its own `pretest` (see
// package.json); running `npm test` inside packages/api alone will skip this test with a clear
// message if the dist isn't there yet.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { InProcessProvider } from "@outfitter/provider-local";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretsBroker, MemorySecretAdmin } from "../src/secrets.ts";
import { buildApp } from "../src/server.ts";
import { seedGuru } from "./helpers.ts";
import { mailIdFor } from "../src/mail.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outfitterRoot = join(here, "..", "..", "..");
const agentdRoot = join(outfitterRoot, "packages", "agentd");
const agentdMain = join(agentdRoot, "dist", "src", "main.js");
const fakePi = join(agentdRoot, "dist", "test", "fake-pi.js");

const TEST_TIMEOUT_MS = 30_000;

/**
 * session.ts's `importSession` dynamically imports `@earendil-works/pi-coding-agent` at run time --
 * deliberately not an agentd dependency (module doc: "only present at runtime inside the sandbox
 * image, /opt/kernal/node_modules"). A real agentd process run outside that image (this test) needs it
 * resolvable some other way. kernal/ is a sibling checkout in this same repo with its own copy
 * (kernal/node_modules), so symlink it into outfitter/node_modules -- ordinary Node module resolution
 * then finds it the same way it would find any other node_modules dependency, with no source-level
 * coupling from agentd to kernal. Returns a skip message if kernal's copy isn't there to link from. */
function ensurePiCodingAgentResolvable(): string | undefined {
  const scope = join(outfitterRoot, "node_modules", "@earendil-works");
  const linkPath = join(scope, "pi-coding-agent");
  if (existsSync(linkPath)) return undefined;

  const mgmCopy = join(outfitterRoot, "..", "kernal", "node_modules", "@earendil-works", "pi-coding-agent");
  if (!existsSync(mgmCopy)) {
    return (
      `@earendil-works/pi-coding-agent is not resolvable from outfitter/ and ${mgmCopy} doesn't ` +
      `exist either -- run "npm install" in kernal/ first`
    );
  }
  mkdirSync(scope, { recursive: true });
  symlinkSync(mgmCopy, linkPath, "dir");
  return undefined;
}

/** Polls `check` every `intervalMs` until it returns a truthy value or `deadline` (Date.now()-based
 * epoch ms) passes; throws `onTimeoutMessage` in the latter case. */
async function waitUntil<T>(
  check: () => Promise<T | undefined | false>,
  deadline: number,
  onTimeoutMessage: string,
  intervalMs = 150,
): Promise<T> {
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(onTimeoutMessage);
}

interface E2eServer {
  store: MemoryStore;
  origin: string;
  children: ChildProcess[];
  workspace: string;
  deadline: number;
}

/** A real listening API with an InProcessProvider that spawns real agentd processes running fake
 * pi. Returns undefined (after t.skip) when the build outputs or pi's session module are missing. */
async function startE2eServer(t: TestContext): Promise<E2eServer | undefined> {
  if (!existsSync(agentdMain)) {
    t.skip(
      `packages/agentd/dist/src/main.js is not built -- run "npm run build --workspace=packages/agentd" ` +
        `(or "npm run build" from outfitter/) before this test`,
    );
    return undefined;
  }
  if (!existsSync(fakePi)) {
    t.skip(`packages/agentd/dist/test/fake-pi.js is not built -- same fix as above`);
    return undefined;
  }
  const piCodingAgentSkipReason = ensurePiCodingAgentResolvable();
  if (piCodingAgentSkipReason) {
    t.skip(piCodingAgentSkipReason);
    return undefined;
  }

  const deadline = Date.now() + TEST_TIMEOUT_MS - 5000; // leave headroom for cleanup

  const config = loadConfig({
    OUTFITTER_DEV: "1",
    OUTFITTER_DEV_TOKEN: "e2e-dev-token",
    AGENT_SA_EMAIL: "agent@test.local",
    MONGODB_URI: "memory",
    // Placeholder; replaced below once the real server is listening and we know its port.
    OUTFITTER_ORIGIN: "http://127.0.0.1",
  } as NodeJS.ProcessEnv);

  const store = new MemoryStore();
  const secretsBroker = new MemorySecretsBroker();
  const secretAdmin = new MemorySecretAdmin();

  const workspace = mkdtempSync(join(tmpdir(), "outfitter-e2e-workspace-"));
  const children: ChildProcess[] = [];
  const capturingSpawn = ((...spawnArgs: Parameters<typeof nodeSpawn>) => {
    const child = nodeSpawn(...spawnArgs);
    children.push(child);
    return child;
  }) as typeof nodeSpawn;

  const provider = new InProcessProvider({
    agentdPath: agentdMain,
    piBin: fakePi,
    workspace,
    spawnFn: capturingSpawn,
  });

  const app = await buildApp({ store, config, provider, secretsBroker, secretAdmin });
  // A real listening socket, not fastify.inject(): the whole point is a real child process
  // dialing a real WebSocket back to this server (docs/protocol.md "agentd <-> api").
  await app.fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = app.fastify.server.address();
  if (!address || typeof address === "string") throw new Error("expected a real TCP listener");
  const origin = `http://127.0.0.1:${address.port}`;
  config.origin = origin; // RunManager/AgentLink hold a reference to this same config object.

  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    app.stopBackgroundTasks();
    await app.fastify.close();
    await store.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  return { store, origin, children, workspace, deadline };
}

test(
  "e2e: POST /api/sessions drives a real agentd through a full turn against a fake pi, over a real WebSocket",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const server = await startE2eServer(t);
    if (!server) return;
    const { store, origin, children, workspace, deadline } = server;

    const guru = await seedGuru(store, { id: "e2e-guru", model: "test/model" });

    const createRes = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guruId: guru.id, prompt: "ping" }),
    });
    assert.equal(createRes.status, 201);
    const { session, run } = (await createRes.json()) as { session: { id: string }; run: { id: string } };

    // Reaches idle twice: once right after agentd spawns fake-pi (before "ping" is delivered, see
    // agentlink.ts's down-message queue draining), and again once fake-pi has answered it. Only the
    // second one has produced an entry, so wait for both idle *and* an assistant entry together.
    await waitUntil(
      async () => {
        const currentRun = await store.runs.findById(run.id);
        const entries = await store.entries.listForSession(session.id);
        return currentRun?.state === "idle" && entries.length > 0 ? { currentRun, entries } : false;
      },
      deadline,
      `run never reached idle with an entry recorded (workspace=${workspace})`,
    );

    const entries = await store.entries.listForSession(session.id);
    assert.equal(entries.length, 1);
    const message = entries[0].entry.message as { role: string; content: Array<{ type: string; text: string }> };
    assert.equal(message.role, "assistant");
    assert.equal(message.content[0]?.text, "pong");

    // Start-up timing (src/startup.ts) from a real agentd: hello.boot, then the `startup` frame once
    // fake-pi answers the readiness probe; the session detail then carries a complete summary.
    const started = await waitUntil(
      async () => {
        const r = await store.runs.findById(run.id);
        return r?.startup?.phases?.some((p) => p.name === "pi ready") ? r : false;
      },
      deadline,
      "the run never recorded agentd's start-up phases",
    );
    const s = started.startup!;
    for (const stamp of [s.wakeAt, s.providerReturnedAt, s.helloAt, s.specSentAt, s.readyAt]) assert.ok(stamp, JSON.stringify(s));
    assert.equal(typeof s.agentd?.bootMs, "number");
    assert.equal(typeof s.agentd?.identityTokenMs, "number");
    const names = s.phases!.map((p) => p.name);
    assert.equal(names[0], "run.spec received");
    assert.ok(names.indexOf("pi spawned") > 0 && names.indexOf("pi spawned") < names.indexOf("pi ready"), JSON.stringify(names));
    const detail = (await (await fetch(`${origin}/api/sessions/${session.id}`)).json()) as { startup: { complete: boolean; totalMs: number; segments: Array<{ id: string; ms: number }> } };
    assert.equal(detail.startup.complete, true);
    assert.deepEqual(detail.startup.segments.map((seg) => seg.id), ["request", "sandbox", "workspace", "pi"]);
    assert.equal(detail.startup.segments.reduce((sum, seg) => sum + seg.ms, 0), detail.startup.totalMs);

    const stopRes = await fetch(`${origin}/api/sessions/${session.id}/stop`, { method: "POST" });
    assert.equal(stopRes.status, 200);

    await waitUntil(
      async () => {
        const currentRun = await store.runs.findById(run.id);
        return currentRun?.state === "stopped" ? currentRun : false;
      },
      deadline,
      "run never reached stopped after POST /stop",
    );

    await waitUntil(
      async () => (children[0] && children[0].exitCode !== null ? children[0] : false),
      deadline,
      "agentd child process never exited after stop",
    );
    assert.equal(children[0]?.exitCode, 0);
  },
);

test(
  "e2e: an agent's outfitter_send wakes a sleeping peer session, and the peer's agentd acks the mail",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const server = await startE2eServer(t);
    if (!server) return;
    const { store, origin, children, deadline } = server;

    const guru = await seedGuru(store, { id: "e2e-guru", model: "test/model" });
    const now = new Date().toISOString();
    await store.sessions.insert({ id: "peer", guruId: guru.id, repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now });

    const createRes = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guruId: guru.id, name: "planner", prompt: "SEND peer review module Y" }),
    });
    assert.equal(createRes.status, 201);
    const { session } = (await createRes.json()) as { session: { id: string } };

    const sendEntry = await waitUntil(
      async () =>
        (await store.entries.listForSession(session.id)).find((e) => e.entry.type === "custom")?.entry,
      deadline,
      "the sender never recorded an outfitter.mail entry",
    );
    const mailId = mailIdFor(session.id, sendEntry.id);

    const acked = await waitUntil(
      async () => {
        const m = await store.mail.findById(mailId);
        return m?.status === "acked" ? m : false;
      },
      deadline,
      "the peer never acked the mail",
    );
    const peerRun = await store.runs.findActiveForSession("peer");
    assert.ok(peerRun, "the peer was woken");
    assert.equal(acked.deliveredRunId, peerRun.id);
    assert.equal(acked.attempts, 2, "one charged wake plus one delivery");
    assert.match(acked.text, /^\[outfitter mail from session "planner" \(.+\)\. .*\]\n<<<mail-([0-9a-f]{12})\nreview module Y\nmail-\1>>>$/);
    assert.equal(children.length, 2, "one agentd for the sender, one for the woken peer");

    await waitUntil(
      async () => (await store.entries.listForSession("peer")).length > 0,
      deadline,
      "the peer's pi never took a turn on the mail",
    );
  },
);
