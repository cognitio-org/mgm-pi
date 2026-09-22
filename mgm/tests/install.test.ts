/**
 * Guards on scripts/install.sh. It is shell, so these are structural assertions on the parts that
 * have already gone wrong once: a bundle lives in a versioned directory, so anything user-owned
 * written inside it is stranded by the next upgrade. Sessions were lost that way, and
 * `--session <id>` only searches the current agent dir, so the history looked deleted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { updateSettings } from "../.pi/extensions/connect/settings.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "scripts", "install.sh"), "utf8");

describe("install.sh", () => {
  test("user-owned state lives outside the versioned bundle and is linked in", () => {
    assert.match(script, /STATE="\$\{MGM_STATE:-\$HOME_DIR\/state\}"/, "one state directory, overridable");
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
    assert.match(script, /for old_dir in "\$HOME_DIR"\/mgm-\*-"\$platform"/, "older bundles are searched");
    assert.match(script, /\[\[ ! -f "\$target\/\$\(basename "\$f"\)" \]\]/, "a session already in state is left alone");
    assert.match(script, /! -L "\$old_dir\/\.pi\/sessions"/, "an already-linked bundle is not copied from itself");
  });

  test("the user's .env still survives an upgrade", () => {
    assert.match(script, /keep_env=\$\(cat "\$HOME_DIR\/current\/\.env"\)/);
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
    const r = execFileSync("git", ["check-ignore", "-q", "mgm/.pi/agents/mine.md"], { cwd: join(root, ".."), stdio: "pipe" });
    assert.equal(r.length, 0, "git check-ignore exits 0: ignored");
  });
});

/**
 * A real upgrade, offline: two locally built bundles installed one over the other into a throwaway
 * MGM_HOME with the real install.sh. The bundles carry no pi binary, so the merge runs under Node,
 * which is what the fallback path does on a machine that has it.
 */
describe("install.sh upgrade (real script, local bundles)", () => {
  const os = execFileSync("uname", ["-s"], { encoding: "utf8" }).trim().toLowerCase();
  const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim().replace("x86_64", "x64").replace("aarch64", "arm64");
  const platform = `${os}-${arch}`;
  const work = mkdtempSync(join(tmpdir(), "mgm-upgrade-"));
  const home = join(work, "mgm-home");
  const env = { ...process.env, HOME: work, MGM_HOME: home, MGM_BIN: join(work, "bin"), GH_TOKEN: "", PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };

  const shipped = (model: string, subDefault: string) => ({
    defaultProvider: "litellm", defaultModel: model, packages: ["npm:pi-subagents"],
    subagents: { defaultModel: subDefault, agentOverrides: { worker: { model: "litellm/claude-sonnet-5" } } },
  });
  function bundle(version: string, settings: object, opts: { shippedCopy?: boolean; agents?: Record<string, string> } = {}) {
    const name = `mgm-${version}-${platform}`;
    const stage = join(work, "build", name);
    mkdirSync(join(stage, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(stage, "bin"), { recursive: true });
    cpSync(join(root, ".pi", "extensions", "connect"), join(stage, ".pi", "extensions", "connect"), { recursive: true });
    writeFileSync(join(stage, ".pi", "settings.json"), JSON.stringify(settings, null, 2));
    if (opts.shippedCopy !== false) writeFileSync(join(stage, ".pi", "settings.shipped.json"), JSON.stringify(settings, null, 2));
    for (const [f, text] of Object.entries(opts.agents ?? {})) { mkdirSync(join(stage, ".pi", "agents"), { recursive: true }); writeFileSync(join(stage, ".pi", "agents", f), text); }
    writeFileSync(join(stage, "bin", "mgm"), "#!/bin/sh\necho mgm\n", { mode: 0o755 });
    writeFileSync(join(stage, "VERSION"), version + "\n");
    const tgz = join(work, "build", `${name}.tar.gz`);
    execFileSync("tar", ["czf", tgz, "-C", join(work, "build"), name]);
    return tgz;
  }
  const install = (version: string, tgz: string) => execFileSync("bash", [join(root, "scripts", "install.sh")], { env: { ...env, MGM_VERSION: version, MGM_BUNDLE_FILE: tgz }, encoding: "utf8" });
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
    const out = install("1.1.0", join(work, "build", `mgm-1.1.0-${platform}.tar.gz`));
    assert.match(out, /kept your/);
    assert.equal(settings().defaultModel, "claude-sonnet-5");
  });
});
