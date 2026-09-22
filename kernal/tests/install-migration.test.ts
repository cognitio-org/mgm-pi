/**
 * End-to-end migration test for the mgm -> kernal rename (docs/rename.md): builds a fake legacy
 * install ("~/.mgm/mgm-0.1.17-<platform>/", the shape a real v0.1.17 laptop install has — a
 * `current` symlink, `.pi/` with a settings edit, `state/sessions/<project>/<file>.jsonl`, a
 * `.env` with MGM_USER and a secret-looking key, and a legacy `~/.local/bin/mgm`), then runs the
 * real scripts/install.sh against it (with a locally built fake bundle, no network / no real pi
 * binary) and checks every migration guarantee in the task: the new install exists, old sessions
 * are reachable from it, the .env is carried over with MGM_* keys renamed to KERNAL_* (values
 * untouched), the settings edit survived, both launchers work, ~/.mgm is left in place with a
 * MOVED marker, and a second run changes nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, lstatSync, symlinkSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const os = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim().toLowerCase();
const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim().replace("x86_64", "x64").replace("aarch64", "arm64");
const platform = `${os}-${arch}`;
const SECRET = "sk-secretsecretsecretsecretsecret";

function buildFakeBundle(work: string, version: string): string {
  const name = `kernal-${version}-${platform}`;
  const stage = join(work, "build", name);
  mkdirSync(join(stage, ".pi", "extensions"), { recursive: true });
  mkdirSync(join(stage, "bin"), { recursive: true });
  // settings-merge.ts (and its deps) is what install.sh runs, under plain Node, to three-way merge
  // the carried-over settings.json onto this bundle's shipped defaults.
  cpSync(join(root, ".pi", "extensions", "connect"), join(stage, ".pi", "extensions", "connect"), { recursive: true });
  writeFileSync(join(stage, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "litellm", defaultModel: "gpt-5.4-nano" }, null, 2));
  writeFileSync(join(stage, ".pi", "settings.shipped.json"), JSON.stringify({ defaultProvider: "litellm", defaultModel: "gpt-5.4-nano" }, null, 2));
  writeFileSync(join(stage, "bin", "kernal"), "#!/bin/sh\necho kernal-ran\n", { mode: 0o755 });
  writeFileSync(join(stage, "VERSION"), version + "\n");
  const tgz = join(work, "build", `${name}.tar.gz`);
  execFileSync("tar", ["czf", tgz, "-C", join(work, "build"), name]);
  return tgz;
}

/** A v0.1.17-shaped legacy ~/.mgm install: current -> mgm-0.1.17-<platform>, state/sessions, a
 *  .env with MGM_USER and a secret key, a settings.json edit, and the ~/.local/bin/mgm symlink a
 *  real install would have. */
function buildLegacyInstall(home: string): { legacyHome: string; binDir: string } {
  const legacyHome = join(home, ".mgm");
  const versionDir = join(legacyHome, "mgm-0.1.17-" + platform);
  mkdirSync(join(versionDir, ".pi", "extensions"), { recursive: true });
  mkdirSync(join(versionDir, "bin"), { recursive: true });
  writeFileSync(join(versionDir, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "litellm", defaultModel: "claude-sonnet-5" }, null, 2));
  writeFileSync(join(versionDir, "bin", "mgm"), "#!/bin/sh\necho mgm-ran\n", { mode: 0o755 });
  writeFileSync(join(versionDir, "VERSION"), "0.1.17\n");
  writeFileSync(join(versionDir, ".env"), `MGM_USER=Matthew\nLITELLM_AGENT_KEY=${SECRET}\n`);
  symlinkSync(versionDir, join(legacyHome, "current"), "dir");

  const state = join(legacyHome, "state");
  const project = join(state, "sessions", "my-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "abc123.jsonl"), '{"type":"session_start"}\n');
  writeFileSync(join(legacyHome, ".update-check.json"), JSON.stringify({ checkedAt: 1, latest: "v0.1.17" }));

  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join(versionDir, "bin", "mgm"), join(binDir, "mgm"));
  return { legacyHome, binDir };
}

describe("install.sh migrates a legacy ~/.mgm install to ~/.kernal", () => {
  const work = mkdtempSync(join(tmpdir(), "kernal-migrate-"));
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const { legacyHome, binDir } = buildLegacyInstall(home);
  const kernalHome = join(home, ".kernal");
  const tgz = buildFakeBundle(work, "0.2.0");

  const env = {
    ...process.env,
    HOME: home,
    MGM_HOME: join(home, ".mgm"),   // exactly the legacy default: the trigger for migration
    KERNAL_VERSION: "0.2.0",
    KERNAL_BUNDLE_FILE: tgz,
    GH_TOKEN: "",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const runInstall = () => execFileSync("bash", [join(root, "scripts", "install.sh")], { env, encoding: "utf8" });

  const out = runInstall();

  test("the new install exists at the default ~/.kernal, not inside the legacy MGM_HOME", () => {
    assert.ok(existsSync(join(kernalHome, "current")), out);
    assert.ok(lstatSync(join(kernalHome, "current")).isSymbolicLink());
  });

  test("old sessions are carried over and reachable from the new bundle's .pi/sessions", () => {
    const carried = join(kernalHome, "state", "sessions", "my-project", "abc123.jsonl");
    assert.ok(existsSync(carried), "session file copied into the new state dir");
    const linked = join(kernalHome, "current", ".pi", "sessions");
    assert.ok(lstatSync(linked).isSymbolicLink());
    assert.ok(existsSync(join(linked, "my-project", "abc123.jsonl")), "reachable from the new bundle's own .pi/sessions");
  });

  test(".env is carried over with MGM_* keys renamed to KERNAL_*; the secret's value is untouched", () => {
    const env2 = readFileSync(join(kernalHome, "current", ".env"), "utf8");
    assert.match(env2, /^KERNAL_USER=Matthew$/m);
    assert.doesNotMatch(env2, /^MGM_USER=/m);
    assert.match(env2, new RegExp(`^LITELLM_AGENT_KEY=${SECRET}$`, "m"));
    assert.ok(!out.includes(SECRET), "the secret's value is never printed by the installer");
  });

  test("the settings.json edit survived the migration's three-way merge", () => {
    const settings = JSON.parse(readFileSync(join(kernalHome, "current", ".pi", "settings.json"), "utf8"));
    assert.equal(settings.defaultModel, "claude-sonnet-5", "the user's choice, not the new bundle's shipped default");
  });

  test("~/.local/bin/kernal works", () => {
    const result = execFileSync(join(binDir, "kernal"), { encoding: "utf8" });
    assert.equal(result.trim(), "kernal-ran");
  });

  test("~/.local/bin/mgm is a permanent, silent alias for the same launcher", () => {
    const result = execFileSync(join(binDir, "mgm"), { encoding: "utf8", env });
    assert.equal(result.trim(), "kernal-ran", "runs the kernal launcher");
    const stderr = execFileSync("bash", ["-c", `${JSON.stringify(join(binDir, "mgm"))} 2>&1 1>/dev/null`], { encoding: "utf8", env });
    assert.equal(stderr, "", "no notice: mgm is a supported name, not a deprecated one");
    assert.equal(realpathSync(join(binDir, "mgm")), realpathSync(join(binDir, "kernal")), "both names point at one launcher");
  });

  test("~/.mgm is left in place with a MOVED marker; current now points at the new install", () => {
    assert.ok(existsSync(legacyHome), "nothing under ~/.mgm was deleted");
    assert.ok(existsSync(join(legacyHome, "MOVED")));
    assert.match(readFileSync(join(legacyHome, "MOVED"), "utf8"), /kernal/);
    assert.equal(readlinkSync(join(legacyHome, "current")), join(kernalHome, "current"));
  });

  test("a second run is a no-op", () => {
    const before = statSync(join(legacyHome, "MOVED")).mtimeMs;
    const beforeEnv = readFileSync(join(kernalHome, "current", ".env"), "utf8");
    const out2 = runInstall();
    assert.doesNotMatch(out2, /migrating the legacy install/, "migration does not run twice");
    assert.equal(statSync(join(legacyHome, "MOVED")).mtimeMs, before, "MOVED is not rewritten");
    assert.equal(readFileSync(join(kernalHome, "current", ".env"), "utf8"), beforeEnv, ".env unchanged");
  });
});

describe("install.sh renames legacy .env keys on an in-place upgrade at a custom home", () => {
  // Review of PR #22: an install that always lived at a custom MGM_HOME is upgraded in place (no
  // ~/.mgm to migrate), so the key rename must not depend on the migration branch.
  const work = mkdtempSync(join(tmpdir(), "kernal-custom-"));
  const home = join(work, "home");
  const custom = join(home, "tools", "mgm");
  const versionDir = join(custom, "mgm-0.1.17-" + platform);
  mkdirSync(join(versionDir, ".pi", "extensions"), { recursive: true });
  mkdirSync(join(versionDir, "bin"), { recursive: true });
  writeFileSync(join(versionDir, "VERSION"), "0.1.17\n");
  writeFileSync(join(versionDir, ".env"), `MGM_USER=Matej\nMGM_VOICE=on\nKERNAL_VOICE=off\nLITELLM_AGENT_KEY=${SECRET}\n`);
  symlinkSync(versionDir, join(custom, "current"), "dir");
  const tgz = buildFakeBundle(work, "0.2.0");
  execFileSync("bash", [join(root, "scripts", "install.sh")], {
    env: { ...process.env, HOME: home, MGM_HOME: custom, KERNAL_VERSION: "0.2.0", KERNAL_BUNDLE_FILE: tgz, GH_TOKEN: "", PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: "utf8",
  });
  const envFile = readFileSync(join(custom, "current", ".env"), "utf8");

  test("installs in place at the custom home", () => {
    assert.equal(readFileSync(join(custom, "current", "VERSION"), "utf8").trim(), "0.2.0");
  });
  test("MGM_* keys are renamed; an existing KERNAL_* key wins over its legacy twin", () => {
    assert.match(envFile, /^KERNAL_USER=Matej$/m);
    assert.match(envFile, /^KERNAL_VOICE=off$/m);
    assert.doesNotMatch(envFile, /^MGM_/m);
    assert.equal(envFile.match(/^KERNAL_VOICE=/gm)?.length, 1, "no duplicate key");
  });
  test("other values are untouched", () => {
    assert.match(envFile, new RegExp(`^LITELLM_AGENT_KEY=${SECRET}$`, "m"));
  });
});

