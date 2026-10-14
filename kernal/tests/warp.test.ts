/** Warp's CLI-agent events: the escape format, the Warp-only gate, and the run lifecycle. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.ts";
import { BACKGROUND_COUNT_EVENT, clip, emitWarp, warpSequence, warpSupported } from "../.pi/extensions/kernal-warp/lib.ts";
import mod from "../.pi/extensions/kernal-warp/index.ts";
import background from "../.pi/extensions/kernal-background/index.ts";

const WARP = { WARP_CLI_AGENT_PROTOCOL_VERSION: "1", WARP_CLIENT_VERSION: "v0.2026.10.08" };
const VARS = ["WARP_CLI_AGENT_PROTOCOL_VERSION", "WARP_CLIENT_VERSION", "TMUX", "OUTFITTER_SESSION_ID"] as const;

/** Parse every Warp event out of captured terminal output. */
function events(out: string): any[] {
  return [...out.matchAll(/\x1b\]777;notify;warp:\/\/cli-agent;(.*?)\x07/g)].map((m) => JSON.parse(m[1]!));
}

const reply = (text: string, stopReason = "stop") => ({ messages: [{ role: "assistant", stopReason, content: [{ type: "text", text }] }] });

describe("warp escape sequence", () => {
  test("is OSC 777 notify with the sentinel and a v1 pi payload", () => {
    const seq = warpSequence("stop", { query: "fix it; now", response: "" }, {});
    assert.ok(seq.startsWith("\x1b]777;notify;warp://cli-agent;"));
    assert.ok(seq.endsWith("\x07"));
    // Empty fields are left out; semicolons in the JSON are fine (Warp re-joins the params).
    assert.deepEqual(events(seq), [{ v: 1, agent: "pi", event: "stop", query: "fix it; now" }]);
  });

  test("is wrapped for tmux passthrough with ESC doubled", () => {
    const seq = warpSequence("stop", {}, { TMUX: "/tmp/tmux-501/default,1,0" });
    assert.ok(seq.startsWith("\x1bPtmux;\x1b\x1b]777;notify;"));
    assert.ok(seq.endsWith("\x07\x1b\\"));
  });

  test("needs both Warp variables", () => {
    assert.equal(warpSupported({}), false);
    assert.equal(warpSupported({ WARP_CLIENT_VERSION: "x" }), false);
    assert.equal(warpSupported({ TERM_PROGRAM: "WarpTerminal", WARP_CLIENT_VERSION: "x" }), false);
    assert.equal(warpSupported(WARP), true);
  });

  test("writes nothing outside Warp, without a TTY, or in a Drive", () => {
    const out = { isTTY: true, text: "", write(s: string) { this.text += s; } };
    emitWarp("stop", {}, {}, out);
    emitWarp("stop", {}, WARP, { ...out, isTTY: false });
    emitWarp("stop", {}, { ...WARP, OUTFITTER_SESSION_ID: "s" }, out);
    assert.equal(out.text, "");
    emitWarp("stop", {}, WARP, out);
    assert.equal(events(out.text).length, 1);
  });

  test("clips whitespace and never splits a surrogate pair", () => {
    assert.equal(clip("a \n\t b"), "a b");
    const cut = clip("x" + "😀".repeat(10), 5);
    assert.equal(cut, "x😀😀😀…");
    // Warp's serde_json rejects a lone surrogate and drops the event.
    assert.doesNotMatch(JSON.stringify(cut), /\\ud[89a-f]/i);
  });
});

describe("kernal-warp extension", () => {
  let saved: Record<string, string | undefined>;
  let written: string;
  let realWrite: typeof process.stdout.write;
  let realTTY: boolean | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
    Object.assign(process.env, WARP);
    written = "";
    realWrite = process.stdout.write;
    realTTY = process.stdout.isTTY;
    (process.stdout as any).isTTY = true;
    process.stdout.write = ((s: string) => { written += s; return true; }) as any;
  });
  afterEach(() => {
    process.stdout.write = realWrite;
    (process.stdout as any).isTTY = realTTY;
    for (const k of VARS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  function load() {
    const pi = makePi();
    mod(pi as any);
    return pi;
  }
  const names = () => events(written).map((e) => e.event);

  test("registers nothing outside Warp", () => {
    delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
    assert.equal(load().handlers.size, 0);
  });

  test("reports a run from prompt to stop", async () => {
    const pi = load();
    const ctx = makeCtx();
    await pi.emit("session_start", {}, ctx);
    await pi.emit("before_agent_start", { prompt: "rename   the\nfoo function" }, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("tool_execution_end", { toolName: "edit" }, ctx);
    await pi.emit("agent_end", reply("Renamed foo to bar."), ctx);
    await pi.emit("agent_settled", {}, ctx);
    const got = events(written);
    assert.deepEqual(names(), ["session_start", "prompt_submit", "tool_complete", "stop"]);
    assert.match(got[0].plugin_version, /^kernal /);
    assert.equal(got[1].query, "rename the foo function");
    assert.equal(got[2].tool_name, "edit");
    assert.equal(got[3].response, "Renamed foo to bar.");
    assert.equal(got[3].background_task_count, undefined);
    assert.ok(got.every((e) => e.agent === "pi" && e.v === 1));
  });

  test("a turn started by a background job is reported, keeping the last prompt", async () => {
    const pi = load();
    const ctx = makeCtx();
    await pi.emit("before_agent_start", { prompt: "start the dev server" }, ctx);
    await pi.emit("agent_start", {}, ctx);
    pi.events.emit(BACKGROUND_COUNT_EVENT, 1);
    await pi.emit("agent_end", reply("Started."), ctx);
    await pi.emit("agent_settled", {}, ctx);
    pi.events.emit(BACKGROUND_COUNT_EVENT, 0);
    // The job ended: kernal-background triggers a turn with no before_agent_start.
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("agent_end", reply("The server exited."), ctx);
    await pi.emit("agent_settled", {}, ctx);
    const got = events(written);
    assert.deepEqual(names(), ["prompt_submit", "stop", "prompt_submit", "stop"]);
    assert.equal(got[1].background_task_count, 1, "Warp keeps the tab working while a job will wake the agent");
    assert.equal(got[2].query, "start the dev server");
    assert.equal(got[3].background_task_count, undefined);
    assert.equal(got[3].response, "The server exited.");
  });

  test("reports a failed run, and an interrupted one as stopped", async () => {
    const pi = load();
    const ctx = makeCtx();
    await pi.emit("before_agent_start", { prompt: "go" }, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limited" }] }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    const got = events(written);
    assert.deepEqual(names(), ["prompt_submit", "stop_failure", "prompt_submit", "stop"]);
    assert.equal(got[1].response, "429 rate limited");
    assert.equal(got[3].response, "Interrupted");
  });

  test("a dialog during a run is a block; one while idle is not", async () => {
    const pi = load();
    const ctx = makeCtx();
    // /connect while idle: the person is driving.
    await pi.emit("ui_prompt_start", { kind: "select", title: "Connect to" }, ctx);
    await pi.emit("ui_prompt_end", { kind: "select" }, ctx);
    assert.deepEqual(names(), []);

    await pi.emit("agent_start", {}, ctx);
    await pi.emit("ui_prompt_start", { kind: "confirm", title: "Allow this write?" }, ctx);
    await pi.emit("ui_prompt_end", { kind: "confirm" }, ctx);
    await pi.emit("ui_prompt_start", { kind: "select", title: "Include the transcript?" }, ctx);
    await pi.emit("ui_prompt_end", { kind: "select" }, ctx);
    const got = events(written);
    assert.deepEqual(names(), ["prompt_submit", "permission_request", "permission_replied", "question_asked", "permission_replied"]);
    assert.equal(got[1].summary, "Allow this write?");
    assert.equal(got[3].summary, "Include the transcript?");
  });

  test("a dialog still open when the run settles sends no late reply", async () => {
    const pi = load();
    const ctx = makeCtx();
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("ui_prompt_start", { kind: "confirm", title: "Allow?" }, ctx);
    await pi.emit("agent_end", reply("Done."), ctx);
    await pi.emit("agent_settled", {}, ctx);
    await pi.emit("ui_prompt_end", { kind: "confirm" }, ctx);
    assert.deepEqual(names(), ["prompt_submit", "permission_request", "stop"]);
  });
});

describe("kernal-background's count for Warp", () => {
  test("counts running batch jobs only: a server runs until stopped", async () => {
    const pi = makePi();
    background(pi as any);
    const counts: number[] = [];
    pi.events.on(BACKGROUND_COUNT_EVENT, (n) => { counts.push(n as number); });
    const tool = pi.toolDefs.find((t) => t.name === "background");
    const ctx = { cwd: process.cwd(), mode: "rpc", ui: {} };
    const run = (params: any) => tool.execute("id", { action: "run", ...params }, undefined, undefined, ctx);
    await run({ kind: "server", command: "sleep 30" });
    await run({ kind: "batch", command: "sleep 30" });
    await new Promise((r) => setTimeout(r, 20));   // pi.events handlers are async-wrapped
    assert.deepEqual(counts, [0, 1]);
    for (const h of pi.handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(counts.at(-1), 0);
  });
});
