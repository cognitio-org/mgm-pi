// #499: GET /api/sessions/:id/changes against a live (fake) agentd: the Drive's own diff, per file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";

test("a live Drive's changes come from its diff, split per file, with the last push", async () => {
  const app = await buildTestApp();
  const head = "a".repeat(40);
  const landedAt = "2026-10-07T10:00:00.000Z";
  const { session, runId, runToken } = await makeRunningSession(app, {
    branch: "outfitter/s1",
    baseBranch: "main",
    checkpoint: { branch: "outfitter/s1", head, landed: true, landedAt, at: landedAt },
  });
  const agent = await openAgentSocket(app, runId);
  try {
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    const pending = app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}/changes` });
    const ask = await agent.nextMessage();
    assert.equal(ask.t, "diff");
    agent.send({
      t: "diff.result",
      reqId: ask.reqId,
      base: "main",
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1,2 @@",
        "-a",
        "+b",
        "+c",
        "diff --git a/notes.md b/notes.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/notes.md",
        "@@ -0,0 +1 @@",
        "+hi",
      ].join("\n"),
    });
    const res = await pending;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      source: "drive",
      base: "main",
      branch: "outfitter/s1",
      pushed: { sha: head, at: landedAt },
      truncated: false,
      files: [
        { path: "src/a.ts", status: "M", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
        { path: "notes.md", status: "A", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+hi" },
      ],
    });
    // Within 5 s the same run's diff answers again without asking the Drive (nothing replies to a
    // second ask, so an uncached request would time out and fall back to GitHub).
    const cached = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}/changes` });
    assert.equal(cached.json().source, "drive");
    assert.equal(cached.json().files.length, 2);
    // The old raw-patch route still answers.
    const raw = app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}/diff` });
    const again = await agent.nextMessage();
    agent.send({ t: "diff.result", reqId: again.reqId, base: "main", patch: "" });
    assert.deepEqual((await raw).json(), { base: "main", patch: "" });
  } finally {
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  }
});
