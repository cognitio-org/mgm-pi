// #426: `kernal --teleport <id>` runs the pull inside pi. bin/kernal starts pi on "/teleport pull <id>"
// (pi runs a first message naming an extension command as that command), because a release bundle's
// pi is a compiled binary and a node script run before it can't import SessionManager. These tests
// cover bin/kernal's half (what it hands pi) and the extension's half without a UI (-p, --mode json):
// messages on stderr, a collision imported under a new id, and exit 1 on a failure.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import teleport, { headless } from "../.pi/extensions/teleport/index.ts";
import { GitStore } from "../.pi/extensions/teleport/lib.ts";
import { makePi } from "./harness.ts";

const root = join(import.meta.dirname, "..");

describe("bin/kernal --teleport hands the pull to pi", () => {
  /** A copy of bin/kernal next to a fake pi/pi that prints its arguments, one per line. */
  function fakeBundle() {
    const dir = mkdtempSync(join(tmpdir(), "tp-bin-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "pi"));
    mkdirSync(join(dir, ".pi"));
    copyFileSync(join(root, "bin", "kernal"), join(dir, "bin", "kernal"));
    writeFileSync(join(dir, "pi", "pi"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
    chmodSync(join(dir, "pi", "pi"), 0o755);
    writeFileSync(join(dir, ".pi", "settings.json"), "{}\n");
    return dir;
  }
  const run = (args: string[]) => {
    const dir = fakeBundle();
    const home = mkdtempSync(join(tmpdir(), "tp-home-"));
    return spawnSync("bash", [join(dir, "bin", "kernal"), ...args], {
      encoding: "utf8",
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, KERNAL_SKIP_LMS: "1", KERNAL_NO_DISCOVERY: "1", TMPDIR: home },
    });
  };

  test("pi starts on /teleport pull <id>, with the remaining arguments after it", () => {
    const r = run(["--teleport", "abc-123", "-p", "carry on"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["-a", "/teleport pull abc-123", "-p", "carry on"]);
  });

  test("--force goes into the pull command, not to pi", () => {
    const r = run(["--teleport", "abc-123", "--force", "--model", "x/y"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["-a", "/teleport pull abc-123 --force", "--model", "x/y"]);
  });

  test("no id, a flag for an id, or an id with spaces is a usage error; pi never starts", () => {
    for (const args of [["--teleport"], ["--teleport", "--force"], ["--teleport", "a b"]]) {
      const r = run(args);
      assert.equal(r.status, 1, args.join(" "));
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /Usage: kernal --teleport|is not a session id/);
    }
  });

  test("@file arguments are refused (pi would put the file in front of the command)", () => {
    const r = run(["--teleport", "abc", "@notes.md"]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /@file arguments/);
  });

  test("bin/kernal no longer runs a node script for --teleport", () => {
    const bin = readFileSync(join(root, "bin", "kernal"), "utf8");
    const block = bin.slice(bin.indexOf("  --teleport)"), bin.indexOf(";;", bin.indexOf("  --teleport)")));
    assert.doesNotMatch(block, /\bnode "/);
    assert.equal(existsSync(join(root, ".pi", "extensions", "teleport", "cli.ts")), false);
  });
});

describe("/teleport pull without a UI (kernal --teleport <id> -p)", () => {
  /** A session file as pi 0.87.1 writes one, pushed into a GitStore under `id`. */
  async function seed(store: string, id: string) {
    const src = mkdtempSync(join(tmpdir(), "tp-src-"));
    const now = new Date().toISOString();
    const lines = [
      { type: "session", version: 3, id, timestamp: now, cwd: src },
      { type: "message", id: "m1", parentId: null, timestamp: now, message: { role: "user", content: "hello from the other machine", timestamp: Date.now() } },
    ];
    const jsonl = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await new GitStore({ dir: store, warn: () => {} }).put(id, jsonl, { id, host: "elsewhere", cwd: src, pushedAt: now } as any);
  }

  async function drive(opts: { id: string; seedId?: string; existing?: boolean }) {
    const base = mkdtempSync(join(tmpdir(), "tp-headless-"));
    const store = join(base, "store");
    const cwd = join(base, "work");
    mkdirSync(cwd);
    const prev = { store: process.env.KERNAL_TELEPORT_STORE, agent: process.env.PI_CODING_AGENT_DIR, sandbox: process.env.KERNAL_SANDBOX };
    process.env.KERNAL_TELEPORT_STORE = store;
    process.env.PI_CODING_AGENT_DIR = join(base, "agent");
    process.env.KERNAL_SANDBOX = "1";   // no prefetch at load
    const stderr: string[] = [];
    const exits: number[] = [];
    const origError = console.error;
    const origExit = headless.exit;
    console.error = (...a: unknown[]) => { stderr.push(a.join(" ")); };
    headless.exit = (code) => { exits.push(code); };
    try {
      if (opts.seedId) await seed(store, opts.seedId);
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      if (opts.existing && opts.seedId) {
        // A local session with the same id already exists for this cwd.
        const tmp = join(base, "local.jsonl");
        writeFileSync(tmp, JSON.stringify({ type: "session", version: 3, id: opts.seedId, timestamp: new Date().toISOString(), cwd }) + "\n"
          + JSON.stringify({ type: "message", id: "l1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "local", timestamp: Date.now() } }) + "\n");
        SessionManager.forkFrom(tmp, cwd, undefined, { id: opts.seedId });
      }
      const pi = makePi() as any;
      pi.exec = async () => ({ code: 1, stdout: "", stderr: "" });
      teleport(pi);
      const notices: string[] = [];
      const switched: string[] = [];
      const ui = { notify: (m: string) => notices.push(m), select: async () => { throw new Error("no UI to ask"); } };
      const ctx = {
        hasUI: false,
        mode: "print",
        cwd,
        ui,
        modelRegistry: { getAvailable: () => [], find: () => undefined },
        switchSession: async (path: string, o?: { withSession?: (c: any) => Promise<void> }) => {
          switched.push(path);
          await o?.withSession?.({ hasUI: false, ui });
          return { cancelled: false };
        },
      };
      await pi.commands.get("teleport").handler(`pull ${opts.id}`, ctx);
      const ids = (await SessionManager.list(cwd)).map((s: any) => s.id);
      return { stderr, exits, notices, switched, cwd, ids };
    } finally {
      console.error = origError;
      headless.exit = origExit;
      for (const [k, v] of [["KERNAL_TELEPORT_STORE", prev.store], ["PI_CODING_AGENT_DIR", prev.agent], ["KERNAL_SANDBOX", prev.sandbox]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  test("an unknown id: the error goes to stderr and pi exits 1", async () => {
    const r = await drive({ id: "nosuchid" });
    assert.deepEqual(r.exits, [1]);
    assert.ok(r.stderr.some((l) => l.includes('no session "nosuchid" in the store')), r.stderr.join("\n"));
    assert.deepEqual(r.switched, []);
    assert.deepEqual(r.notices, [], "nothing went to a UI nobody sees");
  });

  test("a pushed session is imported under its id and opened; the result is on stderr", async () => {
    const id = randomUUID();
    const r = await drive({ id, seedId: id });
    assert.deepEqual(r.exits, []);
    assert.equal(r.switched.length, 1);
    const header = JSON.parse(readFileSync(r.switched[0], "utf8").split("\n")[0]);
    assert.equal(header.id, id);
    assert.equal(header.cwd, r.cwd);
    assert.match(readFileSync(r.switched[0], "utf8"), /hello from the other machine/);
    assert.ok(r.stderr.some((l) => l.startsWith("Teleported in from elsewhere")), r.stderr.join("\n"));
  });

  test("a local session with the same id is kept; the pull imports under a new id without asking", async () => {
    const id = randomUUID();
    const r = await drive({ id, seedId: id, existing: true });
    assert.deepEqual(r.exits, []);
    assert.equal(r.switched.length, 1);
    const header = JSON.parse(readFileSync(r.switched[0], "utf8").split("\n")[0]);
    assert.notEqual(header.id, id);
    assert.deepEqual([...r.ids].sort(), [id, header.id].sort());
    assert.ok(r.stderr.some((l) => l.includes("importing it as a new session")));
  });
});
