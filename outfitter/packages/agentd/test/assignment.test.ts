import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { isWarmAssignmentWait, resolveAssignment } from "../src/assignment.js";

test("isWarmAssignmentWait: true only when RUN_ID is absent and OUTFITTER_ASSIGNMENT_DIR is set", () => {
  assert.equal(isWarmAssignmentWait({}), false, "neither set -- the env path's own missing-var error applies");
  assert.equal(isWarmAssignmentWait({ RUN_ID: "run-1" }), false, "RUN_ID present -- env path, even with no dir");
  assert.equal(isWarmAssignmentWait({ OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" }), true);
  assert.equal(
    isWarmAssignmentWait({ RUN_ID: "run-1", OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" }),
    false,
    "RUN_ID already present (e.g. a GKE cold claim) takes the env path even if the dir happens to be set too",
  );
});

test("resolveAssignment: env path (RUN_ID present) resolves immediately and deletes RUN_TOKEN from the env object", async () => {
  const env: NodeJS.ProcessEnv = { RUN_ID: "run-1", RUN_TOKEN: "secret-token", OUTFITTER_API: "https://api.example.com" };
  const result = await resolveAssignment(env);
  assert.deepEqual(result, { runId: "run-1", runToken: "secret-token", apiOrigin: "https://api.example.com", waitedMs: 0 });
  assert.equal(env.RUN_TOKEN, undefined, "RUN_TOKEN is deleted so nothing agentd spawns can inherit it (#45)");
  assert.equal(env.RUN_ID, "run-1", "RUN_ID isn't secret and is left alone, same as before this module existed");
});

test("resolveAssignment: env path throws agentd's original missing-env-var error, checked in the original OUTFITTER_API/RUN_ID/RUN_TOKEN order", async () => {
  await assert.rejects(() => resolveAssignment({}), /agentd: missing required env var OUTFITTER_API/);
  await assert.rejects(() => resolveAssignment({ OUTFITTER_API: "https://api.example.com" }), /agentd: missing required env var RUN_ID/);
  await assert.rejects(
    () => resolveAssignment({ OUTFITTER_API: "https://api.example.com", RUN_ID: "run-1" }),
    /agentd: missing required env var RUN_TOKEN/,
  );
});

test("resolveAssignment: OUTFITTER_ASSIGNMENT_DIR pointing at a directory that doesn't exist on disk at all is treated as empty files (ENOENT), not an error -- only a deadline ends the wait", async () => {
  // Genuinely missing, not just empty: never created, real fs defaults (no injected readFile), so
  // this exercises defaultReadFile's ENOENT->"" path for the whole directory, not only a file
  // inside an existing one (that's the "real files on disk" test further down).
  const missingDir = join(tmpdir(), `outfitter-assignment-missing-${randomBytes(4).toString("hex")}`);
  await assert.rejects(
    () => resolveAssignment({ OUTFITTER_ASSIGNMENT_DIR: missingDir }, { pollMs: 20, deadlineMs: 70 }),
    /agentd: timed out after 70ms waiting for the run assignment/,
  );
});

/** A fake downward-API directory: an in-memory map of filename -> contents, read through the same
 * `readFile(path)` shape resolveAssignment expects. */
function fakeDir(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const readFile = async (path: string): Promise<string> => files.get(path.split("/").pop()!) ?? "";
  return { files, readFile };
}

test("resolveAssignment: file path (GKE warm) polls until run-id and run-token are both non-empty, then resolves with the api file's value", async () => {
  const { files, readFile } = fakeDir({ "run-id": "", "run-token": "", api: "" });
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    now += ms;
    if (now === 300) {
      // Simulates the claim's annotations landing in the pod's downward-API files mid-wait.
      files.set("run-id", "run-warm\n");
      files.set("run-token", "warm-token\n");
      files.set("api", "https://link.example.com\n");
    }
  };
  const result = await resolveAssignment(
    { OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" },
    { readFile, now: () => now, sleep, pollMs: 100 },
  );
  assert.deepEqual(result, { runId: "run-warm", runToken: "warm-token", apiOrigin: "https://link.example.com", waitedMs: 300 });
  assert.deepEqual(sleeps, [100, 100, 100], "polled at the configured interval, three times before the files were non-empty");
});

test("resolveAssignment: an unset annotation's empty file keeps waiting -- only run-id OR only run-token being set isn't enough", async () => {
  const { files, readFile } = fakeDir({ "run-id": "run-warm", "run-token": "", api: "https://link.example.com" });
  let now = 0;
  let sleepCalls = 0;
  const sleep = async (ms: number) => {
    sleepCalls++;
    now += ms;
    if (sleepCalls === 2) files.set("run-token", "warm-token");
  };
  const result = await resolveAssignment(
    { OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" },
    { readFile, now: () => now, sleep, pollMs: 50 },
  );
  assert.equal(result.runToken, "warm-token");
  assert.equal(sleepCalls, 2, "kept polling while run-token was still empty, past the round where run-id alone was set");
});

test("resolveAssignment: an empty api file falls back to env.OUTFITTER_API", async () => {
  const { readFile } = fakeDir({ "run-id": "run-warm", "run-token": "warm-token", api: "" });
  const result = await resolveAssignment(
    { OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment", OUTFITTER_API: "https://fallback.example.com" },
    { readFile },
  );
  assert.equal(result.apiOrigin, "https://fallback.example.com");
});

test("resolveAssignment: keeps waiting (not a false-positive error) if run-id/run-token are ready before api -- a deadline is what eventually gives up", async () => {
  // Real annotations land together in one downward-API refresh (see the module doc), but the read
  // is 3 separate file reads: an unlucky read could plausibly see run-id/run-token before api. This
  // must not be reported as "missing OUTFITTER_API" -- keep polling instead, same as any other
  // still-empty file, and let deadlineMs (if the caller set one) be what eventually times it out.
  const { readFile } = fakeDir({ "run-id": "run-warm", "run-token": "warm-token", api: "" });
  let now = 0;
  const sleep = async (ms: number) => {
    now += ms;
  };
  await assert.rejects(
    () =>
      resolveAssignment(
        { OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" },
        { readFile, now: () => now, sleep, pollMs: 100, deadlineMs: 250 },
      ),
    /agentd: timed out after 250ms waiting for the run assignment/,
  );
});

test("resolveAssignment: a deadline throws instead of waiting forever when the files never arrive", async () => {
  const { readFile } = fakeDir({ "run-id": "", "run-token": "", api: "" });
  let now = 0;
  const sleep = async (ms: number) => {
    now += ms;
  };
  await assert.rejects(
    () =>
      resolveAssignment(
        { OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" },
        { readFile, now: () => now, sleep, pollMs: 100, deadlineMs: 250 },
      ),
    /agentd: timed out after 250ms waiting for the run assignment under \/etc\/outfitter\/assignment/,
  );
});

test("resolveAssignment: file path never writes anything to the env object it was given", async () => {
  const { readFile } = fakeDir({ "run-id": "run-warm", "run-token": "warm-token", api: "https://link.example.com" });
  const env: NodeJS.ProcessEnv = { OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" };
  const before = { ...env };
  await resolveAssignment(env, { readFile });
  assert.deepEqual(env, before, "RUN_ID/RUN_TOKEN were never in env on this path, so there is nothing to delete, and nothing else is written either");
});

test("resolveAssignment: real files on disk (defaults: fs.readFile, a real setTimeout sleep) -- missing files read as empty, not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-assignment-test-"));
  try {
    const promise = resolveAssignment({ OUTFITTER_ASSIGNMENT_DIR: dir }, { pollMs: 30 });
    // The files don't exist yet at all (not even empty) -- exercises defaultReadFile's ENOENT->"" path.
    await new Promise((resolve) => setTimeout(resolve, 90));
    await writeFile(join(dir, "run-id"), "run-real\n");
    await writeFile(join(dir, "run-token"), "real-token\n");
    await writeFile(join(dir, "api"), "https://link.example.com\n");
    const result = await promise;
    assert.deepEqual(result, { runId: "run-real", runToken: "real-token", apiOrigin: "https://link.example.com", waitedMs: result.waitedMs });
    assert.ok(result.waitedMs >= 60, `expected to have waited at least a couple of poll cycles, got ${result.waitedMs}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAssignment: reports a presence-only heartbeat at the configured interval while still waiting -- never a value", async () => {
  const { files, readFile } = fakeDir({ "run-id": "run-warm", "run-token": "", api: "" });
  let now = 0;
  const sleep = async (ms: number) => {
    now += ms;
  };
  const heartbeats: Array<{ runId: boolean; runToken: boolean; api: boolean }> = [];
  const result = await resolveAssignment(
    { OUTFITTER_ASSIGNMENT_DIR: "/etc/outfitter/assignment" },
    {
      readFile,
      now: () => now,
      sleep,
      pollMs: 100,
      heartbeatMs: 500,
      onHeartbeat: (presence) => {
        heartbeats.push(presence);
        // Only run-id is set so far; let it resolve once the heartbeat itself has fired at least
        // once, so the test doesn't depend on exactly how many polls a 500ms heartbeat spans.
        if (heartbeats.length === 1) {
          files.set("run-token", "warm-token");
          files.set("api", "https://link.example.com");
        }
      },
    },
  );
  assert.equal(result.runToken, "warm-token");
  assert.deepEqual(heartbeats, [{ runId: true, runToken: false, api: false }]);
  // Presence booleans only -- assert the actual secret values never appear anywhere in what was
  // reported (JSON.stringify would surface a leaked string value; a boolean can't leak one).
  assert.ok(!JSON.stringify(heartbeats).includes("warm-token"));
});

test("resolveAssignment: reads through the kubelet's real downward-API layout -- files are symlinks through a `..data` symlink to a timestamped directory, and the atomic swap that updates it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-assignment-kubelet-"));
  try {
    // Initial state: the kubelet always creates the full layout, even for an unset annotation (an
    // empty file, not a missing one) -- see deploy/gke/sandbox-template.yaml's downwardAPI volume.
    const initialTarget = join(dir, "..2024_01_01_00_00_00.000000000");
    await mkdir(initialTarget);
    await writeFile(join(initialTarget, "run-id"), "");
    await writeFile(join(initialTarget, "run-token"), "");
    await writeFile(join(initialTarget, "api"), "");
    await symlink(basename(initialTarget), join(dir, "..data"));
    for (const name of ["run-id", "run-token", "api"]) {
      await symlink(join("..data", name), join(dir, name));
    }

    const promise = resolveAssignment({ OUTFITTER_ASSIGNMENT_DIR: dir }, { pollMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Confirms the wait is genuinely reading through the symlinks (not just "no error yet"): still
    // pending, because every value is still empty.
    let settled = false;
    void promise.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false, "should still be waiting -- the initial layout's files are all empty");

    // A claim adopts the pod: the kubelet creates a *new* timestamped directory, writes the updated
    // values into it, then atomically re-points `..data` at it with a single rename (never touching
    // the existing `run-id`/`run-token`/`api` symlinks themselves, which always point through
    // `..data`) -- this is the real mechanism spec §3.5 and this module's own doc describe.
    const newTarget = join(dir, "..2024_01_01_00_00_05.000000000");
    await mkdir(newTarget);
    await writeFile(join(newTarget, "run-id"), "run-kubelet");
    await writeFile(join(newTarget, "run-token"), "kubelet-token");
    await writeFile(join(newTarget, "api"), "https://link.example.com");
    const tmpLink = join(dir, "..data_tmp");
    await symlink(basename(newTarget), tmpLink);
    await rename(tmpLink, join(dir, "..data"));

    const result = await promise;
    assert.deepEqual(result, {
      runId: "run-kubelet",
      runToken: "kubelet-token",
      apiOrigin: "https://link.example.com",
      waitedMs: result.waitedMs,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
