// #395: run.spec.settings reaches pi through RunController (the one block in run.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunController, type LinkPort } from "../src/run.js";
import { writeSnapshotFile, emptySessionJsonl } from "../src/session.js";
import { RUN_SETTINGS_ENV } from "../src/settings.js";
import type { DownMessage, DownRunSpec, PiRpcEvent, UpMessage } from "../src/protocol.js";
import type { GitOps } from "../src/git.js";
import type { PiProcess, PiProcessOptions } from "../src/pi.js";

class FakeLink implements LinkPort {
  sent: UpMessage[] = [];
  private seq = 1;
  private handler: ((msg: DownMessage) => void) | undefined;
  sendSeq(build: (seq: number) => UpMessage): number {
    const seq = this.seq++;
    this.sent.push(build(seq));
    return seq;
  }
  send(msg: UpMessage): void {
    this.sent.push(msg);
  }
  isOpen(): boolean {
    return true;
  }
  onMessage(handler: (msg: DownMessage) => void): void {
    this.handler = handler;
  }
  setSessionId(): void {}
  deliver(msg: DownMessage): void {
    this.handler?.(msg);
  }
}

const gitOps: GitOps = {
  async clone() {},
  async commitAll() {
    return { committed: false };
  },
  async push() {
    return { head: "deadbeef", pushed: false };
  },
  async diff() {
    return "";
  },
};

function fakePi(): PiProcess {
  return {
    send() {},
    onEvent(_handler: (event: PiRpcEvent) => void) {},
    onStderr() {},
    onExit() {},
    kill() {},
    pid: 1,
  };
}

async function spawnWith(spec: DownRunSpec): Promise<{ opts: PiProcessOptions; logs: string[]; dispose: () => void }> {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-settings-run-"));
  const link = new FakeLink();
  const logs: string[] = [];
  let spawned: PiProcessOptions | undefined;
  const controller = new RunController({
    link,
    gitOps,
    workspace,
    piBin: "pi",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    spawnPi: (opts) => {
      spawned = opts;
      return fakePi();
    },
    importSession: async (_snapshotFile, _cwd, sessionId) => join(workspace, `${sessionId}.jsonl`),
    writeSnapshotFile,
    createTailer: () => ({ start() {}, stop() {}, poll: async () => {} }),
    onLog: (line) => logs.push(line),
  });
  link.deliver(spec);
  const start = Date.now();
  while (!spawned) {
    if (Date.now() - start > 5000) throw new Error("pi was never spawned");
    await new Promise((r) => setTimeout(r, 10));
  }
  return { opts: spawned, logs, dispose: () => controller.dispose() };
}

function baseSpec(overrides: Partial<DownRunSpec> = {}): DownRunSpec {
  return {
    t: "run.spec",
    session: { id: "sess-settings", name: "settings", cwd: "/workspace" },
    repo: { cloneUrl: "file:///dev/null", branch: "outfitter/sess-settings", baseBranch: "main", createBranch: true },
    guru: { model: "" },
    snapshot: { jsonl: emptySessionJsonl("sess-settings", "/workspace") },
    secrets: { litellmKey: "sk-run-key", litellmBaseUrl: "https://router.test/v1" },
    idleStopSeconds: 3600,
    checkpointEvery: "turn",
    ...overrides,
  };
}

test("RunController: the owner's model, thinking and summarizer reach pi when the tape names none", async (t) => {
  const { opts, logs, dispose } = await spawnWith(
    baseSpec({
      settings: {
        schemaVersion: 1,
        profile: null,
        values: {
          "model.default": { value: "litellm/claude-auto-llm", source: "user" },
          "model.thinking": { value: "medium", source: "user" },
          "compaction.summaryModel": { value: "litellm/gpt-5.4-nano", source: "fleet" },
        },
      },
    }),
  );
  t.after(dispose);
  const model = opts.args[opts.args.indexOf("--model") + 1];
  assert.equal(model, "litellm/claude-auto-llm:medium");
  assert.equal(opts.env.KERNAL_SUMMARY_MODEL, "litellm/gpt-5.4-nano");
  assert.ok(JSON.parse(opts.env[RUN_SETTINGS_ENV]!).values["model.default"]);
  // The run key is still pinned after the guru's env.
  assert.equal(opts.env.LITELLM_AGENT_KEY, "sk-run-key");
  assert.ok(logs.some((l) => l.startsWith("settings: applied model.default")));
});

test("RunController: without settings the spec runs as before", async (t) => {
  const { opts, dispose } = await spawnWith(baseSpec({ guru: { model: "fake/model" } }));
  t.after(dispose);
  assert.equal(opts.args[opts.args.indexOf("--model") + 1], "fake/model");
  assert.equal(opts.env[RUN_SETTINGS_ENV], undefined);
  assert.equal(opts.env.KERNAL_SUMMARY_MODEL, undefined);
});
