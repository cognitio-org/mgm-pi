/**
 * Browser IDE phase 1 (#241): the code-server install. A local HTTP server serves a small fake
 * release built with the same tar; no network, no real code-server.
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeServerInstaller, codeServerUrl, ideArch, parseIdeSpec, COPILOT_EXCLUDES } from "../src/ide-install.js";

const TAR = process.env.TAR_BIN ?? "tar";
const VERSION = "4.139.1";
const trash: string[] = [];
after(() => { for (const d of trash) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "outfitter-ide-test-")); trash.push(d); return d; };

/** A release-shaped tarball: code-server-<v>-linux-amd64/{bin,lib/vscode/...}, Copilot included. */
function fakeRelease(copilotText = "copilot"): Buffer {
  const root = tmp();
  const top = join(root, `code-server-${VERSION}-linux-amd64`);
  for (const d of ["bin", "lib/vscode/out", "lib/vscode/extensions/copilot/dist", "lib/vscode/extensions/markdown", "lib/vscode/node_modules/@github/copilot-sdk", "lib/vscode/node_modules/other"]) {
    mkdirSync(join(top, d), { recursive: true });
  }
  writeFileSync(join(top, "bin/code-server"), "#!/bin/sh\necho code-server\n", { mode: 0o755 });
  writeFileSync(join(top, "lib/vscode/out/main.js"), "main");
  writeFileSync(join(top, "lib/vscode/extensions/markdown/ext.js"), "md");
  writeFileSync(join(top, "lib/vscode/extensions/copilot/dist/ext.js"), copilotText);
  writeFileSync(join(top, "lib/vscode/node_modules/@github/copilot-sdk/index.js"), copilotText);
  writeFileSync(join(top, "lib/vscode/node_modules/other/index.js"), "other");
  const out = join(root, "release.tar.gz");
  execFileSync(TAR, ["czf", out, "-C", root, `code-server-${VERSION}-linux-amd64`]);
  return readFileSync(out);
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let server: Server;
let base = "";
const bodies = new Map<string, { status?: number; body?: Buffer; slow?: boolean }>();
before(async () => {
  server = createServer((req, res) => {
    const entry = bodies.get(req.url ?? "");
    if (!entry || entry.status) { res.writeHead(entry?.status ?? 404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/gzip" });
    if (!entry.slow) { res.end(entry.body); return; }
    // Trickle the first bytes, then hold the connection open until the client goes away.
    res.write(entry.body!.subarray(0, 64));
    req.on("close", () => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function installer(path: string, sha: string, extra: Partial<ConstructorParameters<typeof CodeServerInstaller>[0]> = {}) {
  const parent = tmp();
  const dest = join(parent, "code-server");
  const lines: string[] = [];
  const inst = new CodeServerInstaller({
    spec: { version: VERSION, artifacts: { amd64: sha } },
    arch: "amd64",
    dest,
    urlFor: () => `${base}${path}`,
    tarBin: TAR,
    onLog: (l) => lines.push(l),
    ...extra,
  });
  return { inst, dest, parent, lines };
}
const leftovers = (parent: string) => readdirSync(parent).filter((n) => n.includes(".tmp-"));

describe("CodeServerInstaller (#241)", () => {
  test("installs the release, without the Copilot extension and SDK, readable and runnable", async () => {
    const release = fakeRelease();
    bodies.set("/ok", { body: release });
    const { inst, dest, parent, lines } = installer("/ok", sha256(release));
    const result = await inst.start();
    assert.equal(result.ok, true, result.error);
    assert.equal(inst.state, "ready");
    assert.ok(existsSync(join(dest, "bin/code-server")));
    assert.ok(existsSync(join(dest, "lib/vscode/out/main.js")));
    assert.ok(existsSync(join(dest, "lib/vscode/extensions/markdown/ext.js")));
    assert.ok(existsSync(join(dest, "lib/vscode/node_modules/other/index.js")));
    assert.equal(existsSync(join(dest, "lib/vscode/extensions/copilot")), false, "Copilot extension excluded");
    assert.equal(existsSync(join(dest, "lib/vscode/node_modules/@github")), false, "Copilot SDK excluded");
    assert.equal(statSync(dest).mode & 0o777, 0o755, "agent can enter and run, not write");
    assert.ok(statSync(join(dest, "bin/code-server")).mode & 0o111, "the binary stays executable");
    assert.deepEqual(leftovers(parent), []);
    assert.match(lines.join("\n"), /code-server installed in/);
  });

  test("a wrong checksum installs nothing and leaves no temp dir", async () => {
    const release = fakeRelease();
    bodies.set("/bad-sum", { body: release });
    const { inst, dest, parent } = installer("/bad-sum", "0".repeat(64));
    const result = await inst.start();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /checksum mismatch/);
    assert.equal(inst.state, "failed");
    assert.equal(existsSync(dest), false);
    assert.deepEqual(leftovers(parent), []);
  });

  test("the checksum covers the excluded entries too", async () => {
    // Same tree except inside the excluded Copilot dirs: tar writes identical files for both, so
    // only a hash taken before tar tells them apart.
    const pinned = fakeRelease("copilot v1");
    const served = fakeRelease("copilot v2, tampered");
    bodies.set("/tampered-excluded", { body: served });
    const { inst, dest } = installer("/tampered-excluded", sha256(pinned));
    const result = await inst.start();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /checksum mismatch/);
    assert.equal(existsSync(dest), false);
  });

  test("an HTTP error is a failed install", async () => {
    bodies.set("/missing", { status: 404 });
    const { inst, dest } = installer("/missing", "a".repeat(64));
    const result = await inst.start();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /HTTP 404/);
    assert.equal(existsSync(dest), false);
  });

  test("bytes tar can't unpack fail even when their checksum matches", async () => {
    const garbage = Buffer.from("this is not a gzip stream at all ".repeat(200));
    bodies.set("/garbage", { body: garbage });
    const { inst, dest, parent } = installer("/garbage", sha256(garbage));
    const result = await inst.start();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /unpack failed/);
    assert.equal(existsSync(dest), false);
    assert.deepEqual(leftovers(parent), []);
  });

  test("abort() stops a download in flight and cleans up", async () => {
    bodies.set("/slow", { body: fakeRelease(), slow: true });
    const { inst, dest, parent } = installer("/slow", "b".repeat(64));
    const pending = inst.start();
    await new Promise((r) => setTimeout(r, 200));
    inst.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /stopping/);
    assert.equal(existsSync(dest), false);
    assert.deepEqual(leftovers(parent), []);
    assert.match((await inst.start()).error ?? "", /stopping/, "no new install after abort");
  });

  test("a download slower than the timeout fails as timed out", async () => {
    bodies.set("/slow2", { body: fakeRelease(), slow: true });
    const { inst } = installer("/slow2", "c".repeat(64), { timeoutMs: 300 });
    const result = await inst.start();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timed out/);
  });

  test("start() shares the install in flight, and tries again after a failure", async () => {
    const release = fakeRelease();
    bodies.set("/retry", { status: 503 });
    const { inst } = installer("/retry", sha256(release));
    const a = inst.start();
    assert.equal(inst.start(), a, "one install at a time");
    assert.equal((await a).ok, false);
    bodies.set("/retry", { body: release });
    const again = await inst.start();
    assert.equal(again.ok, true, again.error);
    assert.equal(inst.start(), inst.start(), "a finished install isn't repeated");
  });
});

describe("parseIdeSpec and friends (#241)", () => {
  const sha = "d".repeat(64);
  test("accepts the api's shape for the pod's architecture", () => {
    assert.deepEqual(parseIdeSpec({ version: "4.139.1", artifacts: { amd64: sha } }, "amd64"), { version: "4.139.1", sha256: sha });
  });
  test("refuses what would end up in a URL or a comparison unchecked", () => {
    assert.ok("error" in parseIdeSpec(undefined, "amd64"));
    assert.ok("error" in parseIdeSpec({ version: "4.139.1", artifacts: { amd64: sha } }, undefined));
    assert.ok("error" in parseIdeSpec({ version: "4.139.1/../../x", artifacts: { amd64: sha } }, "amd64"));
    assert.ok("error" in parseIdeSpec({ version: "4.139.1", artifacts: { arm64: sha } }, "amd64"), "no checksum for this arch");
    assert.ok("error" in parseIdeSpec({ version: "4.139.1", artifacts: { amd64: "D".repeat(64) } }, "amd64"), "lowercase hex only");
  });
  test("maps Node's architectures and builds the release URL", () => {
    assert.equal(ideArch("x64"), "amd64");
    assert.equal(ideArch("arm64"), "arm64");
    assert.equal(ideArch("ia32"), undefined);
    assert.equal(codeServerUrl("4.139.1", "amd64"), "https://github.com/coder/code-server/releases/download/v4.139.1/code-server-4.139.1-linux-amd64.tar.gz");
    assert.deepEqual(COPILOT_EXCLUDES, ["*/lib/vscode/extensions/copilot", "*/lib/vscode/node_modules/@github"]);
  });
});
