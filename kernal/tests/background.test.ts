/**
 * kernal-background (#121) against real processes: every terminal state notifies exactly once, a
 * job's process group (grandchildren included) never outlives it, the watchdog stops a job whose pi
 * died without cleanup, and logs stay bounded. No network.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobManager, describeJob, formatDuration, groupHasLiveMembers, type Job } from "../.pi/extensions/kernal-background/jobs.ts";
import { endNotice } from "../.pi/extensions/kernal-background/index.ts";

const trash: string[] = [];
after(() => { for (const d of trash) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "kernal-bg-test-")); trash.push(d); return d; };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(25); }
}
const readPid = async (f: string) => { await until(() => existsSync(f) && readFileSync(f, "utf8").trim() !== ""); return Number(readFileSync(f, "utf8").trim()); };

function manager(extra: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) {
  const ended: Job[] = [];
  const m = new JobManager({ dir: join(dir(), "logs"), graceMs: 500, watchdogIntervalSeconds: 0.2, onEnd: (j) => ended.push(j), ...extra });
  return { m, ended };
}

describe("JobManager", () => {
  test("a batch that exits 0 notifies once, with its output in the log", async () => {
    const { m, ended } = manager();
    const job = m.start({ command: "echo hello; echo world >&2", kind: "batch", cwd: tmpdir(), timeoutSeconds: 30 });
    assert.equal(job.id, "bg1");
    assert.equal(job.status, "running");
    await until(() => ended.length === 1);
    await sleep(100);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].status, "exited");
    assert.equal(ended[0].exitCode, 0);
    assert.equal(m.tail("bg1"), "hello\nworld");
    assert.equal(m.get("bg1")?.status, "exited");
  });

  test("a non-zero exit is failed, with its code", async () => {
    const { m, ended } = manager();
    m.start({ command: "echo boom; exit 3", kind: "batch", cwd: tmpdir(), timeoutSeconds: 30 });
    await until(() => ended.length === 1);
    assert.equal(ended[0].status, "failed");
    assert.equal(ended[0].exitCode, 3);
    assert.match(describeJob(ended[0]), /failed after \d+s \(exit 3\)/);
  });

  test("a quiet server stays running: no output is not death", async () => {
    const { m, ended } = manager();
    const job = m.start({ command: "sleep 30", kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    await sleep(700);
    assert.equal(m.get(job.id)?.status, "running");
    assert.equal(ended.length, 0);
    await m.reapAll();
  });

  test("a deadline stops the whole group, grandchildren included, and says timed out", async () => {
    const { m, ended } = manager();
    const d = dir();
    m.start({ command: `sleep 60 & echo $! > ${d}/gc; wait`, kind: "batch", cwd: tmpdir(), timeoutSeconds: 1 });
    const gc = await readPid(join(d, "gc"));
    assert.ok(alive(gc));
    await until(() => ended.length === 1, 6000);
    assert.equal(ended[0].status, "timed_out");
    await until(() => !alive(gc));
  });

  test("kill stops the group, resolves with the final state, and doesn't notify (the caller reports it)", async () => {
    const { m, ended } = manager();
    const d = dir();
    const job = m.start({ command: `sleep 60 & echo $! > ${d}/gc; sleep 60`, kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const gc = await readPid(join(d, "gc"));
    const done = await m.kill(job.id);
    assert.equal(done.status, "killed");
    assert.ok(done.endedAt);
    await until(() => !alive(gc));
    await sleep(100);
    assert.equal(ended.length, 0);
    assert.equal((await m.kill(job.id)).status, "killed", "killing an ended job just returns it");
  });

  test("kill(id, false) (the person's /jobs kill) notifies once", async () => {
    const { m, ended } = manager();
    const job = m.start({ command: "sleep 60", kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    await m.kill(job.id, false);
    await sleep(100);
    assert.equal(ended.length, 1);
    assert.equal(ended[0].status, "killed");
  });

  test("processes a command leaves behind with & are stopped when it exits, and reported", async () => {
    const { m, ended } = manager();
    const d = dir();
    m.start({ command: `sleep 60 & echo $! > ${d}/gc`, kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const gc = await readPid(join(d, "gc"));
    await until(() => ended.length === 1);
    assert.equal(ended[0].status, "exited");
    assert.equal(ended[0].leftovers, true);
    await until(() => !alive(gc));
    assert.match(endNotice(ended[0], ""), /left processes running in its group/);
  });

  test("the watchdog stops a job whose parent died without any cleanup (pi SIGKILLed)", async () => {
    const parent = spawn("sleep", ["60"], { stdio: "ignore" });
    const { m, ended } = manager({ parentPid: parent.pid });
    const d = dir();
    m.start({ command: `sleep 60 & echo $! > ${d}/gc; sleep 60`, kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const gc = await readPid(join(d, "gc"));
    parent.kill("SIGKILL");
    await until(() => !alive(gc), 6000);
    await until(() => ended.length === 1, 6000);
    assert.notEqual(ended[0].status, "running");
  });

  test("the watchdog escalates to SIGKILL: a job that ignores SIGTERM still dies with its parent", async () => {
    const parent = spawn("sleep", ["60"], { stdio: "ignore" });
    const { m } = manager({ parentPid: parent.pid });
    const d = dir();
    const job = m.start({ command: `trap '' TERM; echo $$ > ${d}/me; sleep 60`, kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const me = await readPid(join(d, "me"));
    parent.kill("SIGKILL");
    await until(() => !alive(me) && !groupHasLiveMembers(job.pid), 8000);
  });

  test("kill escalates to SIGKILL for a job that ignores SIGTERM", async () => {
    const { m } = manager();
    const d = dir();
    const job = m.start({ command: `trap '' TERM; echo $$ > ${d}/me; while :; do sleep 1; done`, kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const me = await readPid(join(d, "me"));
    const done = await m.kill(job.id);
    assert.equal(done.status, "killed");
    await until(() => !alive(me));
  });

  test("stdout and stderr keep their order in the log", async () => {
    const { m, ended } = manager();
    m.start({ command: "echo one; echo two >&2; echo three; echo four >&2", kind: "batch", cwd: tmpdir(), timeoutSeconds: 30 });
    await until(() => ended.length === 1);
    assert.equal(m.tail("bg1"), "one\ntwo\nthree\nfour");
  });

  test("stdin stays open: a command reading it waits instead of seeing EOF", async () => {
    const { m, ended } = manager();
    const job = m.start({ command: "cat; echo eof-seen", kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    await sleep(600);
    assert.equal(m.get(job.id)?.status, "running");
    await m.kill(job.id);
    assert.equal(ended.length, 0);
    assert.doesNotMatch(m.tail(job.id), /eof-seen/);
  });

  test("a spawn failure is an error for the caller, not an uncaught exception", async () => {
    let uncaught: unknown;
    const onUncaught = (err: unknown) => { uncaught = err; };
    process.on("uncaughtException", onUncaught);
    try {
      const { m } = manager({ env: { PATH: "/nonexistent" } });
      assert.throws(() => m.start({ command: "true", kind: "batch", cwd: tmpdir(), timeoutSeconds: 30 }), /could not start bash/);
      await sleep(100);
      assert.equal(uncaught, undefined);
      assert.equal(m.list().length, 0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("groupHasLiveMembers is false for a group that doesn't exist", () => {
    assert.equal(groupHasLiveMembers(2 ** 22 + 12345), false);
  });

  test("reapAll stops every running job without notifying; finished ones are untouched", async () => {
    const { m, ended } = manager();
    m.start({ command: "true", kind: "batch", cwd: tmpdir(), timeoutSeconds: 30 });
    await until(() => ended.length === 1);
    const a = m.start({ command: "sleep 60", kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const b = m.start({ command: "sleep 60", kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const reaped = await m.reapAll();
    assert.deepEqual(reaped.map((j) => j.status).sort(), ["reaped", "reaped"]);
    assert.ok(!alive(a.pid) && !alive(b.pid));
    assert.equal(ended.length, 1);
    assert.equal(m.get("bg1")?.status, "exited");
  });

  test("killAllNow SIGKILLs every running group synchronously (process exit)", async () => {
    const { m } = manager();
    const d = dir();
    m.start({ command: `sleep 60 & echo $! > ${d}/gc; sleep 60`, kind: "server", cwd: tmpdir(), timeoutSeconds: 60 });
    const gc = await readPid(join(d, "gc"));
    m.killAllNow();
    await until(() => !alive(gc));
  });

  test("the log is bounded: it rotates at half the cap, keeps one previous file, and tail spans both", async () => {
    const { m, ended } = manager({ logCapBytes: 4000 });
    const job = m.start({ command: "for i in $(seq 1 1000); do echo line-$i; done", kind: "batch", cwd: tmpdir(), timeoutSeconds: 30 });
    await until(() => ended.length === 1);
    const size = statSync(job.logPath).size + (existsSync(`${job.logPath}.1`) ? statSync(`${job.logPath}.1`).size : 0);
    assert.ok(size <= 4000, `on disk: ${size}`);
    assert.ok(existsSync(`${job.logPath}.1`));
    assert.equal(m.tail(job.id, 3), "line-998\nline-999\nline-1000");
    assert.equal(m.tail(job.id, 5, "line-99"), ["line-995", "line-996", "line-997", "line-998", "line-999"].join("\n"));
  });

  test("bad input is refused before anything starts", () => {
    const { m } = manager();
    assert.throws(() => m.start({ command: "  ", kind: "batch", cwd: tmpdir(), timeoutSeconds: 30 }), /empty/);
    assert.throws(() => m.start({ command: "true", kind: "batch", cwd: "/no/such/dir", timeoutSeconds: 30 }), /does not exist/);
    assert.throws(() => m.tail("bg9"), /no job/);
  });
});

describe("formatting", () => {
  test("durations", () => {
    assert.equal(formatDuration(4_200), "4s");
    assert.equal(formatDuration(192_000), "3m12s");
    assert.equal(formatDuration(3_725_000), "1h02m");
  });

  test("the end notice carries status, tail and log path", () => {
    const job: Job = { id: "bg2", name: "tests", command: "npm test", kind: "batch", cwd: "/w", pid: 1, startedAt: 0, endedAt: 65_000, status: "failed", exitCode: 1, deadlineAt: 0, logPath: "/tmp/bg2.log" };
    const n = endNotice(job, "1 failing");
    assert.match(n, /^Background job bg2 batch "tests": failed after 1m05s \(exit 1\)\./);
    assert.match(n, /Last lines of output:\n1 failing/);
    assert.match(n, /Full log: \/tmp\/bg2\.log/);
  });
});
