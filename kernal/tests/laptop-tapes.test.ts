// E9.10 (#354, outfitter/docs/specs/atlas-agent-engine-and-a2a.md §7.1): cloud tapes played on a
// laptop. The tape's data form, the pin store, the review (pin on first play, a diff on change,
// declining keeps the pin, offline plays the pin), what a tape becomes for pi (the shared
// translation, packages, env names only), bin/kernal's --tape, /tape, the Tapes admin page, and the
// coder subagent Kernal ships.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUD_ONLY_FIELDS, diffTapes, formatDiff, installPackages, launchPlan, lineDiff, listPins, missingEnv, npmSpec, packagePlan, parseTape, playing, readPin, repoWarning, reviewTape,
  summaryLines, tapeHash, tapeNpmDir, transportFetch, writePin, type Reviewer, type Tape,
} from "../.pi/extensions/kernal-tape/lib.ts";
import { tapePiArgs } from "../.pi/extensions/_shared/tape-args.ts";
import { terminalReviewer } from "../.pi/extensions/kernal-tape/cli.ts";
import { createTapeApi } from "../.pi/extensions/kernal-tape/admin.ts";
import registerTape, { relaunchEnv } from "../.pi/extensions/kernal-tape/index.ts";
import type { AdminReply, AdminTransport } from "../.pi/extensions/outfitter-admin/transport.ts";
import registerAgentEngine from "../.pi/extensions/outfitter-agentengine/index.ts";
import { repoInfo } from "../.pi/extensions/_shared/repo.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "sk-live-secret-value-0123456789";

const FOREMAN: Tape = {
  id: "foreman",
  name: "Foreman",
  model: "litellm/claude-auto-llm",
  thinking: "high",
  systemPrompt: "Plan the work.\nDelegate edits to coder.\nReview every commit.",
  tools: ["read", "grep", "subagent", "memory", "agent_engine"],
  excludeTools: ["write"],
  memory: "auto",
  agentEngine: true,
  envNames: ["FOREMAN_TOKEN", "HOME_REGION"],
  branchPrefix: "team/",
  mergeFromCloud: true,
  updatedAt: "2026-10-01T10:00:00.000Z",
};

function tmp(prefix = "tapes-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A transport that answers tapes.get/tapes.list from `cloud` (format json, like the api). */
function cloudTransport(cloud: Map<string, Tape | Record<string, unknown>>, opts: { down?: boolean } = {}) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const transport: AdminTransport = {
    kind: "laptop",
    async call(op, args) {
      calls.push({ op, args });
      if (opts.down) return { ok: false, error: "Outfitter unreachable at https://link.example: ECONNREFUSED" } as AdminReply;
      if (op === "tapes.get") {
        const t = cloud.get(String(args.id));
        return t ? { ok: true, text: JSON.stringify({ kind: "tape", format: 1, ...t }) } : { ok: false, error: `no tape "${args.id}"` };
      }
      if (op === "tapes.list") return { ok: true, text: JSON.stringify({ kind: "tapes", format: 1, tapes: [...cloud.values()].map((t: any) => ({ id: t.id, name: t.name, model: t.model, updatedAt: t.updatedAt, memory: t.memory, agentEngine: t.agentEngine })), more: 0 }) };
      return { ok: false, error: "unknown op" };
    },
  };
  return { transport, calls };
}

const fetchFrom = (cloud: Map<string, Tape>) => async (id: string) => {
  const t = cloud.get(id);
  return t ? parseTape(JSON.stringify(t)) : ({ ok: false, error: `no tape "${id}"` } as const);
};

function reviewer(answers: { pin?: boolean; change?: boolean } = {}) {
  const asked: string[] = [];
  const r: Reviewer = {
    async pin(tape, summary) {
      asked.push(`pin:${tape.id}:${summary.length}`);
      return answers.pin ?? false;
    },
    async change(_pin, cloud, changes) {
      asked.push(`change:${cloud.id}:${changes.map((c) => c.field).join(",")}`);
      return answers.change ?? false;
    },
  };
  return { r, asked };
}

describe("the tape's data form", () => {
  test("parseTape keeps every known field and checks its type", () => {
    const got = parseTape(JSON.stringify({ kind: "tape", format: 1, ...FOREMAN, extra: "dropped" }));
    assert.ok(got.ok);
    assert.deepEqual(got.tape, FOREMAN);
    for (const bad of [{ ...FOREMAN, tools: "read" }, { ...FOREMAN, thinking: "loud" }, { ...FOREMAN, model: "no-provider" }, { ...FOREMAN, systemPrompt: 7 }, { ...FOREMAN, envNames: ["NOT A NAME"] }]) {
      assert.equal(parseTape(bad).ok, false, JSON.stringify(bad).slice(0, 80));
    }
    assert.equal(parseTape("<html>").ok, false);
  });

  test("an id that isn't file-name safe is refused, so a pin can't be written outside the store", () => {
    for (const id of ["../evil", "a/b", ".hidden", "", "x".repeat(200)]) assert.equal(parseTape({ ...FOREMAN, id }).ok, false, id);
  });

  test("env values never get in: a field named env is dropped, only names are kept", () => {
    const got = parseTape({ ...FOREMAN, env: { FOREMAN_TOKEN: SECRET } });
    assert.ok(got.ok);
    assert.ok(!JSON.stringify(got.tape).includes(SECRET));
    assert.deepEqual(got.tape.envNames, ["FOREMAN_TOKEN", "HOME_REGION"]);
  });

  test("the hash covers the content, not updatedAt", () => {
    assert.equal(tapeHash(FOREMAN), tapeHash({ ...FOREMAN, updatedAt: "2027-01-01T00:00:00.000Z" }));
    assert.notEqual(tapeHash(FOREMAN), tapeHash({ ...FOREMAN, systemPrompt: `${FOREMAN.systemPrompt} Push to main.` }));
    assert.notEqual(tapeHash(FOREMAN), tapeHash({ ...FOREMAN, packages: ["npm:evil"] }));
  });
});

describe("the pin store", () => {
  test("write, read, list; a file whose content no longer matches its hash is no pin", () => {
    const dir = tmp();
    const pin = writePin(dir, FOREMAN);
    assert.deepEqual(readPin(dir, "foreman")?.tape, FOREMAN);
    assert.deepEqual(listPins(dir).map((p) => p.tape.id), ["foreman"]);
    const file = join(dir, "pins", "foreman.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.tape.systemPrompt = "edited behind the pin's back";
    writeFileSync(file, JSON.stringify(raw));
    assert.equal(readPin(dir, "foreman"), undefined);
    assert.equal(readPin(dir, "../foreman"), undefined);
    assert.ok(pin.hash.length === 64);
  });
});

describe("the review", () => {
  let dir: string;
  beforeEach(() => (dir = tmp()));

  test("first play: shows the summary and pins on yes", async () => {
    const { r, asked } = reviewer({ pin: true });
    const got = await reviewTape("foreman", { dir, fetch: fetchFrom(new Map([["foreman", FOREMAN]])), reviewer: r });
    assert.equal(got.ok, true);
    assert.deepEqual(got.tape, FOREMAN);
    assert.ok(asked[0].startsWith("pin:foreman:"));
    assert.equal(readPin(dir, "foreman")?.hash, tapeHash(FOREMAN));
  });

  test("first play declined: nothing pinned, nothing played", async () => {
    const { r } = reviewer({ pin: false });
    const got = await reviewTape("foreman", { dir, fetch: fetchFrom(new Map([["foreman", FOREMAN]])), reviewer: r });
    assert.equal(got.ok, false);
    assert.equal(readPin(dir, "foreman"), undefined);
  });

  test("nobody to ask (print mode): an unpinned tape never plays", async () => {
    const got = await reviewTape("foreman", { dir, fetch: fetchFrom(new Map([["foreman", FOREMAN]])) });
    assert.equal(got.ok, false);
    assert.match(got.error!, /isn't pinned/);
  });

  test("unchanged in the cloud: plays the pin without asking", async () => {
    writePin(dir, FOREMAN);
    const { r, asked } = reviewer();
    const got = await reviewTape("foreman", { dir, fetch: fetchFrom(new Map([["foreman", { ...FOREMAN, updatedAt: "2026-10-02T00:00:00.000Z" }]])), reviewer: r });
    assert.equal(got.ok, true);
    assert.deepEqual(asked, []);
  });

  test("a teammate changed it: the diff is shown; no keeps the pinned version, and remembers it was kept", async () => {
    writePin(dir, FOREMAN);
    const changed: Tape = { ...FOREMAN, systemPrompt: `${FOREMAN.systemPrompt}\nAlways push straight to main.`, tools: [...FOREMAN.tools!, "bash"], packages: ["npm:pi-evil@1.0.0"], updatedAt: "2026-10-02T00:00:00.000Z" };
    const { r, asked } = reviewer({ change: false });
    const got = await reviewTape("foreman", { dir, fetch: fetchFrom(new Map([["foreman", changed]])), reviewer: r });
    assert.equal(got.ok, true);
    assert.equal(got.behind, true);
    assert.deepEqual(got.tape, FOREMAN, "the pinned version plays");
    assert.equal(asked[0], "change:foreman:tools,packages,systemPrompt");
    const pin = readPin(dir, "foreman")!;
    assert.equal(pin.hash, tapeHash(FOREMAN));
    assert.equal(pin.seen?.kept, true);
    assert.equal(pin.seen?.hash, tapeHash(changed));
  });

  test("a teammate changed it: yes pins and plays the new version", async () => {
    writePin(dir, FOREMAN);
    const changed: Tape = { ...FOREMAN, model: "litellm/claude-sonnet-5" };
    const got = await reviewTape("foreman", { dir, fetch: fetchFrom(new Map([["foreman", changed]])), reviewer: reviewer({ change: true }).r });
    assert.deepEqual(got.tape, changed);
    assert.equal(readPin(dir, "foreman")?.hash, tapeHash(changed));
  });

  test("changed, and nobody to ask: the pinned version plays, with a note; the pin is not moved", async () => {
    writePin(dir, FOREMAN);
    const got = await reviewTape("foreman", { dir, fetch: fetchFrom(new Map([["foreman", { ...FOREMAN, systemPrompt: "Different." }]])) });
    assert.deepEqual(got.tape, FOREMAN);
    assert.match(got.notes.join("\n"), /changed in the cloud; playing the pinned version/);
    assert.equal(readPin(dir, "foreman")?.hash, tapeHash(FOREMAN));
  });

  test("offline: the pinned version plays (exact id only); an unpinned tape doesn't", async () => {
    writePin(dir, FOREMAN);
    const down = async () => ({ ok: false as const, error: "Outfitter unreachable at x", offline: true });
    const got = await reviewTape("foreman", { dir, fetch: down });
    assert.equal(got.ok, true);
    assert.equal(got.offline, true);
    assert.deepEqual(got.tape, FOREMAN);
    assert.equal((await reviewTape("fore", { dir, fetch: down })).ok, false, "no prefix match offline");
    assert.equal((await reviewTape("other", { dir, fetch: down })).ok, false);
    assert.equal((await reviewTape("foreman", { dir })).ok, true, "no Dongle at all: the pin still plays");
  });

  test("Outfitter answered but refused (tape gone, Dongle revoked, unreadable): the pin doesn't play", async () => {
    writePin(dir, FOREMAN);
    const gone = await reviewTape("foreman", { dir, fetch: async () => ({ ok: false as const, error: 'no tape "foreman"' }) });
    assert.equal(gone.ok, false);
    assert.match(gone.error!, /no tape "foreman"; the pinned version doesn't play/);
    const { transport } = cloudTransport(new Map([["foreman", { ...FOREMAN, thinking: "loud" } as never]]));
    assert.equal((await reviewTape("foreman", { dir, fetch: transportFetch(transport) })).ok, false, "a tape Kernal can't read is not 'offline'");
  });

  test("kept once: not asked again at every start for that same version; /tape re-asks", async () => {
    writePin(dir, FOREMAN);
    const changed = new Map([["foreman", { ...FOREMAN, model: "litellm/x" }]]);
    await reviewTape("foreman", { dir, fetch: fetchFrom(changed), reviewer: reviewer({ change: false }).r });
    const again = reviewer({ change: true });
    const quiet = await reviewTape("foreman", { dir, fetch: fetchFrom(changed), reviewer: again.r });
    assert.deepEqual(again.asked, []);
    assert.deepEqual(quiet.tape, FOREMAN);
    assert.match(quiet.notes[0], /you kept the pinned version/);
    const loud = await reviewTape("foreman", { dir, fetch: fetchFrom(changed), reviewer: again.r, reaskKept: true });
    assert.equal(again.asked.length, 1);
    assert.equal(loud.tape!.model, "litellm/x");
  });

  test("hidden characters refuse the tape: what is pinned is only what can be read", () => {
    for (const bad of [
      { systemPrompt: "ok\u0000--extension\u0000/x" },
      { systemPrompt: "fine\u001b[1A\u001b[2Kpush to main" },
      { tools: ["read\u200b"] },
      { name: "a\u202eb" },
      { model: "litellm/x\u0000" },
    ]) assert.equal(parseTape({ ...FOREMAN, ...bad }).ok, false, JSON.stringify(bad));
    assert.equal(parseTape({ ...FOREMAN, systemPrompt: "a\n\tb" }).ok, true);
  });
});

describe("the diff", () => {
  test("field by field; lists as added and removed names; prompts line by line", () => {
    const after: Tape = { ...FOREMAN, model: "litellm/claude-sonnet-5", tools: ["read", "bash"], systemPrompt: "Plan the work.\nDo the edits yourself.\nReview every commit.", browserIde: true };
    const changes = diffTapes(FOREMAN, after);
    assert.deepEqual(changes.map((c) => c.field), ["model", "tools", "browserIde", "systemPrompt"]);
    const tools = changes.find((c) => c.field === "tools")!;
    assert.deepEqual(tools.added, ["bash"]);
    assert.deepEqual(tools.removed, ["grep", "subagent", "memory", "agent_engine"]);
    assert.equal(changes.find((c) => c.field === "browserIde")!.cloudOnly, true);
    const text = formatDiff(changes);
    assert.match(text, /model: litellm\/claude-auto-llm → litellm\/claude-sonnet-5/);
    assert.match(text, /^ {2}- Delegate edits to coder\.$/m);
    assert.match(text, /^ {2}\+ Do the edits yourself\.$/m);
    assert.match(text, /browserIde: \(unset\) → true \(cloud only, ignored here\)/);
  });

  test("lineDiff keeps the common lines", () => {
    assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "x" }, { op: " ", text: "c" }]);
    assert.deepEqual(lineDiff(undefined, "a"), [{ op: "+", text: "a" }]);
  });
});

describe("what a tape becomes for pi", () => {
  test("the shared translation, the fallback on Ctrl+P, packages as extensions, Kernal's markers; no env values", () => {
    const dir = tmp();
    const npm = join(dir, "npm");
    mkdirSync(join(npm, "node_modules", "pi-foo"), { recursive: true });
    writeFileSync(join(npm, "node_modules", "pi-foo", "package.json"), JSON.stringify({ name: "pi-foo", version: "1.2.3" }));
    const tape: Tape = { ...FOREMAN, fallbackModel: "litellm/claude-sonnet-5", appendSystemPrompt: "Be brief.", packages: ["npm:pi-foo@1.2.3", "npm:pi-bar@2.0.0", "npm:pi-range@^1.0.0", "git:github.com/x/y", "npm:pi-subagents"] };
    const plan = launchPlan(tape, packagePlan(tape, npm, ["npm:pi-subagents"]), npm, { HOME_REGION: "eu" });
    const base = tapePiArgs(tape, { appendSystemPrompt: "Be brief." });
    assert.deepEqual(plan.args.slice(0, base.length), base);
    assert.deepEqual(plan.args.slice(base.length), ["--models", "litellm/claude-auto-llm,litellm/claude-sonnet-5", "--extension", join(npm, "node_modules", "pi-foo")]);
    assert.ok(plan.args.includes("--exclude-tools") && plan.args[plan.args.indexOf("--exclude-tools") + 1].includes("memory_read"), "pi-memory's tools out with Agent Engine memory");
    assert.deepEqual(plan.env, { KERNAL_TAPE: "foreman", KERNAL_TAPE_HASH: tapeHash(tape), KERNAL_TAPE_MEMORY: "auto", KERNAL_TAPE_AGENT_ENGINE: "1", KERNAL_TAPE_HTML: "sealed" });
    const notes = plan.notes.join("\n");
    assert.match(notes, /not set here: FOREMAN_TOKEN/);
    assert.doesNotMatch(notes, /HOME_REGION/);
    assert.match(notes, /not installed, so not loaded: pi-bar@2.0.0/);
    assert.match(notes, /exact version are\): npm:pi-range@\^1.0.0, git:github.com\/x\/y/);
    assert.match(notes, /cloud only, ignored here: branchPrefix, mergeFromCloud/);
  });

  test("with a prompt dir, the prompts go to pi as private files holding exactly the reviewed text", () => {
    const dir = tmp();
    const tape: Tape = { ...FOREMAN, systemPrompt: ".env", appendSystemPrompt: "Be brief." };
    const plan = launchPlan(tape, packagePlan(tape, dir), dir, {}, join(dir, "run"));
    const sys = plan.args[plan.args.indexOf("--system-prompt") + 1];
    const app = plan.args[plan.args.indexOf("--append-system-prompt") + 1];
    assert.notEqual(sys, ".env", "never a path pi would read on the tape's word");
    assert.equal(readFileSync(sys, "utf8"), ".env");
    assert.equal(readFileSync(app, "utf8"), "Be brief.");
    assert.equal(statSync(sys).mode & 0o777, 0o600);
  });

  test("no append text: no --append-system-prompt, so pi still finds APPEND_SYSTEM.md", () => {
    const plan = launchPlan({ id: "t", name: "t", model: "a/b" }, packagePlan({ id: "t", name: "t", model: "a/b" }, tmp()), tmp());
    assert.deepEqual(plan.args, ["--model", "a/b"]);
    assert.equal(plan.env.KERNAL_TAPE_MEMORY, "off");
  });

  test("npm specs: names and versions only; nothing that could be a path, a URL or a flag", () => {
    assert.deepEqual(npmSpec("npm:@scope/pkg@^1.2.0"), { spec: "@scope/pkg@^1.2.0", name: "@scope/pkg", version: "^1.2.0" });
    assert.deepEqual(npmSpec("npm:pkg"), { spec: "pkg", name: "pkg" });
    for (const bad of ["pkg", "npm:../x", "npm:-rf", "npm:pkg@1.0 --foo", "npm:git+https://x/y", "npm:pkg@file:../x", "https://x"]) assert.equal(npmSpec(bad), undefined, bad);
  });

  test("installPackages: npm install into the tapes' own dir with install scripts off", async () => {
    const npm = join(tmp(), "npm");
    const runs: { cmd: string; args: string[] }[] = [];
    const res = await installPackages([npmSpec("npm:pi-foo@1.2.3")!], npm, async (cmd, args) => (runs.push({ cmd, args }), { code: 0, output: "" }));
    assert.equal(res.ok, true);
    assert.equal(runs[0].cmd, "npm");
    assert.deepEqual(runs[0].args.slice(0, 4), ["install", "pi-foo@1.2.3", "--prefix", npm]);
    assert.ok(runs[0].args.includes("--ignore-scripts"));
    assert.ok(runs[0].args.includes("--save-exact"));
    assert.notEqual(tapeNpmDir("/t", "a"), tapeNpmDir("/t", "b"), "one npm dir per tape");
    assert.throws(() => tapeNpmDir("/t", "../x"));
    assert.ok(existsSync(join(npm, "package.json")));
  });

  test("the summary names every capability, the env names it expects and the cloud-only fields", () => {
    const text = summaryLines(FOREMAN, { HOME_REGION: "x" }).join("\n");
    assert.match(text, /model: litellm\/claude-auto-llm, thinking high/);
    assert.match(text, /memory: auto/);
    assert.match(text, /agentEngine: on .*Outfitter web page/);
    assert.match(text, /env it expects: FOREMAN_TOKEN, HOME_REGION \(not set here: FOREMAN_TOKEN\)/);
    assert.match(text, /system prompt \(replaces Kernal's\): 3 lines/);
    assert.match(text, /ignored here \(cloud only\): branchPrefix .*mergeFromCloud/);
    assert.deepEqual(missingEnv(FOREMAN, {}), ["FOREMAN_TOKEN", "HOME_REGION"]);
    assert.ok(CLOUD_ONLY_FIELDS.includes("browserIde"));
  });

  test("playing(): only Kernal's own markers, and a memory level it knows", () => {
    assert.equal(playing({}), undefined);
    assert.deepEqual(playing({ KERNAL_TAPE: "foreman", KERNAL_TAPE_HASH: "h", KERNAL_TAPE_MEMORY: "weird", KERNAL_TAPE_AGENT_ENGINE: "1" }), { id: "foreman", hash: "h", memory: "off", agentEngine: true });
  });
});

describe("the terminal review (kernal --tape)", () => {
  test("p shows the full prompts, then the question again; only y pins", async () => {
    const out: string[] = [];
    const answers = ["p", "y"];
    const r = terminalReviewer(async (q) => (out.push(q), answers.shift() ?? ""), (m) => out.push(m));
    assert.equal(await r.pin(FOREMAN, summaryLines(FOREMAN)), true);
    assert.match(out.join("\n"), /Delegate edits to coder/);
    const r2 = terminalReviewer(async () => "", () => {});
    assert.equal(await r2.pin(FOREMAN, []), false, "enter is no");
  });
});

describe("bin/kernal --tape", () => {
  let server: Server;
  let api: string;
  const cloud = new Map<string, Tape>();
  let calls: { op: string; args: any; auth?: string }[] = [];
  beforeEach(async () => {
    calls = [];
    cloud.clear();
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const b = JSON.parse(body || "{}");
        calls.push({ op: b.op, args: b.args, auth: req.headers.authorization });
        const t = cloud.get(String(b.args?.id));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(t ? { ok: true, text: JSON.stringify(t) } : { ok: false, error: "no such tape" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    api = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  /** A bundle-shaped root with the real bin/kernal and extensions, and a fake pi that prints what it got. */
  function bundle(settings: Record<string, unknown> = {}) {
    const top = tmp("kernal-bundle-");
    const r = join(top, "kernal");
    mkdirSync(join(r, "bin"), { recursive: true });
    mkdirSync(join(r, ".pi"), { recursive: true });
    mkdirSync(join(r, "pi"), { recursive: true });
    cpSync(join(root, "bin", "kernal"), join(r, "bin", "kernal"));
    symlinkSync(join(root, ".pi", "extensions"), join(r, ".pi", "extensions"));
    symlinkSync(join(root, "node_modules"), join(r, "node_modules"));
    cpSync(join(root, "agents"), join(r, "agents"), { recursive: true });
    writeFileSync(join(r, ".pi", "settings.json"), JSON.stringify(settings));
    writeFileSync(join(r, "pi", "pi"), `#!/usr/bin/env bash\nnode -e 'console.log("args:" + JSON.stringify(process.argv.slice(1)))' -- "$@"\nenv | grep -E '^(KERNAL_TAPE|PI_MEMORY_DIR|PI_MEMORY_EXIT_SUMMARY|PI_SUBAGENT_EXTRA_AGENT_DIRS|OUTFITTER_TOKEN)' | sed 's/^/env:/' | sort\n`);
    chmodSync(join(r, "pi", "pi"), 0o755);
    return { r, tapes: join(top, "tapes") };
  }

  function run(b: { r: string; tapes: string }, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      execFile("bash", [join(b.r, "bin", "kernal"), ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: tmp("home-"), TMPDIR: tmp("t-"), KERNAL_TAPE_DIR: b.tapes, KERNAL_SKIP_LMS: "1", OUTFITTER_API: api, OUTFITTER_TOKEN: "outf_test_dongle", ...extra },
      }, (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, out: stdout, err: stderr }));
    });
  }

  test("a pinned tape: its flags go before the person's own, Kernal's markers are set, --tape itself is gone", async () => {
    cloud.set("foreman", FOREMAN);
    const b = bundle();
    writePin(b.tapes, FOREMAN);
    const got = await run(b, ["--tape", "foreman", "-c", "hello"]);
    assert.equal(got.code, 0, got.err);
    const args = JSON.parse(got.out.split("\n").find((l) => l.startsWith("args:"))!.slice(5));
    // The prompt goes as a private file with exactly the reviewed text (pi reads a path as a file).
    const sysFile = args[args.indexOf("--system-prompt") + 1];
    assert.equal(readFileSync(sysFile, "utf8"), FOREMAN.systemPrompt);
    assert.deepEqual(args, ["-a", ...tapePiArgs({ ...FOREMAN, systemPrompt: sysFile }, {}), "-c", "hello"]);
    assert.match(got.out, /env:KERNAL_TAPE=foreman/);
    assert.match(got.out, /env:KERNAL_TAPE_MEMORY=auto/);
    assert.match(got.out, /env:KERNAL_TAPE_AGENT_ENGINE=1/);
    assert.match(got.out, /env:PI_MEMORY_EXIT_SUMMARY=0/, "memory auto turns pi-memory off");
    assert.match(got.out, /env:PI_SUBAGENT_EXTRA_AGENT_DIRS=.*\/agents/);
    assert.equal(calls[0].op, "tapes.get");
    assert.deepEqual(calls[0].args, { id: "foreman", format: "json" });
    assert.match(got.err, /env the tape expects is not set here: FOREMAN_TOKEN, HOME_REGION/);
  });

  test("an unpinned tape without a terminal: refused, pi never starts", async () => {
    cloud.set("foreman", FOREMAN);
    const b = bundle();
    const got = await run(b, ["--tape", "foreman"]);
    assert.notEqual(got.code, 0);
    assert.doesNotMatch(got.out, /args:/);
    assert.match(got.err, /isn't pinned on this laptop yet/);
  });

  test("a changed tape in print mode: the pinned version plays", async () => {
    cloud.set("foreman", { ...FOREMAN, systemPrompt: "Push to main." });
    const b = bundle();
    writePin(b.tapes, FOREMAN);
    const got = await run(b, ["--tape", "foreman", "-p", "hi"]);
    assert.equal(got.code, 0, got.err);
    const args = JSON.parse(got.out.split("\n").find((l) => l.startsWith("args:"))!.slice(5));
    assert.equal(readFileSync(args[args.indexOf("--system-prompt") + 1], "utf8"), FOREMAN.systemPrompt, "the pinned prompt, not the cloud's");
  });

  test("kernal.tape plays in new sessions; --tape none skips it; a missing tape only warns then", async () => {
    cloud.set("foreman", FOREMAN);
    const b = bundle({ kernal: { tape: "foreman" } });
    writePin(b.tapes, FOREMAN);
    assert.match((await run(b, [])).out, /env:KERNAL_TAPE=foreman/);
    const none = await run(b, ["--tape", "none"]);
    assert.doesNotMatch(none.out, /KERNAL_TAPE=/);
    const gone = bundle({ kernal: { tape: "ghost" } });
    const g = await run(gone, []);
    assert.equal(g.code, 0);
    assert.match(g.err, /starting without tape ghost/);
  });

  test("never inside a Drive, and markers from an earlier run are cleared", async () => {
    const b = bundle({ kernal: { tape: "foreman" } });
    writePin(b.tapes, FOREMAN);
    const got = await run(b, [], { OUTFITTER_SESSION_ID: "s-1", KERNAL_TAPE: "stale", KERNAL_TAPE_AGENT_ENGINE: "1" });
    assert.doesNotMatch(got.out, /KERNAL_TAPE(_AGENT_ENGINE)?=/);
    assert.equal(calls.length, 0);
  });
});

describe("/tape", () => {
  function fakePi() {
    const commands = new Map<string, any>();
    const handlers = new Map<string, any[]>();
    return { commands, handlers, registerCommand: (n: string, c: any) => commands.set(n, c), on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]) };
  }
  function tuiCtx(picks: (string | undefined)[], confirms: boolean[] = []) {
    const notes: string[] = [];
    return {
      notes,
      ctx: {
        mode: "tui",
        sessionManager: { getSessionFile: () => "/sessions/s.jsonl" },
        ui: { notify: (m: string) => notes.push(m), select: async () => picks.shift(), confirm: async () => confirms.shift() ?? false, setStatus: () => {} },
      },
    };
  }

  test("/tape <id>: review, pin, set it for new sessions and restart into this session with it", async () => {
    const dir = tmp();
    const { transport } = cloudTransport(new Map([["foreman", FOREMAN]]));
    let settings: any = {};
    const relaunched: string[][] = [];
    const pi = fakePi();
    registerTape(pi as any, { env: {}, dir, transport, settings: () => settings, writeSettings: (c) => c(settings), relaunch: (a) => relaunched.push(a) });
    const { ctx, notes } = tuiCtx(["Show the full prompts", "Pin and play"]);
    await pi.commands.get("tape").handler("foreman", ctx);
    assert.equal(readPin(dir, "foreman")?.hash, tapeHash(FOREMAN));
    assert.equal(settings.kernal.tape, "foreman");
    assert.deepEqual(relaunched, [["--tape", "foreman", "--session", "/sessions/s.jsonl"]]);
    assert.match(notes.join("\n"), /Delegate edits to coder/, "the full prompts were shown");
  });

  test("/tape <id> cancelled: nothing pinned or set", async () => {
    const dir = tmp();
    const { transport } = cloudTransport(new Map([["foreman", FOREMAN]]));
    const settings: any = {};
    const pi = fakePi();
    const relaunched: string[][] = [];
    registerTape(pi as any, { env: {}, dir, transport, settings: () => settings, writeSettings: (c) => c(settings), relaunch: (a) => relaunched.push(a) });
    await pi.commands.get("tape").handler("foreman", tuiCtx(["Cancel"]).ctx);
    assert.equal(readPin(dir, "foreman"), undefined);
    assert.equal(settings.kernal, undefined);
    assert.deepEqual(relaunched, []);
  });

  test("/tape <id> asks before installing the tape's packages", async () => {
    const dir = tmp();
    const tape = { ...FOREMAN, packages: ["npm:pi-foo@1.0.0"] };
    const { transport } = cloudTransport(new Map([["foreman", tape]]));
    const settings: any = {};
    const pi = fakePi();
    const runs: string[][] = [];
    registerTape(pi as any, { env: {}, dir, transport, settings: () => settings, writeSettings: (c) => c(settings), relaunch: () => {}, run: async (_c, a) => (runs.push(a), { code: 0, output: "" }) });
    await pi.commands.get("tape").handler("foreman", tuiCtx(["Pin and play"], [false]).ctx);
    assert.deepEqual(runs, [], "no: nothing installed");
    await pi.commands.get("tape").handler("foreman", tuiCtx([], [true]).ctx);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].includes("--ignore-scripts"));
  });

  test("print mode can't review: /tape <id> refuses", async () => {
    const pi = fakePi();
    const { transport, calls } = cloudTransport(new Map([["foreman", FOREMAN]]));
    registerTape(pi as any, { env: {}, dir: tmp(), transport, relaunch: () => {} });
    const notes: string[] = [];
    await pi.commands.get("tape").handler("foreman", { mode: "print", ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0], /needs your review at the terminal/);
    assert.equal(calls.length, 0);
  });

  test("/tape off clears the setting and restarts without the tape; /tape status says what plays", async () => {
    const dir = tmp();
    writePin(dir, FOREMAN);
    const { transport } = cloudTransport(new Map([["foreman", { ...FOREMAN, model: "litellm/x" }]]));
    const settings: any = { kernal: { tape: "foreman" } };
    const pi = fakePi();
    const relaunched: string[][] = [];
    registerTape(pi as any, { env: { KERNAL_TAPE: "foreman", KERNAL_TAPE_HASH: tapeHash(FOREMAN), KERNAL_TAPE_MEMORY: "auto" }, dir, transport, settings: () => settings, writeSettings: (c) => c(settings), relaunch: (a) => relaunched.push(a) });
    const { ctx, notes } = tuiCtx([]);
    await pi.commands.get("tape").handler("status", ctx);
    assert.match(notes[0], /this session plays tape foreman/);
    assert.match(notes[0], /cloud: changed since you pinned it \(model\)/);
    await pi.commands.get("tape").handler("off", ctx);
    assert.equal(settings.kernal.tape, undefined);
    assert.deepEqual(relaunched, [["--tape", "none", "--session", "/sessions/s.jsonl"]]);
  });

  test("not registered inside a Drive", () => {
    const pi = fakePi();
    registerTape(pi as any, { env: { OUTFITTER_SESSION_ID: "s" }, dir: tmp() });
    assert.equal(pi.commands.size, 0);
  });

  test("a restart hands bin/kernal a clean env: no tape markers, pi-memory's real directory back", () => {
    const env = relaunchEnv({ KERNAL_TAPE: "foreman", KERNAL_TAPE_MEMORY: "auto", KERNAL_PI_MEMORY_OFF: "1", KERNAL_PI_MEMORY_SOURCE: "/real", PI_MEMORY_DIR: "/empty", PI_MEMORY_EXIT_SUMMARY: "0", OTHER: "kept" });
    assert.deepEqual(env, { KERNAL_PI_MEMORY_SOURCE: "/real", PI_MEMORY_DIR: "/real", OTHER: "kept" });
  });
});

describe("the Tapes admin page", () => {
  function apiFor(cloud: Map<string, Tape>, opts: { down?: boolean; run?: any } = {}) {
    const dir = tmp();
    const { transport } = cloudTransport(cloud, opts);
    const settings: any = { packages: ["npm:pi-subagents"] };
    const routes = createTapeApi({ dir, transport, env: { HOME_REGION: "eu" }, settings: () => settings, writeSettings: (c) => c(settings), run: opts.run });
    const call = (key: string, body: any = {}, q = "") => routes[key](body, new URLSearchParams(q));
    return { dir, settings, call };
  }

  test("the list: cloud tapes with pin state and a changed badge; no env values anywhere", async () => {
    const changed = { ...FOREMAN, updatedAt: "2026-10-02T00:00:00.000Z", systemPrompt: "x" };
    const a = apiFor(new Map([["foreman", changed], ["other", { id: "other", name: "Other", model: "a/b" } as Tape]]));
    writePin(a.dir, FOREMAN);
    const got: any = (await a.call("GET /tapes")).body;
    assert.equal(got.connected, true);
    assert.deepEqual(got.tapes.map((t: any) => [t.id, t.state]), [["foreman", "changed"], ["other", "unpinned"]]);
    assert.ok(!JSON.stringify(got).includes(SECRET));
  });

  test("the detail: a field-level diff with the prompt's lines, env names only, cloud-only fields; pin by the hash shown", async () => {
    const changed: Tape = { ...FOREMAN, systemPrompt: "Plan the work.\nAlways push to main.", packages: ["npm:pi-foo"], updatedAt: "2026-10-02T00:00:00.000Z" };
    const a = apiFor(new Map([["foreman", changed]]));
    writePin(a.dir, FOREMAN);
    const d: any = (await a.call("GET /tapes/tape", {}, "id=foreman")).body;
    assert.equal(d.state, "changed");
    assert.deepEqual(d.changes.map((c: any) => c.field), ["packages", "systemPrompt"]);
    assert.ok(d.changes[1].lines.some((l: any) => l.op === "+" && l.text === "Always push to main."));
    assert.deepEqual(d.cloud.missingEnv, ["FOREMAN_TOKEN"]);
    assert.deepEqual(d.cloud.cloudOnly.map((c: any) => c.field), ["branchPrefix", "mergeFromCloud"]);
    assert.match(d.cloud.systemPromptHtml, /<p>/);
    // A stale hash (the cloud changed again since the page loaded) is refused.
    assert.equal((await a.call("POST /tapes/pin", { id: "foreman", hash: tapeHash(FOREMAN) })).status, 409);
    const pinned: any = await a.call("POST /tapes/pin", { id: "foreman", hash: d.cloud.hash });
    assert.equal(pinned.status, undefined);
    assert.equal(readPin(a.dir, "foreman")?.hash, tapeHash(changed));
  });

  test("keep pinned, play (only a pinned tape), memory settings", async () => {
    const changed: Tape = { ...FOREMAN, model: "litellm/x" };
    const a = apiFor(new Map([["foreman", changed], ["other", { id: "other", name: "o", model: "a/b" } as Tape]]));
    writePin(a.dir, FOREMAN);
    await a.call("POST /tapes/keep", { id: "foreman", hash: tapeHash(changed) });
    assert.equal(readPin(a.dir, "foreman")?.hash, tapeHash(FOREMAN));
    assert.equal(((await a.call("GET /tapes/tape", {}, "id=foreman")).body as any).state, "kept");
    assert.equal((await a.call("POST /tapes/play", { id: "other" })).status, 409, "an unpinned tape can't be played");
    await a.call("POST /tapes/play", { id: "foreman" });
    assert.equal(a.settings.kernal.tape, "foreman");
    await a.call("POST /tapes/play", { id: null });
    assert.equal(a.settings.kernal.tape, undefined);
    await a.call("POST /tapes/memory", { memory: "tool", record: true });
    assert.deepEqual(a.settings.kernal, { memory: "tool", memoryRecord: true });
    assert.equal((await a.call("POST /tapes/memory", { memory: "loud" })).status, 400);
  });

  test("offline: pinned tapes still show, from the pin", async () => {
    const a = apiFor(new Map(), { down: true });
    writePin(a.dir, FOREMAN);
    const list: any = (await a.call("GET /tapes")).body;
    assert.equal(list.connected, false);
    assert.deepEqual(list.tapes.map((t: any) => [t.id, t.state]), [["foreman", "pinned"]]);
    const d: any = (await a.call("GET /tapes/tape", {}, "id=foreman")).body;
    assert.equal(d.state, "offline");
    assert.equal(d.pinned.tape.model, FOREMAN.model);
  });

  test("install: only a pinned tape's missing npm packages, scripts off", async () => {
    const runs: string[][] = [];
    const tape = { ...FOREMAN, packages: ["npm:pi-foo@1.0.0", "npm:pi-subagents", "./local", "npm:pi-any"] };
    const a = apiFor(new Map([["foreman", tape]]), { run: async (_c: string, args: string[]) => (runs.push(args), { code: 0, output: "" }) });
    assert.equal((await a.call("POST /tapes/install", { id: "foreman" })).status, 409);
    writePin(a.dir, tape);
    await a.call("POST /tapes/install", { id: "foreman" });
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].slice(0, 2), ["install", "pi-foo@1.0.0"]);
    assert.ok(runs[0].includes("--ignore-scripts"));
  });

  test("the page is on the nav and its script parses", async () => {
    const m = await import("../.pi/extensions/kernal-admin/app.ts");
    assert.match(m.APP_JS, /id: "tapes", label: "Tapes"/);
    new Function(m.APP_JS);
  });
});

describe("the coder subagent Kernal ships", () => {
  const agentsModule = join(root, ".pi", "npm", "node_modules", "pi-subagents", "src", "agents", "agents.js");
  const skip = !existsSync(agentsModule) && "extension packages not installed (npm ci in .pi/npm)";

  test("the same frontmatter as the Outfitter image's coder", () => {
    const front = (f: string) => readFileSync(f, "utf8").split("---")[1].split("\n").filter((l) => !l.startsWith("description:") && l.trim()).join("\n");
    assert.equal(front(join(root, "agents", "coder.md")), front(join(root, "..", "outfitter", "image", "agents", "coder.md")));
  });

  test("pi-subagents finds it through PI_SUBAGENT_EXTRA_AGENT_DIRS, and the person's own coder wins", { skip }, async () => {
    const agentDir = tmp("agent-dir-");
    const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HOME: process.env.HOME, X: process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = tmp("home-");
    process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = join(root, "agents");
    try {
      const m = await import("../.pi/npm/node_modules/pi-subagents/src/agents/agents.js");
      m.clearAgentDiscoveryCache();
      const find = () => {
        m.clearAgentDiscoveryCache();
        const found: any = m.discoverAgents(tmp("cwd-"), "both", "litellm");
        return (found.agents ?? found).find((a: any) => a.name === "coder");
      };
      const coder = find();
      assert.ok(coder, "coder found");
      assert.equal(coder.source, "user");
      assert.match(coder.systemPrompt ?? "", /never push, pull or fetch/);
      mkdirSync(join(agentDir, "agents"));
      writeFileSync(join(agentDir, "agents", "coder.md"), "---\nname: coder\ndescription: mine\ntools: read\n---\nMy own coder.\n");
      assert.match(find().systemPrompt ?? "", /My own coder/);
    } finally {
      for (const [k, v] of [["PI_CODING_AGENT_DIR", saved.PI_CODING_AGENT_DIR], ["HOME", saved.HOME], ["PI_SUBAGENT_EXTRA_AGENT_DIRS", saved.X]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("agent_engine on a laptop (a tape with Agent Engine)", () => {
  const SID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const APPROVAL = "11111111-2222-4333-8444-555555555555";
  function setup(env: Record<string, string>, reply: (op: string, args: any, opts: any) => AdminReply) {
    const calls: { op: string; args: any; opts: any }[] = [];
    const transport: AdminTransport = { kind: "laptop", async call(op, args, opts = {}) { calls.push({ op, args, opts }); return reply(op, args, opts); } };
    const tools: any[] = [];
    const handlers = new Map<string, any[]>();
    const pi: any = {
      registerTool: (t: any) => tools.push(t),
      registerCommand: () => {},
      on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
      getActiveTools: () => [],
      setActiveTools: () => {},
    };
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp("agent-");
    try {
      registerAgentEngine(pi, { env: { ...env }, transport, settings: { kernal: { memory: "off" } }, repoOf: async () => "acme/widgets" });
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
    const ctx = (mode = "tui") => ({ mode, cwd: "/w", sessionManager: { getSessionId: () => SID }, ui: { notify: () => {} } });
    return { calls, tools, handlers, ctx };
  }
  const TAPE_ENV = { KERNAL_TAPE: "foreman", KERNAL_TAPE_HASH: "h", KERNAL_TAPE_MEMORY: "off", KERNAL_TAPE_AGENT_ENGINE: "1" };

  test("no tape, or a tape without Agent Engine: no agent_engine tool", () => {
    assert.equal(setup({}, () => ({ ok: true, text: "" })).tools.filter((t) => t.name === "agent_engine").length, 0);
    assert.equal(setup({ ...TAPE_ENV, KERNAL_TAPE_AGENT_ENGINE: "0" }, () => ({ ok: true, text: "" })).tools.filter((t) => t.name === "agent_engine").length, 0);
  });

  test("list goes straight through, with the session, the repo and the tape", async () => {
    const s = setup(TAPE_ENV, () => ({ ok: true, text: "researcher  Researcher" }));
    const tool = s.tools.find((t) => t.name === "agent_engine");
    const out = await tool.execute("1", { action: "list" }, undefined, undefined, s.ctx());
    assert.equal(out.content[0].text, "researcher  Researcher");
    assert.deepEqual(s.calls[0].opts.laptop, { sessionId: `laptop:${SID}`, repo: "acme/widgets", tape: "foreman" });
    assert.equal(s.calls[0].opts.confirmed, undefined, "never a TUI yes");
  });

  test("invoke waits for the web yes, then reruns with the approval id; print mode returns the pending id", async () => {
    let approved = false;
    const s = setup(TAPE_ENV, (op, _args, opts) => {
      if (op === "approvals.get") return { ok: true, text: "", state: approved ? "approved" : "pending" };
      if (op === "ae.invoke" && !opts.approvalId) return { ok: false, error: "needs your approval in the Outfitter web app", needsApproval: true, approvalId: APPROVAL };
      return { ok: true, text: "status: completed" };
    });
    const tool = s.tools.find((t) => t.name === "agent_engine");
    const pending = await tool.execute("1", { action: "invoke", agent: "researcher", message: "hi" }, undefined, undefined, s.ctx("print"));
    assert.equal(pending.isError, true);
    assert.match(pending.content[0].text, new RegExp(`approvalId "${APPROVAL}"`));
    approved = true;
    const done = await tool.execute("2", { action: "invoke", agent: "researcher", message: "hi", approvalId: APPROVAL }, undefined, undefined, s.ctx("print"));
    assert.equal(done.content[0].text, "status: completed");
    const rerun = s.calls.filter((c) => c.op === "ae.invoke").at(-1)!;
    assert.equal(rerun.opts.approvalId, APPROVAL);
    assert.deepEqual(rerun.args, { agent: "researcher", message: "hi" }, "the same args the yes was for");
  });

  test("session end stops what the session opened, best effort", async () => {
    const s = setup(TAPE_ENV, () => ({ ok: true, text: "ok" }));
    const tool = s.tools.find((t) => t.name === "agent_engine");
    await tool.execute("1", { action: "list" }, undefined, undefined, s.ctx());
    for (const h of s.handlers.get("session_shutdown") ?? []) await h({}, s.ctx());
    const close = s.calls.find((c) => c.op === "ae.close")!;
    assert.equal(close.opts.laptop.tape, "foreman");
  });
});

describe("the repo context and a tape's repos hint", () => {
  const remotes = (map: Record<string, { host?: string; owner?: string; repo?: string }>) => ({
    lookup: async (_cwd: string, name = "origin") => map[name],
    names: async () => Object.keys(map),
  });

  test("origin; a non-GitHub origin means no repo; no origin: the first GitHub remote, with a note", async () => {
    let r = remotes({ origin: { host: "github.com", owner: "Acme", repo: "Widgets" } });
    assert.deepEqual(await repoInfo("/w", r.lookup, r.names), { repo: "acme/widgets" });
    r = remotes({ origin: { host: "gitlab.com", owner: "a", repo: "b" }, gh: { host: "github.com", owner: "a", repo: "b" } });
    assert.match((await repoInfo("/w", r.lookup, r.names)).note!, /origin is not a GitHub repository/);
    assert.equal((await repoInfo("/w", r.lookup, r.names)).repo, undefined);
    r = remotes({ lab: { host: "gitlab.com", owner: "a", repo: "b" }, upstream: { host: "github.com", owner: "Acme", repo: "w" } });
    assert.deepEqual(await repoInfo("/w", r.lookup, r.names), { repo: "acme/w", note: "no origin remote; using upstream" });
    r = remotes({});
    assert.deepEqual(await repoInfo("/w", r.lookup, r.names), { note: "not in a git repository with a GitHub remote" });
  });

  test("from a subdirectory of a real repo, the repo's origin", async () => {
    const repo = tmp("repo-");
    const sh = (args: string[], cwd = repo) => new Promise<void>((res, rej) => execFile("git", args, { cwd }, (e) => (e ? rej(e) : res())));
    await sh(["init", "-q"]);
    await sh(["remote", "add", "origin", "https://github.com/Acme/Widgets.git"]);
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    assert.deepEqual(await repoInfo(join(repo, "src", "deep")), { repo: "acme/widgets" });
    assert.deepEqual(await repoInfo(tmp("not-a-repo-")), { note: "not in a git repository with a GitHub remote" });
  });

  test("repos is a hint: a warning elsewhere, nothing in a matching repo; parsed lowercased owner/name only", () => {
    const tape = { ...FOREMAN, repos: ["acme/widgets", "acme/gears"] };
    assert.equal(repoWarning(tape, "acme/widgets"), undefined);
    assert.match(repoWarning(tape, "acme/other")!, /meant for acme\/widgets, acme\/gears, not acme\/other/);
    assert.match(repoWarning(tape, undefined)!, /no GitHub repo/);
    assert.equal(repoWarning(FOREMAN, "x/y"), undefined);
    assert.equal(parseTape({ ...FOREMAN, repos: ["Acme/Widgets"] }).ok, false);
    assert.equal(parseTape({ ...FOREMAN, repos: ["acme/widgets"] }).ok, true);
  });

  test("/tape status says which repo it plays in, and warns when the tape is meant for others", async () => {
    const dir = tmp();
    const tape = { ...FOREMAN, repos: ["acme/gears"] };
    writePin(dir, tape);
    const { transport } = cloudTransport(new Map([["foreman", tape]]));
    const commands = new Map<string, any>();
    registerTape({ registerCommand: (n: string, c: any) => commands.set(n, c), on: () => {} } as any, {
      env: { KERNAL_TAPE: "foreman", KERNAL_TAPE_HASH: tapeHash(tape) }, dir, transport, settings: () => ({}), writeSettings: () => {}, repo: async () => ({ repo: "acme/widgets" }),
    });
    const notes: string[] = [];
    await commands.get("tape").handler("status", { mode: "tui", ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0], /plays tape foreman \([0-9a-f]{12}\) in acme\/widgets/);
    assert.match(notes[0], /meant for acme\/gears, not acme\/widgets \(a hint: it plays anyway\)/);
  });

  test("the admin page shows the repo and the warning", async () => {
    const dir = tmp();
    const tape = { ...FOREMAN, repos: ["acme/gears"] };
    const { transport } = cloudTransport(new Map([["foreman", tape]]));
    const routes = createTapeApi({ dir, transport, env: {}, settings: () => ({}), writeSettings: () => {}, repo: async () => ({ repo: "acme/widgets" }) });
    const list: any = (await routes["GET /tapes"]({}, new URLSearchParams())).body;
    assert.deepEqual(list.repo, { repo: "acme/widgets" });
    const d: any = (await routes["GET /tapes/tape"]({}, new URLSearchParams("id=foreman"))).body;
    assert.match(d.repo.warning, /meant for acme\/gears, not acme\/widgets/);
    assert.deepEqual(d.cloud.repos, ["acme/gears"]);
  });
});
