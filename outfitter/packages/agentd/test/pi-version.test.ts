import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPiVersion, versionFromPackageJson } from "../src/pi-version.js";

/** Lays out node_modules/.bin/pi -> ../@earendil-works/pi-coding-agent/dist/bundle/cli.js, as npm does. */
async function fakeInstall(pkg: object): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "outfitter-pi-version-"));
  const pkgDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(pkgDir, "dist", "bundle"), { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify(pkg));
  const cli = join(pkgDir, "dist", "bundle", "cli.js");
  await writeFile(cli, "#!/usr/bin/env node\nconsole.log('9.9.9-from-spawn')\n");
  await chmod(cli, 0o755);
  await mkdir(join(root, "node_modules", ".bin"));
  const bin = join(root, "node_modules", ".bin", "pi");
  await symlink("../@earendil-works/pi-coding-agent/dist/bundle/cli.js", bin);
  return bin;
}

test("getPiVersion reads pi's own package.json through the .bin symlink, without spawning pi", async () => {
  const bin = await fakeInstall({ name: "@earendil-works/pi-coding-agent", version: "0.87.0" });
  assert.equal(await versionFromPackageJson(bin), "0.87.0");
  assert.equal(await getPiVersion(bin), "0.87.0", "not the spawned binary's 9.9.9-from-spawn");
});

test("getPiVersion falls back to `pi --version` when no pi package.json is found, and to 'unknown' after that", async () => {
  const bin = await fakeInstall({ name: "something-else", version: "1.0.0" });
  assert.equal(await versionFromPackageJson(bin), undefined, "another package's package.json is not pi's");
  assert.equal(await getPiVersion(bin), "9.9.9-from-spawn");
  assert.equal(await getPiVersion(join(tmpdir(), "no-such-pi-binary")), "unknown");
});
