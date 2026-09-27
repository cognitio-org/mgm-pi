// #197: GET /api/sessions/:id/sandbox, .../sandbox/logs and .../sandbox/metrics.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildTestApp, seedGuru } from "./helpers.ts";
import type { Run, Session } from "../src/store/types.ts";
import { TelemetryUnavailable, type SandboxTelemetry } from "../src/sandbox-telemetry.ts";

/** Records what the routes ask for and answers with canned data. */
function fakeTelemetry(opts: { podName?: string; fail?: TelemetryUnavailable } = {}) {
  const calls: { kind: "logs" | "metrics"; arg: string; start?: Date; end?: Date }[] = [];
  const telemetry: SandboxTelemetry = {
    async logs(runId) {
      calls.push({ kind: "logs", arg: runId });
      if (opts.fail) throw opts.fail;
      return { lines: [{ time: "2026-09-26T05:01:10Z", severity: "INFO", message: `line for ${runId}` }], nextPageToken: "older", ...(opts.podName ? { podName: opts.podName } : {}) };
    },
    async metrics(podName, start, end) {
      calls.push({ kind: "metrics", arg: podName, start, end });
      return { memoryMb: [["2026-09-26T05:03:00Z", 1277]], cpuCores: [], diskMb: [] };
    },
  };
  return { telemetry, calls };
}

async function seed(app: Awaited<ReturnType<typeof buildTestApp>>, sessionId: string, runs: Partial<Run>[]) {
  await seedGuru(app.store, { id: `guru-${sessionId}` });
  const now = new Date().toISOString();
  const session: Session = { id: sessionId, guruId: `guru-${sessionId}`, repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now };
  await app.store.sessions.insert(session);
  const inserted: Run[] = [];
  for (const [i, patch] of runs.entries()) {
    const at = new Date(Date.parse("2026-09-26T04:00:00Z") + i * 60_000).toISOString();
    const run: Run = { id: randomUUID(), sessionId, state: "stopped", lastAckedSeq: 0, pending: [], createdAt: at, updatedAt: at, ...patch };
    await app.store.runs.insert(run);
    inserted.push(run);
  }
  return inserted;
}

describe("GET /api/sessions/:id/sandbox (#197)", () => {
  test("reports the latest run's memory and exit, and lists the session's runs newest first", async () => {
    const app = await buildTestApp();
    const [older, latest] = await seed(app, "s-a", [
      { state: "stopped" },
      { state: "failed", reason: "out of memory", sandboxMemLastMb: 1900, sandboxMemPeakMb: 1950, sandboxMemLimitMb: 2048, sandboxExit: { reason: "OOMKilled", exitCode: 137 }, lastSeenAt: "2026-09-26T04:05:00Z" },
    ]);
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s-a/sandbox" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.run.id, latest!.id);
    assert.equal(body.run.reason, "out of memory");
    assert.deepEqual(body.memory, { lastMb: 1900, peakMb: 1950, limitMb: 2048 });
    assert.deepEqual(body.exit, { reason: "OOMKilled", exitCode: 137 });
    assert.equal(body.live, undefined, "a finished run has no live sandbox to describe");
    assert.deepEqual(body.runs.map((r: { id: string }) => r.id), [latest!.id, older!.id]);
    await app.fastify.close();
  });

  test("a runId from another session, or not a UUID, is a 404", async () => {
    const app = await buildTestApp();
    await seed(app, "s-mine", [{}]);
    const [theirs] = await seed(app, "s-theirs", [{}]);
    for (const runId of [theirs!.id, "not-a-uuid", 'x" OR true']) {
      const res = await app.fastify.inject({ method: "GET", url: `/api/sessions/s-mine/sandbox?runId=${encodeURIComponent(runId)}` });
      assert.equal(res.statusCode, 404, runId);
    }
    await app.fastify.close();
  });

  test("a session with no run yet is a 404, and an unknown session too", async () => {
    const app = await buildTestApp();
    await seed(app, "s-empty", []);
    assert.equal((await app.fastify.inject({ method: "GET", url: "/api/sessions/s-empty/sandbox" })).statusCode, 404);
    assert.equal((await app.fastify.inject({ method: "GET", url: "/api/sessions/nope/sandbox" })).statusCode, 404);
    await app.fastify.close();
  });
});

describe("GET /api/sessions/:id/sandbox/logs (#197)", () => {
  test("returns the chosen run's lines, and only ever asks telemetry about this session's run", async () => {
    const { telemetry, calls } = fakeTelemetry();
    const app = await buildTestApp({}, { telemetry });
    const [first, second] = await seed(app, "s-l", [{}, {}]);
    const res = await app.fastify.inject({ method: "GET", url: `/api/sessions/s-l/sandbox/logs?runId=${first!.id}&pageToken=older` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().runId, first!.id);
    assert.equal(res.json().lines[0].message, `line for ${first!.id}`);
    assert.equal(res.json().nextPageToken, "older");
    assert.deepEqual(calls.map((c) => c.arg), [first!.id]);

    const latest = await app.fastify.inject({ method: "GET", url: "/api/sessions/s-l/sandbox/logs" });
    assert.equal(latest.json().runId, second!.id, "no runId means the latest run");
    await app.fastify.close();
  });

  test("telemetry that isn't set up or isn't granted says so, with a status the page can tell apart", async () => {
    const dev = await buildTestApp(); // NoSandboxTelemetry
    await seed(dev, "s-dev", [{}]);
    const notSetUp = await dev.fastify.inject({ method: "GET", url: "/api/sessions/s-dev/sandbox/logs" });
    assert.equal(notSetUp.statusCode, 501);
    assert.equal(notSetUp.json().unavailable, "not-configured");
    await dev.fastify.close();

    const { telemetry } = fakeTelemetry({ fail: new TelemetryUnavailable("forbidden", "not granted yet") });
    const app = await buildTestApp({}, { telemetry });
    await seed(app, "s-f", [{}]);
    const forbidden = await app.fastify.inject({ method: "GET", url: "/api/sessions/s-f/sandbox/logs" });
    assert.equal(forbidden.statusCode, 503);
    assert.equal(forbidden.json().unavailable, "forbidden");
    await app.fastify.close();
  });
});

describe("GET /api/sessions/:id/sandbox/metrics (#197)", () => {
  test("finds the pod from the run's logs and queries its lifetime, starting a little before the run", async () => {
    const { telemetry, calls } = fakeTelemetry({ podName: "outfitter-agent-jjqf6" });
    const app = await buildTestApp({ SANDBOX_PROVIDER: "gke" }, { telemetry });
    const [run] = await seed(app, "s-m", [{ sandboxProvider: "gke", state: "failed", lastSeenAt: "2026-09-26T04:04:30Z" }]);
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s-m/sandbox/metrics" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().podName, "outfitter-agent-jjqf6");
    assert.deepEqual(res.json().series.memoryMb, [["2026-09-26T05:03:00Z", 1277]]);
    const metrics = calls.find((c) => c.kind === "metrics")!;
    assert.equal(metrics.arg, "outfitter-agent-jjqf6");
    assert.equal(metrics.start!.toISOString(), new Date(Date.parse(run!.createdAt) - 120_000).toISOString());
    assert.equal(metrics.end!.toISOString(), "2026-09-26T04:05:30.000Z", "ends a minute after it was last seen");
    await app.fastify.close();
  });

  test("a Cloud Run run has no stats history (501)", async () => {
    const { telemetry, calls } = fakeTelemetry();
    const app = await buildTestApp({}, { telemetry });
    await seed(app, "s-c", [{ sandboxProvider: "cloudrun" }]);
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s-c/sandbox/metrics" });
    assert.equal(res.statusCode, 501);
    assert.equal(calls.length, 0);
    await app.fastify.close();
  });
});
