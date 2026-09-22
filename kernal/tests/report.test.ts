/** kernal-report: redaction, transcript rendering, issue text; and /report against a fake pi with a fake deliverer. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, secretValues, transcriptTail, lastError, issueTitle, issueBody, issueUrlFrom, MAX_BODY_CHARS, type ReportMeta } from "../.pi/extensions/kernal-report/lib.ts";
import { makePi, makeCtx } from "./harness.ts";

const meta = (extra: Partial<ReportMeta> = {}): ReportMeta => ({
  id: "r1", createdAt: "2026-09-20T12:00:00.000Z", reporter: "Matej", kernalVersion: "0.1.5", piVersion: "0.86.1", platform: "darwin 25.6.0 arm64", nodeVersion: "bun 1.3.0",
  cwd: "/Users/matej/proj", sessionId: "s1", sessionFile: "/Users/matej/.kernal/kernal-0.1.5-darwin-arm64/.pi/sessions/s1.jsonl", model: "litellm/gpt-5.4-nano", thinkingLevel: "off",
  packages: ["pi-web-access"], extensions: ["connect", "kernal-report"], ...extra,
});
const entries = [
  { type: "message", message: { role: "user", content: [{ type: "text", text: "tell me a poem" }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "package.json" } }] } },
  { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(2000) }] } },
  { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: '401: {"message":"Missing Authentication header","code":401}', content: [] } },
];

describe("report lib", () => {
  test("redact removes known secret values and secret-looking tokens", () => {
    // Fake keys are assembled at runtime so no key-shaped literal sits in the source for secret
    // scanners to flag (GitGuardian flagged the hex one as a Deepgram key when this file moved).
    const LITELLM = ["sk", "abcdefghijklmnop"].join("-");
    const DEEPGRAM = "0123456789abcdef".repeat(3).slice(0, 40);
    const OPENROUTER = ["sk", "or", "v1", "z".repeat(12)].join("-");
    const GITHUB = ["ghp", "ABCDEFGHIJKLMNOP"].join("_");
    const env = { LITELLM_AGENT_KEY: LITELLM, DEEPGRAM_API_KEY: DEEPGRAM, LMSTUDIO_MODEL: "qwen", SHORT_KEY: "abc", HOME: "/x" };
    const secrets = secretValues(env);
    assert.deepEqual(secrets.sort(), [DEEPGRAM, LITELLM].sort());
    const out = redact(`key ${LITELLM}, Authorization: Bearer ${OPENROUTER}, ${GITHUB}, hex ${DEEPGRAM}, ok text`, secrets);
    assert.ok(!out.includes(LITELLM) && !out.includes(OPENROUTER.slice(0, 13)) && !out.includes(GITHUB.slice(0, 10)) && !out.includes(DEEPGRAM), out);
    assert.match(out, /Bearer \[redacted\]/); assert.ok(out.endsWith("ok text"));
  });
  test("transcriptTail renders roles, tool calls, clipped results and errors; long tails are cut from the front", () => {
    const t = transcriptTail(entries as any);
    assert.match(t, /^\[user\] tell me a poem/);
    assert.match(t, /\[assistant\] → read\(\{"path":"package.json"\}\)/);
    assert.match(t, /\[tool read\] x{600}… \(1400 more chars\)/);
    assert.match(t, /\[assistant ERROR: 401: .*Missing Authentication header/);
    const cut = transcriptTail(entries as any, 40, 100);
    assert.match(cut, /^… \(earlier \d+ chars omitted\)\n/); assert.ok(cut.length < 160);
    assert.equal(transcriptTail([]), "");
  });
  test("lastError finds the most recent failed assistant turn", () => {
    assert.match(lastError(entries as any)!, /Missing Authentication header/);
    assert.equal(lastError(entries.slice(0, 3) as any), undefined);
  });
  test("issueTitle and issueBody", () => {
    assert.equal(issueTitle("Voice stopped working\nmore", meta()), "[kernal 0.1.5] Voice stopped working (Matej)");
    assert.equal(issueTitle(undefined, meta({ lastError: "401: nope\nstack" })), "[kernal 0.1.5] Error: 401: nope (Matej)");
    assert.equal(issueTitle("", meta()), "[kernal 0.1.5] Problem report (Matej)");
    const body = issueBody("it broke", meta({ lastError: "401: nope", crashes: [{ message: "boom" }] }), "[user] hi");
    for (const s of ["## What went wrong\n\nit broke", "## Last error in the session", "401: nope", "## Recorded crashes", "boom", "| kernal | 0.1.5 |", "| model | litellm/gpt-5.4-nano |", "<details><summary>Transcript", "[user] hi", "Sent with `/report`"]) assert.ok(body.includes(s), s);
    assert.ok(issueBody(undefined, meta(), undefined).includes("_Transcript not included._"));
    assert.ok(issueBody(undefined, meta(), "y".repeat(80_000)).length <= MAX_BODY_CHARS, "fits GitHub's limit");
  });
  test("issueUrlFrom picks the URL out of gh's output", () => {
    assert.equal(issueUrlFrom("Creating issue in mgmonteleone/mgm-pi\n\nhttps://github.com/mgmonteleone/mgm-pi/issues/7\n"), "https://github.com/mgmonteleone/mgm-pi/issues/7");
    assert.equal(issueUrlFrom("nothing"), undefined);
  });
});

describe("report extension", async () => {
  const mod = await import("../.pi/extensions/kernal-report/index.ts");
  function agentDir() {
    const root = mkdtempSync(join(tmpdir(), "kernal-report-")); const dir = join(root, ".pi");
    mkdirSync(join(dir, "extensions", "connect"), { recursive: true }); mkdirSync(join(dir, "extensions", "kernal-report"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["pi-web-access", { source: "npm:pi-memory" }] }));
    writeFileSync(join(root, "VERSION"), "0.1.5\npi 0.86.1\n");
    writeFileSync(join(dir, "crashes.json"), JSON.stringify({ crashes: [{ message: "boom", version: "0.86.1" }] }));
    process.env.PI_CODING_AGENT_DIR = dir; process.env.KERNAL_USER = "Matej"; process.env.LITELLM_AGENT_KEY = "sk-secretsecretsecret";
    return dir;
  }
  const ctxFor = () => {
    const ctx = makeCtx({ hasUI: true, model: { provider: "litellm", id: "gpt-5.4-nano", contextWindow: 128000, maxTokens: 8192 } as any });
    ctx.sessionManager = { getEntries: () => entries.map((e) => ({ ...e, message: { ...e.message, content: e.message.content?.map((c: any) => (c.type === "text" ? { ...c, text: c.text.replace("poem", "poem with key sk-secretsecretsecret") } : c)) } })), getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" };
    ctx.cwd = "/Users/matej/proj"; ctx.thinkingLevel = "off";
    return ctx;
  };

  test("/report gathers the environment, redacts secrets, files the issue and keeps a local copy", async () => {
    const dir = agentDir(); const sent: { title: string; body: string }[] = [];
    const pi = makePi();
    mod.default(pi as any, { deliver: async (title, bodyFile) => { sent.push({ title, body: readFileSync(bodyFile, "utf8") }); return "https://github.com/mgmonteleone/mgm-pi/issues/9"; }, now: () => new Date("2026-09-20T12:00:00Z") });
    const ctx = ctxFor(); ctx.answers.push("Voice stopped working", "Yes, include the transcript");
    await pi.commands.get("report")!.handler("", ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "[kernal 0.1.5] Voice stopped working (Matej)");
    const b = sent[0].body;
    for (const s of ["| kernal | 0.1.5 |", "| pi | 0.86.1 |", "| model | litellm/gpt-5.4-nano |", "| packages | pi-web-access, npm:pi-memory |", "| extensions | connect, kernal-report |", "boom", "Missing Authentication header", "<details><summary>Transcript", "[user] tell me a poem"]) assert.ok(b.includes(s), s);
    assert.ok(!b.includes("sk-secretsecretsecret"), "secret from the transcript redacted");
    assert.match(ctx.notices.at(-1)!.msg, /Report sent to Matthew: https:\/\/github\.com\/mgmonteleone\/mgm-pi\/issues\/9/);
    assert.equal(pi.entries.at(-1)!.customType, "kernal.report"); assert.equal(pi.entries.at(-1)!.data.url, "https://github.com/mgmonteleone/mgm-pi/issues/9");
    const local = readFileSync(ctx.notices.at(-1)!.msg.split("Local copy: ")[1].trim(), "utf8");
    assert.ok(local.startsWith("# [kernal 0.1.5] Voice stopped working (Matej)")); assert.ok(existsSync(join(dir, "bug-reports")));
    assert.equal(ctx.statuses.get("report"), undefined);
  });

  test("/report with an inline description skips the editor; 'No' leaves the transcript out; cancel writes nothing", async () => {
    agentDir(); const sent: string[] = []; const pi = makePi();
    mod.default(pi as any, { deliver: async (_t, f) => { sent.push(readFileSync(f, "utf8")); return "https://github.com/mgmonteleone/mgm-pi/issues/10"; } });
    const ctx = ctxFor(); ctx.answers.push("No");
    await pi.commands.get("report")!.handler("model keeps timing out", ctx);
    assert.ok(sent[0].includes("model keeps timing out") && sent[0].includes("_Transcript not included._") && !sent[0].includes("<details>"));
    const c2 = ctxFor();   // editor gets no answer → cancelled
    await pi.commands.get("report")!.handler("", c2);
    assert.match(c2.notices.at(-1)!.msg, /cancelled/); assert.equal(sent.length, 1);
  });

  test("when gh fails the report stays local and the user is told where it is", async () => {
    agentDir(); const pi = makePi();
    mod.default(pi as any, { deliver: async () => { throw new Error("gh: not logged in"); } });
    const ctx = ctxFor(); ctx.answers.push("x", "No");
    await pi.commands.get("report")!.handler("", ctx);
    assert.equal(ctx.notices.at(-1)!.type, "error"); assert.match(ctx.notices.at(-1)!.msg, /gh: not logged in.*saved at .*bug-reports/);
    assert.equal(pi.entries.length, 0, "no session entry without delivery");
  });

  test("a failed model turn hints at /report once per session", async () => {
    agentDir(); const pi = makePi(); mod.default(pi as any, { deliver: async () => "u" });
    const ctx = makeCtx({ hasUI: true });
    await pi.emit("agent_end", { messages: [{ role: "user", content: "hi" }, { role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    assert.equal(ctx.notices.length, 0);
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "401" }] }, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "401" }] }, ctx);
    assert.equal(ctx.notices.length, 1); assert.match(ctx.notices[0].msg, /\/report sends the details to Matthew/);
  });
});
