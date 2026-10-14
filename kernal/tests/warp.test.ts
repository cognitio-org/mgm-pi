/** Warp's CLI-agent events: the escape format, the Warp-only gate, and the run lifecycle. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.ts";
import { _resetTmuxCheck, clip, emitWarp, tmuxClientIsWarp, warpSequence, warpSupported } from "../.pi/extensions/kernal-warp/lib.ts";
import { BACKGROUND_COUNT_EVENT } from "../.pi/extensions/kernal-background/jobs.ts";
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

  test("escapes C1 controls, which Warp would read as the end of the sequence", () => {
    const seq = warpSequence("prompt_submit", { query: "a\u009cb\u009dc" }, {});
    assert.doesNotMatch(seq, /[\u0080-\u009f]/);
    assert.equal(events(seq)[0].query, "a\u009cb\u009dc");
  });

  test("inside tmux, writes only while the attached terminal is Warp", () => {
    const out = { isTTY: true, text: "", write(s: string) { this.text += s; } };
    const tmux = { ...WARP, TMUX: "/tmp/tmux-501/default,1,0" };
    emitWarp("stop", {}, tmux, out, () => false);
    assert.equal(out.text, "");
    emitWarp("stop", {}, tmux, out, () => true);
    assert.ok(out.text.startsWith("\x1bPtmux;"));
  });

  test("the tmux check reads client_termtype, and is cached for 10 s", () => {
    _resetTmuxCheck();
    let calls = 0;
    const answer = (s: string) => () => { calls++; return s; };
    assert.equal(tmuxClientIsWarp(answer("Warp(v0.2026.10.08.08.08.stable_01)\n"), 1_000), true);
    assert.equal(tmuxClientIsWarp(answer("ghostty 1.2.0"), 5_000), true, "still cached");
    assert.equal(calls, 1);
    assert.equal(tmuxClientIsWarp(answer("ghostty 1.2.0"), 12_000), false, "re-checked after 10 s");
    _resetTmuxCheck();
    assert.equal(tmuxClientIsWarp(() => { throw new Error("tmux 3.2: unknown format"); }, 0), false);
    assert.equal(tmuxClientIsWarp(answer(""), 20_000), false);
    _resetTmuxCheck();
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

  test("an approval or a tool's dialog during a run is a block; the person's own dialogs are not", async () => {
    const pi = load();
    const ctx = makeCtx();
    const dialog = async (kind: string, title: string) => {
      await pi.emit("ui_prompt_start", { kind, title }, ctx);
      await pi.emit("ui_prompt_end", { kind }, ctx);
    };
    await dialog("select", "Connect to");   // /connect while idle
    assert.deepEqual(names(), []);

    await pi.emit("agent_start", {}, ctx);
    await dialog("confirm", "Allow this write?");
    await dialog("custom", "Voice");   // the voice overlay, opened by the person mid-run
    await pi.emit("tool_execution_start", { toolName: "ask" }, ctx);
    await dialog("select", "Which branch?");
    await pi.emit("tool_execution_end", { toolName: "ask" }, ctx);
    await dialog("select", "Steer");   // after the tool: the person again
    const got = events(written);
    assert.deepEqual(names(), ["prompt_submit", "permission_request", "permission_replied", "question_asked", "permission_replied", "tool_complete"]);
    assert.equal(got[1].summary, "Allow this write?");
    assert.equal(got[3].summary, "Which branch?");
  });

  test("a settle with no run behind it (failed before the agent started) reports nothing", async () => {
    const pi = load();
    const ctx = makeCtx();
    await pi.emit("before_agent_start", { prompt: "first" }, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("agent_end", reply("First answer."), ctx);
    await pi.emit("agent_settled", {}, ctx);
    await pi.emit("before_agent_start", { prompt: "second" }, ctx);
    await pi.emit("agent_settled", {}, ctx);   // no API key: pi settles without starting
    assert.deepEqual(names(), ["prompt_submit", "stop"]);
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
