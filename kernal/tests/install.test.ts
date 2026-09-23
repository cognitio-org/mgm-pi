/**
 * Guards on scripts/install.sh. It is shell, so these are structural assertions on the parts that
 * have already gone wrong once: a bundle lives in a versioned directory, so anything user-owned
 * written inside it is stranded by the next upgrade. Sessions were lost that way, and
 * `--session <id>` only searches the current agent dir, so the history looked deleted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { updateSettings } from "../.pi/extensions/connect/settings.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "scripts", "install.sh"), "utf8");

describe("install.sh", () => {
  test("user-owned state lives outside the versioned bundle and is linked in", () => {
    assert.match(script, /STATE="\$\{STATE:-\$HOME_DIR\/state\}"/, "one state directory, overridable (via kenv STATE, i.e. KERNAL_STATE with an MGM_STATE fallback)");
    for (const name of ["sessions", "bug-reports", "agents"]) {
      assert.ok(script.includes(name), `${name} is handled`);
    }
    assert.match(script, /ln -sfn "\$STATE\/\$name" "\$HOME_DIR\/current\/\.pi\/\$name"/, "directories are symlinked into the bundle");
    assert.match(script, /ln -sf "\$STATE\/\$name" "\$HOME_DIR\/current\/\.pi\/\$name"/, "files too");
    for (const file of ["auth.json", "trust.json", "models-store.json", "mcp-cache.json"]) {
      assert.ok(script.includes(file), `${file} is carried over rather than lost`);
    }
  });

  test("existing state is gathered from older bundles, and never overwritten", () => {
    assert.match(script, /for old_dir in "\$HOME_DIR"\/kernal-\*-"\$platform"/, "older bundles are searched");
    assert.match(script, /\[\[ ! -f "\$target\/\$\(basename "\$f"\)" \]\]/, "a session already in state is left alone");
    assert.match(script, /! -L "\$old_dir\/\.pi\/sessions"/, "an already-linked bundle is not copied from itself");
  });

  test("the user's .env still survives an upgrade", () => {
    // Carried over through rename_env_keys (MGM_* -> KERNAL_*, values untouched); the behaviour is
    // covered end to end in install-migration.test.ts.
    assert.match(script, /keep_env=\$\(rename_env_keys "\$HOME_DIR\/current\/\.env"\)/);
    assert.match(script, /grep -q "\^\$k=\." "\$HOME_DIR\/current\/\.env"/, "shipped keys are added, never replacing yours");
  });

  test("bash 3.2 safety: every array expansion carries the guard macOS needs", () => {
    // macOS ships bash 3.2, where an empty array is "unbound" under set -u. This broke a real
    // install: `auth[@]: unbound variable` on the first download.
    const uses = script.split("\n").filter((l) => l.includes("auth[@]") && !l.trim().startsWith("#"));
    assert.ok(uses.length >= 3, "the array is still used");
    for (const line of uses) {
      assert.ok(line.includes('${auth[@]+"${auth[@]}"}'), `unguarded expansion: ${line.trim().slice(0, 70)}`);
    }
  });

  test("settings are merged, not replaced or linked: the shipped copy is compared, the user's changes carried", () => {
    assert.match(script, /cp "\$HOME_DIR\/current\/\.pi\/settings\.json" "\$tmp\/settings\.ours\.json"/, "taken before the old version is replaced");
    assert.ok(script.indexOf("settings.ours.json") < script.indexOf('rm -rf "$HOME_DIR/$name"'), "read before a same-version reinstall deletes it");
    assert.match(script, /BUN_BE_BUN=1 "\$HOME_DIR\/current\/pi\/pi" "\$new_pi\/extensions\/connect\/settings-merge\.ts"/, "the bundle's own pi binary runs the merge (no Node in a bundle)");
    assert.match(script, /settings\.previous\.json/, "the user's old settings are kept in state whatever happens");
    const pkg = readFileSync(join(root, "scripts", "package.sh"), "utf8");
    assert.match(pkg, /cp "\$STAGE\/\.pi\/settings\.json" "\$STAGE\/\.pi\/settings\.shipped\.json"/, "every bundle ships its pristine copy");
    assert.match(pkg, /cp "\$STAGE\/\.pi\/settings\.shipped\.json" "\$STAGE\/\.pi\/settings\.json"/, "the smoke run's writes are not shipped");
  });

  test("personal agents in a source checkout are never committed", () => {
    const r = execFileSync("git", ["check-ignore", "-q", "kernal/.pi/agents/mine.md"], { cwd: join(root, ".."), stdio: "pipe" });
    assert.equal(r.length, 0, "git check-ignore exits 0: ignored");
  });
});

/**
 * kenv() — the shell-side half of the KERNAL_ (falling back to MGM_) env-var fallback (see
 * .pi/extensions/_shared/env.ts for the TypeScript half, used by every extension). install.sh and
 * bin/kernal each define
 * their own copy (they ship and run as standalone scripts — install.sh is downloaded on its own by
 * `kernal update`, so it cannot source a sibling file); both copies are exercised here by sourcing
 * just the function out of the real script text, so a drift between the two would still be caught
 * by running this test against both files.
 */
describe("kenv() (the shell fallback helper, in install.sh and bin/kernal)", () => {
  const kernalFn = script.slice(script.indexOf("kenv() {"), script.indexOf("\n}\n") + 3);
  const binScript = readFileSync(join(root, "bin", "kernal"), "utf8");
  const kernalFnBin = binScript.slice(binScript.indexOf("kenv() {"), binScript.indexOf("\n}\n") + 3);

  function run(fnSrc: string, body: string, env: Record<string, string> = {}) {
    return execFileSync("bash", ["-c", `${fnSrc}\n${body}`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  }

  for (const [label, fnSrc] of [["install.sh", kernalFn], ["bin/kernal", kernalFnBin]] as const) {
    test(`${label}: prefers KERNAL_<NAME>, falls back to MGM_<NAME> with a once-per-name warning`, () => {
      assert.ok(fnSrc.includes("kenv() {"), "function extracted");
      assert.equal(run(fnSrc, 'kenv FOO || echo "<unset>"'), "<unset>\n");
      assert.equal(run(fnSrc, "kenv FOO", { KERNAL_FOO: "new", MGM_FOO: "old" }), "new");
      const legacy = run(fnSrc, "kenv FOO; kenv FOO", { MGM_FOO: "legacy" }); // called twice
      assert.equal(legacy, "legacylegacy", "both calls return the legacy value");
      const warnOnce = execFileSync("bash", ["-c", `${fnSrc}\nkenv FOO >/dev/null 2>/tmp/kenv-warn.$$; kenv FOO >/dev/null 2>>/tmp/kenv-warn.$$; cat /tmp/kenv-warn.$$; rm -f /tmp/kenv-warn.$$`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", MGM_FOO: "legacy" } });
      assert.equal((warnOnce.match(/MGM_FOO is now KERNAL_FOO/g) ?? []).length, 1, "warns exactly once per name, not per call");
    });
  }
});

/**
 * A real upgrade, offline: two locally built bundles installed one over the other into a throwaway
 * KERNAL_HOME with the real install.sh. The bundles carry no pi binary, so the merge runs under Node,
 * which is what the fallback path does on a machine that has it.
 */
describe("install.sh upgrade (real script, local bundles)", () => {
  const os = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim().toLowerCase();
  const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim().replace("x86_64", "x64").replace("aarch64", "arm64");
  const platform = `${os}-${arch}`;
  const work = mkdtempSync(join(tmpdir(), "kernal-upgrade-"));
  const home = join(work, "kernal-home");
  const env = { ...process.env, HOME: work, KERNAL_HOME: home, KERNAL_BIN: join(work, "bin"), GH_TOKEN: "", PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };

  const shipped = (model: string, subDefault: string) => ({
    defaultProvider: "litellm", defaultModel: model, packages: ["npm:pi-subagents"],
    subagents: { defaultModel: subDefault, agentOverrides: { worker: { model: "litellm/claude-sonnet-5" } } },
  });
  function bundle(version: string, settings: object, opts: { shippedCopy?: boolean; agents?: Record<string, string> } = {}) {
    const name = `kernal-${version}-${platform}`;
    const stage = join(work, "build", name);
    mkdirSync(join(stage, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(stage, "bin"), { recursive: true });
    cpSync(join(root, ".pi", "extensions", "connect"), join(stage, ".pi", "extensions", "connect"), { recursive: true });
    writeFileSync(join(stage, ".pi", "settings.json"), JSON.stringify(settings, null, 2));
    if (opts.shippedCopy !== false) writeFileSync(join(stage, ".pi", "settings.shipped.json"), JSON.stringify(settings, null, 2));
    for (const [f, text] of Object.entries(opts.agents ?? {})) { mkdirSync(join(stage, ".pi", "agents"), { recursive: true }); writeFileSync(join(stage, ".pi", "agents", f), text); }
    writeFileSync(join(stage, "bin", "kernal"), "#!/bin/sh\necho kernal\n", { mode: 0o755 });
    writeFileSync(join(stage, "VERSION"), version + "\n");
    const tgz = join(work, "build", `${name}.tar.gz`);
    execFileSync("tar", ["czf", tgz, "-C", join(work, "build"), name]);
    return tgz;
  }
  const install = (version: string, tgz: string) => execFileSync("bash", [join(root, "scripts", "install.sh")], { env: { ...env, KERNAL_VERSION: version, KERNAL_BUNDLE_FILE: tgz }, encoding: "utf8" });
  const current = () => join(home, "current");
  const settings = () => JSON.parse(readFileSync(join(current(), ".pi", "settings.json"), "utf8"));

  test("an old bundle without a shipped copy: its agents move to state, the user's default model survives", () => {
    install("0.9.0", bundle("0.9.0", shipped("gpt-5.4-nano", "litellm/gemini-3.8-flash"), { shippedCopy: false, agents: { "old-helper.md": "---\nname: old-helper\ndescription: d\n---\nhi\n" } }));
    // the user picks a model with /connect in the old version (connect's saveDefault, into that bundle)
    process.env.PI_CODING_AGENT_DIR = join(current(), ".pi");
    updateSettings((s) => { s.defaultProvider = "litellm"; s.defaultModel = "claude-sonnet-5"; });
    const out = install("1.0.0", bundle("1.0.0", shipped("gpt-5.4-nano", "litellm/gemini-4-flash")));
    assert.match(out, /settings: kept your change \(defaultModel\)/, out);
    assert.equal(settings().defaultModel, "claude-sonnet-5");
    assert.equal(settings().subagents.defaultModel, "litellm/gemini-4-flash");
    assert.ok(existsSync(join(home, "state", "agents", "old-helper.md")), "gathered from the old bundle");
    assert.ok(lstatSync(join(current(), ".pi", "agents")).isSymbolicLink());
    assert.equal(readlinkSync(join(current(), ".pi", "agents")), join(home, "state", "agents"));
  });

  test("a default model chosen before an upgrade is still chosen after; a new shipped default arrives", () => {
    // in 1.0.0 the user changes the worker's model in the admin and writes an agent of their own
    process.env.PI_CODING_AGENT_DIR = join(current(), ".pi");
    updateSettings((s: any) => { s.subagents.agentOverrides.worker.thinking = "high"; });
    writeFileSync(join(current(), ".pi", "agents", "mine.md"), "---\nname: mine\ndescription: d\n---\nmine\n");
    const v2 = shipped("gpt-5.5-nano", "litellm/gemini-5-flash");
    (v2 as any).compaction = { reserveTokens: 16384 };
    const out = install("1.1.0", bundle("1.1.0", v2));
    assert.match(out, /kept your 2 changes/, out);
    const s = settings();
    assert.equal(s.defaultModel, "claude-sonnet-5", "chosen before the upgrade, still chosen after");
    assert.equal(s.subagents.defaultModel, "litellm/gemini-5-flash", "a new shipped default the user never touched");
    assert.deepEqual(s.compaction, { reserveTokens: 16384 }, "a new shipped key");
    assert.deepEqual(s.subagents.agentOverrides.worker, { model: "litellm/claude-sonnet-5", thinking: "high" });
    assert.ok(existsSync(join(current(), ".pi", "agents", "mine.md")), "the user's agent is in the new version");
    assert.ok(existsSync(join(current(), ".pi", "agents", "old-helper.md")));
    assert.deepEqual(JSON.parse(readFileSync(join(current(), ".pi", "settings.shipped.json"), "utf8")), v2, "the new bundle's pristine copy is untouched");
    assert.ok(existsSync(join(home, "state", "settings.previous.json")));
  });

  test("reinstalling the same version keeps the user's settings too", () => {
    const out = install("1.1.0", join(work, "build", `kernal-1.1.0-${platform}.tar.gz`));
    assert.match(out, /kept your/);
    assert.equal(settings().defaultModel, "claude-sonnet-5");
  });
});

describe("the mgm name", () => {
  test("bin/mgm is a relative link to the kernal launcher, so source checkouts and bundles both carry it", () => {
    const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
    assert.equal(readlinkSync(join(binDir, "mgm")), "kernal");
  });
  test("package.sh copies every bin/* entry into the bundle", () => {
    const pkg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "package.sh"), "utf8");
    assert.match(pkg, /cp "\$ROOT"\/bin\/\* "\$STAGE\/bin\/"/);
  });
});

describe("updates in a release bundle", () => {
  const pack = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "package.sh"), "utf8");
  const launcher = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "kernal"), "utf8");

  test("packages are pinned to their installed versions, in both the live and the shipped settings", () => {
    // pi skips pinned packages in its startup "Package Updates Available" notice and in
    // `pi update --extensions`, so a bundle stops advising a command that does nothing for it.
    assert.match(pack, /npm:\$\{name\}@\$\{JSON\.parse\(fs\.readFileSync\(manifest/);
    assert.match(pack, /"\$STAGE\/\.pi\/settings\.json" "\$STAGE\/\.pi\/settings\.shipped\.json"/, "the pristine copy is pinned too, or the next upgrade would see a difference");
    const pinAt = pack.indexOf("4b. Pin every package"), installAt = pack.indexOf("npm ci --legacy-peer-deps");
    assert.ok(installAt > 0 && pinAt > installAt, "pinning reads what npm ci installed, so it must come after it");
  });

  test("a bundle skips pi's own version check; a source checkout keeps it", () => {
    assert.match(launcher, /\[\[ -f "\$ROOT\/VERSION" \]\] && export PI_SKIP_VERSION_CHECK=1/);
  });

  test("kernal update --extensions says what updates packages in a bundle, instead of silently doing nothing", () => {
    assert.match(launcher, /they update with kernal itself\. Run: kernal update/);
  });
});

/**
 * Old versions are pruned. Every release is its own ~450 MB directory, and before this nothing ever
 * removed one (a real ~/.mgm reached 5.4 GB over thirteen versions). These run the real install.sh
 * and the real bin/kernal (copied into each bundle, so `kernal prune` runs from an install exactly as
 * it would for a user) under macOS's /bin/bash 3.2, against throwaway roots only: HOME is a temp dir,
 * so ~/.kernal and ~/.mgm here are never the real ones.
 */
describe("pruning old versions (real install.sh and bin/kernal, /bin/bash)", () => {
  const os = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim().toLowerCase();
  const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim().replace("x86_64", "x64").replace("aarch64", "arm64");
  const platform = `${os}-${arch}`;
  const BASH = "/bin/bash"; // 3.2 on macOS: the shell a user's `curl | bash` actually gets
  const launcher = readFileSync(join(root, "bin", "kernal"), "utf8");

  /** A fresh HOME with its own ~/.kernal, and helpers bound to it. */
  function sandbox() {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "kernal-prune-")));
    const home = join(work, ".kernal");
    const binDir = join(work, "bin");
    const base = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: work, KERNAL_HOME: home, KERNAL_BIN: binDir, GH_TOKEN: "", TMPDIR: tmpdir() };
    const bundle = (version: string) => {
      const name = `kernal-${version}-${platform}`;
      const tgz = join(work, "build", `${name}.tar.gz`);
      if (existsSync(tgz)) return tgz;
      const stage = join(work, "build", name);
      mkdirSync(join(stage, ".pi", "extensions"), { recursive: true });
      mkdirSync(join(stage, "bin"), { recursive: true });
      cpSync(join(root, ".pi", "extensions", "connect"), join(stage, ".pi", "extensions", "connect"), { recursive: true });
      const s = JSON.stringify({ defaultProvider: "litellm", defaultModel: "gpt-5.4-nano" }, null, 2);
      writeFileSync(join(stage, ".pi", "settings.json"), s);
      writeFileSync(join(stage, ".pi", "settings.shipped.json"), s);
      writeFileSync(join(stage, "bin", "kernal"), launcher, { mode: 0o755 });
      writeFileSync(join(stage, "payload.bin"), Buffer.alloc(1024 * 1024, 1)); // something for du to count
      writeFileSync(join(stage, "VERSION"), version + "\n");
      execFileSync("tar", ["czf", tgz, "-C", join(work, "build"), name]);
      return tgz;
    };
    const run = (args: string[], env: Record<string, string> = {}) => {
      const r = spawnSync(BASH, args, { env: { ...base, ...env }, encoding: "utf8" });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const install = (version: string, env: Record<string, string> = {}) => {
      const r = run([join(root, "scripts", "install.sh")], { KERNAL_VERSION: version, KERNAL_BUNDLE_FILE: bundle(version), ...env });
      assert.equal(r.status, 0, r.out);
      return r.out;
    };
    const kernal = (args: string[], env: Record<string, string> = {}) => run([join(binDir, "kernal"), ...args], env);
    const versions = () => readdirSync(home).filter((n) => n.startsWith("kernal-")).sort();
    const dir = (v: string) => `kernal-${v}-${platform}`;
    const current = () => realpathSync(join(home, "current")).split("/").pop();
    return { work, home, binDir, install, kernal, run, versions, dir, current };
  }

  test("an upgrade keeps exactly the new version and the one it replaced; state, .env and sessions are untouched", () => {
    const b = sandbox();
    b.install("0.1.0");
    // a session written through the bundle's link, and the user's keys
    const sess = join(b.home, "current", ".pi", "sessions", "proj");
    mkdirSync(sess, { recursive: true });
    writeFileSync(join(sess, "s1.jsonl"), '{"type":"session"}\n');
    writeFileSync(join(b.home, "current", ".env"), "KERNAL_USER=Matthew\n");
    b.install("0.1.1");
    assert.deepEqual(b.versions(), [b.dir("0.1.0"), b.dir("0.1.1")], "two versions: nothing to prune yet");
    b.install("0.1.2");
    const out = b.install("0.1.3");
    assert.deepEqual(b.versions(), [b.dir("0.1.2"), b.dir("0.1.3")], out);
    assert.equal(b.current(), b.dir("0.1.3"));
    assert.match(out, new RegExp(`prune: removed .*${b.dir("0.1.1")}`), out);
    assert.match(out, new RegExp(`kept ${b.dir("0.1.3")}, ${b.dir("0.1.2")}`), out);
    assert.equal(readFileSync(join(b.home, "state", "sessions", "proj", "s1.jsonl"), "utf8"), '{"type":"session"}\n', "rm -rf of a bundle removes its link to state, not state");
    assert.ok(existsSync(join(b.home, "current", ".pi", "sessions", "proj", "s1.jsonl")), "and the new version still sees it");
    assert.match(readFileSync(join(b.home, "current", ".env"), "utf8"), /KERNAL_USER=Matthew/);
    assert.ok(existsSync(join(b.home, "state")) && existsSync(join(b.home, "current")));
  });

  test("versions are ordered by semver, not by name: 0.1.10 is newer than 0.1.9, a pre-release older than its release", () => {
    const b = sandbox();
    for (const v of ["0.1.9", "0.1.10", "0.1.2"]) b.install(v, { KERNAL_KEEP_VERSIONS: "10" });
    // current 0.1.2 is replaced by 0.2.0; with room for three, the third is 0.1.10 (a name sort picks 0.1.9)
    const out = b.install("0.2.0", { KERNAL_KEEP_VERSIONS: "3" });
    assert.deepEqual(b.versions(), [b.dir("0.1.10"), b.dir("0.1.2"), b.dir("0.2.0")].sort(), out);
    // kernal prune has no "replaced" version, so after current it keeps the highest: 0.2.0 > 0.2.0-rc.1 > 0.1.10
    b.install("0.2.0-rc.1", { KERNAL_KEEP_VERSIONS: "10" });
    b.install("0.2.1", { KERNAL_KEEP_VERSIONS: "10" });
    let r = b.kernal(["prune"], { KERNAL_KEEP_VERSIONS: "3" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(b.versions(), [b.dir("0.2.0"), b.dir("0.2.0-rc.1"), b.dir("0.2.1")], r.out);
    r = b.kernal(["prune"]);
    assert.deepEqual(b.versions(), [b.dir("0.2.0"), b.dir("0.2.1")], r.out);
    r = b.kernal(["prune"], { KERNAL_KEEP_VERSIONS: "10" });
    assert.match(r.out, /nothing to remove/, r.out);
  });

  test("a same-version reinstall keeps the version below it (the reinstalled one is not its own rollback)", () => {
    const b = sandbox();
    b.install("0.9.0"); b.install("1.0.0"); b.install("1.1.0");
    assert.deepEqual(b.versions(), [b.dir("1.0.0"), b.dir("1.1.0")]);
    const out = b.install("1.1.0");
    assert.deepEqual(b.versions(), [b.dir("1.0.0"), b.dir("1.1.0")], out);
    assert.equal(b.current(), b.dir("1.1.0"));
    assert.match(out, /nothing to remove/, out);
  });

  test("a rollback install keeps the version rolled back from", () => {
    const b = sandbox();
    b.install("0.1.0"); b.install("0.2.0"); b.install("0.3.0");
    const out = b.install("0.1.5");  // back down: 0.3.0 is what it replaced, so 0.3.0 stays, 0.2.0 goes
    assert.deepEqual(b.versions(), [b.dir("0.1.5"), b.dir("0.3.0")], out);
  });

  test("anything that is not a bundle is left alone; anything that looks like one but is not stops the prune", () => {
    const b = sandbox();
    b.install("0.1.0"); b.install("0.1.1");
    mkdirSync(join(b.home, "notes")); writeFileSync(join(b.home, "notes", "todo.txt"), "mine");
    writeFileSync(join(b.home, ".update-check.json"), "{}");
    const otherName = `kernal-0.0.1-${os === "darwin" ? "linux" : "darwin"}-x64`; // another platform's bundle
    mkdirSync(join(b.home, otherName));
    let out = b.install("0.1.2");
    assert.deepEqual(b.versions(), [b.dir("0.1.1"), b.dir("0.1.2"), otherName].sort(), out);
    assert.equal(readFileSync(join(b.home, "notes", "todo.txt"), "utf8"), "mine");
    assert.ok(existsSync(join(b.home, ".update-check.json")));
    // a stray, bundle-like name: a human should look before anything is removed
    const stray = join(b.home, `${b.dir("0.1.1")}.bak`);
    mkdirSync(stray);
    out = b.install("0.1.3");
    assert.match(out, /is not named kernal-<version>-<platform>; nothing removed/, out);
    assert.match(out, /old versions were left in place; your install is fine/);
    assert.ok(existsSync(join(b.home, b.dir("0.1.1"))) && existsSync(join(b.home, b.dir("0.1.2"))) && existsSync(stray), "nothing removed");
    assert.equal(b.current(), b.dir("0.1.3"), "the install itself succeeded");
  });

  test("a symlink out of the root is never followed or removed, whether it is named like a bundle or inside one", () => {
    const b = sandbox();
    const outside = join(b.work, "elsewhere");
    mkdirSync(outside); writeFileSync(join(outside, "precious.txt"), "keep me");
    b.install("0.1.0");
    symlinkSync(outside, join(b.home, b.dir("0.1.0"), "link-out"));   // inside a bundle that will go
    b.install("0.1.1");
    let out = b.install("0.1.2");
    assert.ok(!existsSync(join(b.home, b.dir("0.1.0"))), out);
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep me", "rm -rf removed the link, not its target");
    // a bundle-named symlink to a directory outside the root
    const fake = join(b.work, "not-a-bundle");
    mkdirSync(fake); writeFileSync(join(fake, "precious.txt"), "keep me too");
    symlinkSync(fake, join(b.home, b.dir("0.0.9")));
    out = b.install("0.1.3");
    assert.match(out, /is a symlink, not a bundle; nothing removed/, out);
    assert.ok(lstatSync(join(b.home, b.dir("0.0.9"))).isSymbolicLink());
    assert.equal(readFileSync(join(fake, "precious.txt"), "utf8"), "keep me too");
    assert.ok(existsSync(join(b.home, b.dir("0.1.1"))), "nothing else was removed either");
  });

  test("current is never removed, nor the running version, and if current cannot be resolved nothing is", () => {
    const b = sandbox();
    b.install("0.1.0"); b.install("0.1.1"); b.install("0.1.2");
    const launcherOf = (v: string) => join(b.home, b.dir(v), "bin", "kernal");
    // current -> 0.1.0 (a rollback); prune run from 0.1.2 with KEEP=1 keeps current and the one running
    b.install("0.1.0", { KERNAL_KEEP_VERSIONS: "10" });
    let r = b.run([launcherOf("0.1.2"), "prune"], { KERNAL_KEEP_VERSIONS: "1" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(b.versions(), [b.dir("0.1.0"), b.dir("0.1.2")], r.out);
    assert.match(r.out, /\(running\)/);
    // a dangling current
    rmSync(join(b.home, "current")); symlinkSync(join(b.home, "kernal-9.9.9-gone"), join(b.home, "current"));
    r = b.run([launcherOf("0.1.2"), "prune"], { KERNAL_KEEP_VERSIONS: "1" });
    assert.equal(r.status, 1);
    assert.match(r.out, /does not resolve to a bundle .*nothing removed/, r.out);
    // current pointing outside the root
    rmSync(join(b.home, "current")); symlinkSync(b.work, join(b.home, "current"));
    r = b.run([launcherOf("0.1.2"), "prune"], { KERNAL_KEEP_VERSIONS: "1" });
    assert.match(r.out, /does not resolve to a bundle .*nothing removed/, r.out);
    // current as a real directory rather than a link
    rmSync(join(b.home, "current")); mkdirSync(join(b.home, "current"));
    r = b.run([launcherOf("0.1.2"), "prune"], { KERNAL_KEEP_VERSIONS: "1" });
    assert.match(r.out, /is not a symlink; nothing removed/, r.out);
    assert.deepEqual(b.versions(), [b.dir("0.1.0"), b.dir("0.1.2")]);
  });

  test("an old bundle holding sessions that are not in state byte for byte is kept", () => {
    const b = sandbox();
    b.install("0.1.0"); b.install("0.1.1");
    // a pre-state bundle with a real sessions directory, whose file state holds a different copy of
    const old = join(b.home, b.dir("0.0.1"));
    mkdirSync(join(old, ".pi", "sessions", "proj"), { recursive: true });
    writeFileSync(join(old, ".pi", "sessions", "proj", "x.jsonl"), "old\n");
    mkdirSync(join(b.home, "state", "sessions", "proj"), { recursive: true });
    writeFileSync(join(b.home, "state", "sessions", "proj", "x.jsonl"), "old\nnewer\n");
    const out = b.install("0.1.2");
    assert.match(out, /kept .*0\.0\.1.*: it holds sessions not copied to state/, out);
    assert.ok(existsSync(join(old, ".pi", "sessions", "proj", "x.jsonl")));
    assert.ok(!existsSync(join(b.home, b.dir("0.1.0"))), "the others are still pruned");
  });

  test("KERNAL_KEEP_VERSIONS sets how many are kept; MGM_KEEP_VERSIONS still works; nonsense prunes nothing", () => {
    const b = sandbox();
    for (const v of ["1.0.0", "1.0.1", "1.0.2", "1.0.3"]) b.install(v, { KERNAL_KEEP_VERSIONS: "3" });
    assert.deepEqual(b.versions(), ["1.0.1", "1.0.2", "1.0.3"].map(b.dir));
    const legacy = b.install("1.0.4", { MGM_KEEP_VERSIONS: "1" });
    assert.match(legacy, /MGM_KEEP_VERSIONS is now KERNAL_KEEP_VERSIONS/);
    assert.deepEqual(b.versions(), [b.dir("1.0.4")], legacy);
    b.install("1.0.5", { KERNAL_KEEP_VERSIONS: "10" });
    for (const bad of ["0", "abc", "-1", "02"]) {
      const out = b.install("1.0.6", { KERNAL_KEEP_VERSIONS: bad });
      assert.match(out, /must be a whole number, 1 or more .*nothing removed/, `${bad}: ${out}`);
    }
    assert.deepEqual(b.versions(), ["1.0.4", "1.0.5", "1.0.6"].map(b.dir));
  });

  test("kernal prune: --dry-run shows what would go and removes nothing; then it removes it and says how much", () => {
    const b = sandbox();
    for (const v of ["2.0.0", "2.1.0", "2.2.0", "2.3.0"]) b.install(v, { KERNAL_KEEP_VERSIONS: "10" });
    let r = b.kernal(["prune", "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`would remove .*${b.dir("2.0.0")} \\(\\d+ MB\\)`), r.out);
    assert.match(r.out, /would remove 2 old version\(s\)/);
    assert.match(r.out, /dry run: nothing was removed/);
    assert.equal(b.versions().length, 4);
    r = b.kernal(["prune"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /removed 2 old version\(s\), \d+ MB; kept /, r.out);
    assert.deepEqual(b.versions(), [b.dir("2.2.0"), b.dir("2.3.0")]);
    assert.equal(b.kernal(["prune", "--bogus"]).status, 2);
    assert.equal(b.kernal(["prune", "--yes"]).status, 2, "--yes belongs to --legacy only");
    const src = spawnSync(BASH, [join(root, "bin", "kernal"), "prune"], { env: { PATH: "/usr/bin:/bin", HOME: b.work }, encoding: "utf8" });
    assert.equal(src.status, 1);
    assert.match(src.stderr, /source checkout/);
  });

  test("the prune code in install.sh and bin/kernal is the same text", () => {
    const block = (s: string) => s.slice(s.indexOf("# --- prune: begin"), s.indexOf("# --- prune: end"));
    assert.ok(block(script).length > 1000);
    assert.ok(block(launcher) === block(script), "the two copies of the prune block have drifted apart");
    assert.ok(script.indexOf('previous_bundle="$(_prune_physical "$HOME_DIR/current"') < script.indexOf('rm -rf "$HOME_DIR/$name"'), "the rollback target is read before a reinstall deletes it");
    assert.ok(script.indexOf('prune_versions "$HOME_DIR"') > script.indexOf('ln -s "$HOME_DIR/current/bin/kernal" "$BIN_DIR/mgm"'), "pruning runs only once the install is complete");
  });

  describe("kernal prune --legacy (the pre-rename ~/.mgm)", () => {
    /** A migrated ~/.mgm: MOVED, current -> the new install, an old bundle with real sessions, a
     *  later one whose sessions are a link into state/, state/sessions, reports/, and a .env in each. */
    function legacySetup() {
      const b = sandbox();
      b.install("0.2.0");
      writeFileSync(join(b.home, "current", ".env"), "KERNAL_USER=Matthew\n");
      const mgm = join(b.work, ".mgm");
      const early = join(mgm, `mgm-0.1.9-${platform}`), late = join(mgm, `mgm-0.1.18-${platform}`);
      mkdirSync(join(early, ".pi", "sessions", "p1"), { recursive: true });
      writeFileSync(join(early, ".pi", "sessions", "p1", "a.jsonl"), "a\n");
      writeFileSync(join(early, ".pi", "auth.json"), "{}");
      mkdirSync(join(mgm, "state", "sessions", "p2"), { recursive: true });
      writeFileSync(join(mgm, "state", "sessions", "p2", "b.jsonl"), "b\n");
      mkdirSync(join(late, ".pi"), { recursive: true });
      symlinkSync(join(mgm, "state", "sessions"), join(late, ".pi", "sessions"));
      for (const d of [early, late]) writeFileSync(join(d, ".env"), "MGM_USER=Matthew\n");
      mkdirSync(join(mgm, "reports")); writeFileSync(join(mgm, "reports", "r.html"), "r");
      writeFileSync(join(mgm, "MOVED"), "moved\n");
      symlinkSync(join(b.home, "current"), join(mgm, "current"));
      // what the migration copied
      for (const [p, f, t] of [["p1", "a.jsonl", "a\n"], ["p2", "b.jsonl", "b\n"]]) {
        mkdirSync(join(b.home, "state", "sessions", p), { recursive: true });
        writeFileSync(join(b.home, "state", "sessions", p, f), t);
      }
      return { ...b, mgm, early, late };
    }

    test("lists exactly what would go and deletes nothing without --yes; with --yes deletes only the bundles", () => {
      const b = legacySetup();
      let r = b.kernal(["prune", "--legacy"]);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /would delete .*\(dry run\)/);
      assert.match(r.out, new RegExp(`${b.early}  .*includes \\.env, \\.pi/auth\\.json, 1 session file\\(s\\), verified identical`), r.out);
      assert.match(r.out, new RegExp(`${b.late}  .*includes \\.env\\)`), r.out);
      assert.match(r.out, /left in place: .*MOVED.*current.*reports.*state/, r.out);
      assert.match(r.out, /Nothing was deleted; to delete exactly these: kernal prune --legacy --yes/);
      assert.ok(existsSync(b.early) && existsSync(b.late));
      r = b.kernal(["prune", "--legacy", "--yes"]);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /deleted 2 bundle\(s\), freed/, r.out);
      assert.ok(!existsSync(b.early) && !existsSync(b.late));
      for (const kept of ["MOVED", "reports/r.html", "state/sessions/p2/b.jsonl"]) assert.ok(existsSync(join(b.mgm, kept)), kept);
      assert.ok(lstatSync(join(b.mgm, "current")).isSymbolicLink());
      assert.ok(existsSync(join(b.home, "current", "VERSION")), "the new install is untouched");
      assert.deepEqual(b.versions(), [b.dir("0.2.0")]);
    });

    test("refuses, removing nothing, when a session is not byte-identical in ~/.kernal/state (even with --yes)", () => {
      const b = legacySetup();
      writeFileSync(join(b.home, "state", "sessions", "p1", "a.jsonl"), "a\nmore\n");  // continued after migrating
      rmSync(join(b.home, "state", "sessions", "p2", "b.jsonl"));
      const r = b.kernal(["prune", "--legacy", "--yes"]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /differs: .*a\.jsonl \(the copy at .* is a longer continuation of it\)/, r.out);
      assert.match(r.out, /missing from .*b\.jsonl/, r.out);
      assert.match(r.out, /2 session file\(s\) above are not byte-identical .*nothing removed/, r.out);
      assert.ok(existsSync(b.early) && existsSync(b.late));
    });

    test("refuses when ~/.mgm was never migrated, when current still points into it, or it holds something unexpected", () => {
      let b = legacySetup();
      rmSync(join(b.mgm, "MOVED"));
      let r = b.kernal(["prune", "--legacy", "--yes"]);
      assert.equal(r.status, 1); assert.match(r.out, /never migrated/);
      assert.ok(existsSync(b.early));

      b = legacySetup();
      rmSync(join(b.mgm, "current")); symlinkSync(b.late, join(b.mgm, "current"));
      r = b.kernal(["prune", "--legacy", "--yes"]);
      assert.equal(r.status, 1); assert.match(r.out, /not to the new install; nothing removed/, r.out);
      assert.ok(existsSync(b.early) && existsSync(b.late));

      b = legacySetup();
      mkdirSync(join(b.mgm, "mgm-old-copy"));
      r = b.kernal(["prune", "--legacy", "--yes"]);
      assert.equal(r.status, 1); assert.match(r.out, /not named mgm-<version>-<platform>; nothing removed/, r.out);
      assert.ok(existsSync(b.early) && existsSync(b.late));

      b = legacySetup();
      rmSync(join(b.home, "current", ".env"));
      r = b.kernal(["prune", "--legacy", "--yes"]);
      assert.equal(r.status, 1); assert.match(r.out, /holds keys and .* does not exist; nothing removed/, r.out);
      assert.ok(existsSync(b.early) && existsSync(b.late));
    });

    test("install.sh never touches ~/.mgm's bundles", () => {
      const b = legacySetup();
      b.install("0.2.1"); b.install("0.2.2");
      assert.ok(existsSync(b.early) && existsSync(b.late));
      assert.ok(!script.includes("prune_legacy"), "only the explicit kernal prune --legacy does");
    });
  });
});

describe("chrome companion install", () => {
  const repo = join(root, "..");
  const extId = readFileSync(join(repo, "chrome", "extension-id"), "utf8").trim();
  const osName = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim().toLowerCase();
  const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim().replace("x86_64", "x64").replace("aarch64", "arm64");
  const platform = `${osName}-${arch}`;
  const nativeHostDir = (homeDir: string) => osName === "darwin"
    ? join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : join(homeDir, ".config", "google-chrome", "NativeMessagingHosts");

  // A node that fails --check, ahead of /usr/bin, so a machine with a system node
  // still takes the "no Node" branch. install.sh needs the rest of /usr/bin.
  function pathWithoutNode(work: string) {
    const bin = join(work, "no-node");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    return `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  }

  function sandbox(opts: { pi?: boolean; withNode?: boolean; env?: Record<string, string> } = {}) {
    const work = mkdtempSync(join(tmpdir(), "kernal-chrome-install-"));
    const home = join(work, ".kernal");
    const binDir = join(work, "bin");
    const withNode = opts.withNode !== false;
    const base: Record<string, string> = {
      ...process.env,
      PATH: withNode ? `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` : pathWithoutNode(work),
      HOME: work,
      KERNAL_HOME: home,
      KERNAL_BIN: binDir,
      GH_TOKEN: "",
      KERNAL_CHROME_OPEN: "0",
    };
    delete base.KERNAL_BUNDLE_FILE;
    delete base.MGM_BUNDLE_FILE;
    delete base.KERNAL_STATE;
    delete base.MGM_STATE;
    delete base.MGM_HOME;
    Object.assign(base, opts.env ?? {});
    const bundle = (version: string) => {
      const name = `kernal-${version}-${platform}`;
      const stage = join(work, "build", name);
      mkdirSync(join(stage, ".pi"), { recursive: true });
      mkdirSync(join(stage, "bin"), { recursive: true });
      writeFileSync(join(stage, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "litellm", defaultModel: "gpt-5.4-nano" }));
      writeFileSync(join(stage, "bin", "kernal"), "#!/bin/sh\necho kernal\n", { mode: 0o755 });
      cpSync(join(repo, "chrome", "extension"), join(stage, "chrome", "extension"), { recursive: true });
      cpSync(join(repo, "chrome", "host"), join(stage, "chrome", "host"), { recursive: true });
      cpSync(join(repo, "chrome", "extension-id"), join(stage, "chrome", "extension-id"));
      if (opts.pi) {
        const pi = join(stage, "pi", "pi");
        mkdirSync(dirname(pi), { recursive: true });
        writeFileSync(pi, "#!/bin/sh\nif [ \"$BUN_BE_BUN\" != 1 ]; then exit 1; fi\nif [ \"$1\" = -e ]; then printf ok; exit 0; fi\nexit 1\n", { mode: 0o755 });
      }
      const tgz = join(work, "build", `${name}.tar.gz`);
      execFileSync("tar", ["czf", tgz, "-C", join(work, "build"), name]);
      return tgz;
    };
    const install = (version: string) => {
      const r = spawnSync("bash", [join(root, "scripts", "install.sh")], {
        env: { ...base, KERNAL_VERSION: version, KERNAL_BUNDLE_FILE: bundle(version) },
        encoding: "utf8",
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    return { work, home, install };
  }

  async function stop(proc: ReturnType<typeof spawn>) {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await Promise.race([once(proc, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }

  test("package.sh ships the companion inside the bundle", () => {
    const pkg = readFileSync(join(root, "scripts", "package.sh"), "utf8");
    assert.match(pkg, /CHROME_SRC=.*chrome/);
    assert.match(pkg, /chrome\/extension/);
    assert.match(pkg, /chrome\/host/);
    assert.match(pkg, /extension-id/);
  });

  test("a second install overwrites the one host manifest; path and extension id stay correct", async () => {
    const b = sandbox();
    const manifestPath = join(nativeHostDir(b.work), "com.kernal.chrome.json");
    const hostMjs = join(b.home, "chrome", "host", "kernal-chrome-host.mjs");
    const first = b.install("9.9.0");
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /does not load it inside Chrome/);
    assert.match(first.out, /Choose Load unpacked/);
    assert.match(first.out, new RegExp(join(b.home, "chrome", "extension").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(first.out, /Reload the Kernal extension/);
    assert.doesNotMatch(first.out, /extension is loaded/);
    assert.equal(lstatSync(join(b.home, "chrome", "extension")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(b.home, "chrome", "extension", "manifest.json"), "utf8"), readFileSync(join(repo, "chrome", "extension", "manifest.json"), "utf8"));
    const shebang = readFileSync(hostMjs, "utf8").split("\n")[0];
    assert.match(shebang, /^#!\//);
    assert.doesNotMatch(shebang, /env/);
    assert.ok(existsSync(shebang.slice(2)), shebang);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, "com.kernal.chrome");
    assert.equal(manifest.type, "stdio");
    assert.equal(manifest.path, hostMjs);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extId}/`]);
    assert.equal(manifest.path.includes(`kernal-9.9.0-${platform}`), false);
    assert.equal(
      readFileSync(join(b.home, "chrome", "host", "socket-path"), "utf8").trim(),
      join(b.home, "chrome.sock"),
    );
    assert.deepEqual(readdirSync(nativeHostDir(b.work)), ["com.kernal.chrome.json"]);

    const proc = spawn(hostMjs, [], { env: { HOME: b.work, PATH: "/usr/bin:/bin", KERNAL_HOME: b.home }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      let err = "";
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(err)), 4000);
        proc.stderr.on("data", (c) => {
          err += c.toString();
          if (err.includes("listening")) { clearTimeout(timer); resolve(); }
        });
        proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exit ${code}: ${err}`)); });
      });
      await ready;
      assert.equal(statSync(join(b.home, "chrome.sock")).mode & 0o777, 0o600);
      const listed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(join(b.home, "chrome.sock"));
        let buf = "";
        const timer = setTimeout(() => reject(new Error(buf)), 4000);
        socket.on("data", (c) => { buf += c.toString(); if (buf.includes("\n")) { clearTimeout(timer); socket.end(); resolve(buf); } });
        socket.on("error", reject);
        socket.on("connect", () => socket.write('{"t":"list"}\n'));
      });
      assert.deepEqual(JSON.parse(listed), { t: "shares", shares: [] });
    } finally {
      await stop(proc);
    }

    writeFileSync(join(b.home, "chrome", "extension", "STALE.txt"), "old");
    writeFileSync(manifestPath, JSON.stringify({ name: "com.kernal.chrome", path: "/tmp/wrong", type: "stdio", allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }));
    const second = b.install("9.9.0");
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /Reload the Kernal extension at chrome:\/\/extensions/);
    assert.match(second.out, /old files until then/);
    assert.doesNotMatch(second.out, /Choose Load unpacked/);
    assert.doesNotMatch(second.out, /extension is loaded/);
    assert.equal(existsSync(join(b.home, "chrome", "extension", "STALE.txt")), false);
    const again = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(again.path, hostMjs);
    assert.deepEqual(again.allowed_origins, [`chrome-extension://${extId}/`]);
    assert.deepEqual(readdirSync(nativeHostDir(b.work)), ["com.kernal.chrome.json"]);
  });

  test("with no runtime the extension is copied and no manifest is written", () => {
    const b = sandbox({ withNode: false });
    const out = b.install("9.9.2");
    assert.equal(out.status, 0, out.out);
    assert.match(out.out, /native host not registered/);
    assert.match(out.out, /missing runtime/);
    assert.match(out.out, /Choose Load unpacked/);
    assert.doesNotMatch(out.out, /extension is loaded/);
    assert.equal(existsSync(join(b.home, "chrome", "extension", "manifest.json")), true);
    assert.equal(existsSync(join(nativeHostDir(b.work), "com.kernal.chrome.json")), false);
  });

  test("a bundle whose only runtime is pi registers a launcher, not a node shebang", () => {
    const b = sandbox({ withNode: false, pi: true });
    const out = b.install("9.9.1");
    assert.equal(out.status, 0, out.out);
    const manifest = JSON.parse(readFileSync(join(nativeHostDir(b.work), "com.kernal.chrome.json"), "utf8"));
    const launcher = join(b.home, "chrome", "host", "kernal-chrome-host");
    assert.equal(manifest.path, launcher);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extId}/`]);
    assert.equal(manifest.path.includes(`kernal-9.9.1-${platform}`), false);
    const text = readFileSync(launcher, "utf8");
    assert.match(text, /BUN_BE_BUN=1/);
    assert.match(text, /current\/pi\/pi/);
    assert.match(text, /kernal-chrome-host\.mjs/);
    assert.doesNotMatch(text, new RegExp(`kernal-9\\.9\\.1-${platform}`));
    assert.match(readFileSync(join(b.home, "chrome", "host", "kernal-chrome-host.mjs"), "utf8"), /^#!\/usr\/bin\/env node\n/);
    assert.deepEqual(readdirSync(nativeHostDir(b.work)), ["com.kernal.chrome.json"]);
  });

  test("a state dir outside the home still yields the socket kernal opens", async () => {
    const state = join(mkdtempSync(join(tmpdir(), "kernal-state-")), "state");
    const b = sandbox({ env: { KERNAL_STATE: state } });
    const out = b.install("9.9.3");
    assert.equal(out.status, 0, out.out);
    const recorded = readFileSync(join(b.home, "chrome", "host", "socket-path"), "utf8").trim();
    assert.equal(recorded, join(b.home, "chrome.sock"));
    assert.notEqual(dirname(recorded), state);
    // A sibling kernal/ directory is the repo sentinel. The record must still win,
    // or the host falls back to ~/.kernal when Chrome passes no KERNAL_HOME.
    mkdirSync(join(b.home, "kernal"));
    const fakeHome = join(b.work, "chrome-user");
    mkdirSync(fakeHome);
    const hostMjs = join(b.home, "chrome", "host", "kernal-chrome-host.mjs");
    const proc = spawn(hostMjs, [], {
      env: { HOME: fakeHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let err = "";
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(err)), 4000);
        proc.stderr.on("data", (c) => {
          err += c.toString();
          if (err.includes("listening")) { clearTimeout(timer); resolve(); }
        });
        proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exit ${code}: ${err}`)); });
      });
      await ready;
      assert.equal(existsSync(join(fakeHome, ".kernal", "chrome.sock")), false);
      assert.equal(existsSync(join(state, "chrome.sock")), false);
      const listed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(recorded);
        let buf = "";
        const timer = setTimeout(() => reject(new Error(buf)), 4000);
        socket.on("data", (c) => { buf += c.toString(); if (buf.includes("\n")) { clearTimeout(timer); socket.end(); resolve(buf); } });
        socket.on("error", reject);
        socket.on("connect", () => socket.write('{"t":"list"}\n'));
      });
      assert.deepEqual(JSON.parse(listed), { t: "shares", shares: [] });
    } finally {
      await stop(proc);
    }
  });
});
