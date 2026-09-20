import { gzipSync } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { restoreWorkspace } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

/** Writes a gzipped ustar archive byte by byte, so an entry name like `../outside/evil.txt` survives
 * exactly as given. Shelling out to `tar -c` cannot produce this fixture portably: GNU tar strips a
 * leading `../` when creating an archive (the CI runner), bsdtar keeps it (macOS). */
async function rawTarGz(entries: Array<{ name: string; content: string }>): Promise<string> {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.content, "utf8");
    const h = Buffer.alloc(512, 0);
    h.write(e.name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii"); // checksum field counts as spaces while summing
    h.write("0", 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  const dir = await mkdtemp(join(tmpdir(), "outfitter-rawtar-"));
  const out = join(dir, "raw.tar.gz");
  await writeFile(out, gzipSync(Buffer.concat(blocks)));
  return out;
}

async function makeTarball(files: Array<{ path: string; content?: string; symlinkTo?: string }>): Promise<string> {
  const srcDir = await mkdtemp(join(tmpdir(), "outfitter-tar-src-"));
  for (const f of files) {
    const abs = join(srcDir, f.path);
    await mkdir(join(abs, ".."), { recursive: true });
    if (f.symlinkTo) await symlink(f.symlinkTo, abs);
    else await writeFile(abs, f.content ?? "");
  }
  const tarPath = join(srcDir, "..", `out-${Date.now()}.tar.gz`);
  await execFileAsync("tar", ["-czf", tarPath, "-C", srcDir, "."]);
  return tarPath;
}

test("restoreWorkspace: extracts a well-formed tarball (dev mode, local path)", async () => {
  const tarPath = await makeTarball([{ path: "hello.txt", content: "hi" }]);
  const cwd = await mkdtemp(join(tmpdir(), "outfitter-restore-"));
  await restoreWorkspace(tarPath, cwd, { devMode: true });
  assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "hi");
});

test("restoreWorkspace: rejects a snapshot URL that isn't https or (dev-mode) local (SSRF guard)", async () => {
  const tarPath = await makeTarball([{ path: "hello.txt", content: "hi" }]);
  const cwd = await mkdtemp(join(tmpdir(), "outfitter-restore-"));
  await assert.rejects(() => restoreWorkspace(tarPath, cwd, { devMode: false, allowlist: [] }));
});

test("restoreWorkspace: rejects an https URL whose host isn't allowlisted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "outfitter-restore-"));
  await assert.rejects(() =>
    restoreWorkspace("https://evil.example/snap.tar.gz", cwd, { devMode: false, allowlist: ["storage.googleapis.com"] }),
  );
});

test("restoreWorkspace: refuses a tarball entry with a `..` path segment (path traversal)", async () => {
  const tarPath = await rawTarGz([{ name: "../outside/evil.txt", content: "pwned" }]);
  const cwd = await mkdtemp(join(tmpdir(), "outfitter-restore-"));
  await assert.rejects(() => restoreWorkspace(tarPath, cwd, { devMode: true }), /unsafe path|refus/i);
  // nothing should have been written into cwd
  assert.deepEqual(await readdir(cwd), []);
});

test("restoreWorkspace: refuses a tarball entry that is a symlink", async () => {
  const tarPath = await makeTarball([{ path: "link.txt", symlinkTo: "/etc/passwd" }]);
  const cwd = await mkdtemp(join(tmpdir(), "outfitter-restore-"));
  await assert.rejects(() => restoreWorkspace(tarPath, cwd, { devMode: true }), /symlink/i);
});
