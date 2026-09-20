import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { restoreWorkspace } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

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
  // tar preserves a `../`-relative member name when the archive is built with one (confirmed with
  // this system's tar); construct exactly that rather than a same-directory file, which tar would
  // just store under its own (safe) relative name.
  const root = await mkdtemp(join(tmpdir(), "outfitter-tar-traversal-"));
  const base = join(root, "base");
  const outside = join(root, "outside");
  await mkdir(base, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "evil.txt"), "pwned");
  const tarPath = join(root, "out.tar.gz");
  await execFileAsync("tar", ["-czf", tarPath, "-C", base, "../outside/evil.txt"]);

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
