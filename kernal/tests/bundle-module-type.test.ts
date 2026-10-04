/**
 * v0.3.0 shipped without a package.json at the bundle root. bin/kernal runs `kernal login` as
 * `node .pi/extensions/kernal-login/cli.ts`, Node took the module type from the nearest
 * package.json above the install (~/package.json, "type": "commonjs" on the owner's laptop) and
 * failed with "Cannot use import statement outside a module". scripts/package.sh now writes a
 * {"type": "module"} package.json into the bundle; this reproduces the layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageSh = readFileSync(join(root, "scripts", "package.sh"), "utf8");

test("package.sh writes a type:module package.json at the bundle root", () => {
  assert.match(packageSh, /"type": "module"[^\n]*> "\$STAGE\/package\.json"/);
});

test("the login CLI runs under a commonjs package.json once the bundle has its own", () => {
  const parent = mkdtempSync(join(tmpdir(), "kernal-bundle-"));
  try {
    writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "home", type: "commonjs" }));
    const bundle = join(parent, "kernal-x");
    cpSync(join(root, ".pi", "extensions"), join(bundle, ".pi", "extensions"), { recursive: true });
    const cli = join(bundle, ".pi", "extensions", "kernal-login", "cli.ts");
    const env = { ...process.env, HOME: parent, KERNAL_HOME: join(parent, ".kernal"), OUTFITTER_API: "http://127.0.0.1:9" };

    const without = spawnSync(process.execPath, [cli, "whoami"], { cwd: bundle, env, encoding: "utf8" });
    assert.match(without.stderr, /Cannot use import statement outside a module/, "reproduces the v0.3.0 failure");

    writeFileSync(join(bundle, "package.json"), JSON.stringify({ name: "kernal-bundle", private: true, type: "module" }));
    const withPkg = spawnSync(process.execPath, [cli, "whoami"], { cwd: bundle, env, encoding: "utf8" });
    assert.doesNotMatch(withPkg.stderr, /SyntaxError/);
    assert.match(withPkg.stdout + withPkg.stderr, /not signed in/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
