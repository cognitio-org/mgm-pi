/** kernal-update: version parsing/comparison, check cadence, notice text; and the extension against a fake pi. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersion, compareVersions, checkDue, updateNotice, tagFromGh, CHECK_INTERVAL_MS } from "../.pi/extensions/kernal-update/lib.ts";
import { makePi, makeCtx } from "./harness.ts";

describe("update lib", () => {
  test("parseVersion accepts tags and the bundle VERSION file, rejects everything else", () => {
    assert.deepEqual(parseVersion("v0.1.4"), [0, 1, 4]);
    assert.deepEqual(parseVersion("0.1.4\npi 0.86.1\n"), [0, 1, 4]);
    assert.deepEqual(parseVersion("10.2.33"), [10, 2, 33]);
    for (const bad of [undefined, "", "0.1", "v0.1.0-rc.1", "kernal (source checkout)", "latest"]) assert.equal(parseVersion(bad), undefined, String(bad));
  });
  test("compareVersions is numeric per component", () => {
    assert.ok(compareVersions([0, 1, 10], [0, 1, 9]) > 0);
    assert.ok(compareVersions([0, 2, 0], [0, 10, 0]) < 0);
    assert.equal(compareVersions([1, 0, 0], [1, 0, 0]), 0);
  });
  test("checkDue: no cache, stale cache or force", () => {
    const now = 1_000_000_000_000;
    assert.equal(checkDue(undefined, now), true);
    assert.equal(checkDue({ checkedAt: now - 1000 }, now), false);
    assert.equal(checkDue({ checkedAt: now - CHECK_INTERVAL_MS }, now), true);
    assert.equal(checkDue({ checkedAt: now - 1000 }, now, true), true);
    assert.equal(checkDue({ checkedAt: "yesterday" as any }, now), true, "corrupt cache counts as no cache");
  });
  test("updateNotice only when the release is strictly newer", () => {
    assert.match(updateNotice("0.1.3", "v0.1.4")!, /kernal 0\.1\.4 is available \(you have 0\.1\.3\)\. Run \/update/);
    assert.equal(updateNotice("0.1.4", "v0.1.4"), undefined);
    assert.equal(updateNotice("0.2.0", "v0.1.9"), undefined);
    assert.equal(updateNotice(undefined, "v0.1.4"), undefined, "source checkout");
    assert.equal(updateNotice("0.1.3", undefined), undefined, "GitHub unreachable");
  });
  test("tagFromGh", () => {
    assert.equal(tagFromGh('{"tagName":"v0.1.4"}'), "v0.1.4");
    assert.equal(tagFromGh("not json"), undefined);
    assert.equal(tagFromGh("{}"), undefined);
  });
});

describe("update extension", async () => {
  const mod = await import("../.pi/extensions/kernal-update/index.ts");
  // a fake bundle: <home>/kernal-0.1.3-test/{VERSION,.pi}; cache lands in <home>/.update-check.json
  function bundle(version?: string | null) {
    const home = mkdtempSync(join(tmpdir(), "kernal-upd-"));
    const root = join(home, "kernal-x"); mkdirSync(join(root, ".pi"), { recursive: true });
    if (version) writeFileSync(join(root, "VERSION"), `${version}\npi 0.86.1\n`);
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi"); delete process.env.KERNAL_UPDATE_CACHE; delete process.env.KERNAL_NO_UPDATE_CHECK;
    return { home, root, cache: () => { try { return JSON.parse(readFileSync(join(home, ".update-check.json"), "utf8")); } catch { return undefined; } } };
  }
  const startWith = async (latest: string | undefined, version: string | null = "0.1.3", extra: any = {}) => {   // null = no VERSION file (source checkout)
    const b = bundle(version);
    let calls = 0;
    const pi = makePi();
    mod.default(pi as any, { latest: async () => { calls++; return latest; }, now: () => 1_000_000_000_000, ...extra });
    const ctx = makeCtx({ hasUI: true });
    await pi.emit("session_start", {}, ctx);
    return { b, pi, ctx, calls: () => calls };
  };

  test("a newer release is announced once per day and shown in the status bar", async () => {
    const { b, pi, ctx, calls } = await startWith("v0.1.4");
    assert.match(ctx.notices.at(-1)!.msg, /kernal 0\.1\.4 is available \(you have 0\.1\.3\)/);
    assert.equal(ctx.statuses.get("update"), "⬆ 0.1.4 available · /update");
    assert.deepEqual(b.cache(), { checkedAt: 1_000_000_000_000, latest: "v0.1.4" });
    const ctx2 = makeCtx({ hasUI: true }); await pi.emit("session_start", {}, ctx2);
    assert.equal(calls(), 1, "second start within a day uses the cache");
    assert.match(ctx2.notices.at(-1)!.msg, /0\.1\.4 is available/, "still tells the user from the cache");
  });

  test("up to date, unreachable GitHub, source checkouts and KERNAL_NO_UPDATE_CHECK stay silent", async () => {
    let r = await startWith("v0.1.3"); assert.equal(r.ctx.notices.length, 0); assert.equal(r.ctx.statuses.get("update"), undefined);
    r = await startWith(undefined); assert.equal(r.ctx.notices.length, 0); assert.equal(r.b.cache()?.latest, undefined, "nothing cached as latest");
    r = await startWith("v9.9.9", null); assert.equal(r.ctx.notices.length, 0, "no VERSION file → source checkout");
    process.env.KERNAL_NO_UPDATE_CHECK = "1";
    const b = bundle("0.1.3"); process.env.KERNAL_NO_UPDATE_CHECK = "1"; const pi = makePi(); let calls = 0;
    mod.default(pi as any, { latest: async () => { calls++; return "v9.9.9"; } });
    const ctx = makeCtx({ hasUI: true }); await pi.emit("session_start", {}, ctx);
    assert.equal(calls, 0); assert.equal(ctx.notices.length, 0); void b;
    delete process.env.KERNAL_NO_UPDATE_CHECK;
  });

  test("in an installed release, /update extensions explains that packages update with Kernal, and runs nothing", async () => {
    // A release pins its packages to what its release gate tested, and pi's updater skips pinned
    // packages, so running it would silently do nothing.
    const calls: string[][] = [];
    const { pi, ctx } = await startWith("v0.1.3", "0.1.3", { run: async (args: string[]) => { calls.push(args); return { code: 0, tail: "" }; } });
    await pi.commands.get("update")!.handler("extensions", ctx);
    assert.deepEqual(calls, [], "nothing is run");
    assert.match(ctx.notices.at(-1)!.msg, /pinned to the versions Kernal 0\.1\.3 was tested with/);
    assert.match(ctx.notices.at(-1)!.msg, /Run \/update/);
  });

  test("in a source checkout, /update extensions forwards to pi's package updater and asks for a restart", async () => {
    const calls: string[][] = [];
    const run = async (args: string[], onLine: (l: string) => void) => { calls.push(args); onLine("updating pi-subagents"); return { code: 0, tail: "pi-subagents 0.4.0 → 0.4.1" }; };
    const { pi, ctx } = await startWith("v0.1.3", null, { run });
    await pi.commands.get("update")!.handler("extensions", ctx);
    assert.deepEqual(calls, [["update", "--extensions"]]);
    assert.match(ctx.notices.at(-1)!.msg, /Packages updated\. Restart kernal to load them\./);
    assert.ok(ctx.notices.at(-1)!.msg.includes("pi-subagents 0.4.0 → 0.4.1"));
    assert.equal(ctx.statuses.get("update"), "⬆ restart kernal");
    const r2 = await startWith("v0.1.3", null, { run: async () => ({ code: 1, tail: "npm ERR!" }) });
    await r2.pi.commands.get("update")!.handler("extensions", r2.ctx);
    assert.equal(r2.ctx.notices.at(-1)!.type, "error");
    assert.match(r2.ctx.notices.at(-1)!.msg, /Package update failed \(exit 1\)/);
  });

  test("/update check forces a fresh look and reports either way", async () => {
    const { pi, ctx, calls } = await startWith("v0.1.3");
    await pi.commands.get("update")!.handler("check", ctx);
    assert.equal(calls(), 2, "cache bypassed");
    assert.match(ctx.notices.at(-1)!.msg, /up to date \(latest release v0\.1\.3\)/);
    const b2 = bundle("0.1.3"); const p2 = makePi(); mod.default(p2 as any, { latest: async () => undefined, now: () => 1 });
    const c2 = makeCtx({ hasUI: true }); await p2.commands.get("update")!.handler("check", c2);
    assert.equal(c2.notices.at(-1)!.type, "warning"); assert.match(c2.notices.at(-1)!.msg, /Could not reach GitHub/); void b2;
  });

  test("/update runs the launcher upgrade, streams progress to the status bar and asks for a restart", async () => {
    const lines = ["installing kernal 0.1.4 (darwin-arm64) to /Users/x/.kernal", "installed: /Users/x/.kernal/current  →  /Users/x/.local/bin/kernal"];
    const calls: string[][] = [];
    const run = async (args: string[], onLine: (l: string) => void) => { calls.push(args); for (const l of lines) onLine(l); return { code: 0, tail: lines.join("\n") }; };
    const { pi, ctx } = await startWith("v0.1.4", "0.1.3", { run });
    await pi.commands.get("update")!.handler("", ctx);
    assert.deepEqual(calls, [["update"]], "the launcher is asked for a bundle upgrade");
    assert.match(ctx.notices.at(-2)!.msg, /Upgrading kernal 0\.1\.3/);
    assert.match(ctx.notices.at(-1)!.msg, /Restart kernal to use the new version/);
    assert.ok(ctx.notices.at(-1)!.msg.includes("installed: /Users/x/.kernal/current"));
    assert.equal(ctx.statuses.get("update"), "⬆ restart kernal");
    // failure path
    const failing = async () => ({ code: 1, tail: "checksum mismatch" });
    const r2 = await startWith("v0.1.4", "0.1.3", { run: failing });
    await r2.pi.commands.get("update")!.handler("", r2.ctx);
    assert.equal(r2.ctx.notices.at(-1)!.type, "error"); assert.match(r2.ctx.notices.at(-1)!.msg, /exit 1.*checksum mismatch/s);
    assert.equal(r2.ctx.statuses.get("update"), undefined);
    // source checkout
    const r3 = await startWith("v0.1.4", null, { run });
    await r3.pi.commands.get("update")!.handler("", r3.ctx);
    assert.match(r3.ctx.notices.at(-1)!.msg, /git pull/);
  });
});
