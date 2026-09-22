/**
 * Settings across an upgrade (.pi/extensions/connect/settings.ts). A bundle's settings.json is both
 * the release's defaults and where the user's choices are saved, and it moves with every version, so
 * the installer merges the user's changes over the new release's settings. These pin the rules: a
 * choice the user made survives, a default the user never touched follows the release.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { merge3, mergeSettings, legacyBase, userChanges, updateSettings, readSettings } from "../.pi/extensions/connect/settings.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What release N shipped, what the user made of it, and what release N+1 ships. */
const v1 = {
  defaultProvider: "litellm", defaultModel: "gpt-5.4-nano",
  packages: ["npm:pi-mcp-adapter", "npm:pi-subagents", "npm:pi-memory"],
  compaction: { reserveTokens: 8192, keepRecentTokens: 6000 },
  subagents: { defaultModel: "litellm/gemini-3.8-flash", agentOverrides: { worker: { model: "litellm/claude-sonnet-5" }, oracle: { model: "litellm/claude-opus-5-high" } } },
};
const user = {
  ...structuredClone(v1),
  defaultModel: "claude-sonnet-5",                                          // chosen with /connect
  packages: ["npm:pi-mcp-adapter", "npm:pi-subagents", "npm:my-extra"],     // installed one, removed pi-memory
  lastChangelogVersion: "0.86.1",                                           // pi's own bookkeeping
  subagents: { defaultModel: "litellm/gemini-3.8-flash", agentOverrides: { worker: { model: "litellm/claude-sonnet-5", thinking: "high" }, oracle: { model: "litellm/claude-opus-5-high" } } },
  kernal: { compaction: { profile: "code" } },
};
const v2 = {
  defaultProvider: "litellm", defaultModel: "gpt-5.5-nano",                 // the release moved the default
  packages: ["npm:pi-mcp-adapter", "npm:pi-subagents", "npm:pi-memory", "npm:pi-lsp"],
  compaction: { reserveTokens: 16384, keepRecentTokens: 6000 },
  subagents: { defaultModel: "litellm/gemini-4-flash", agentOverrides: { worker: { model: "litellm/claude-sonnet-5" }, oracle: { model: "litellm/claude-opus-5-high" }, reviewer: { model: "litellm/claude-sonnet-5" } } },
  theme: "dark",
};

describe("settings merge across an upgrade", () => {
  const { settings: s, kept } = mergeSettings(v1, user, v2);

  test("a default model chosen before the upgrade is still chosen after it", () => {
    assert.equal(s.defaultModel, "claude-sonnet-5");
    assert.equal(s.defaultProvider, "litellm");
  });

  test("a new shipped default the user never touched arrives", () => {
    assert.equal(s.subagents.defaultModel, "litellm/gemini-4-flash", "the release's new subagent default");
    assert.equal(s.compaction.reserveTokens, 16384);
    assert.equal(s.theme, "dark", "a key the old release did not have");
    assert.deepEqual(s.subagents.agentOverrides.reviewer, { model: "litellm/claude-sonnet-5" }, "a new override");
  });

  test("objects merge key by key: the user's one change and the release's changes both land", () => {
    assert.deepEqual(s.subagents.agentOverrides.worker, { model: "litellm/claude-sonnet-5", thinking: "high" });
    assert.deepEqual(s.kernal, { compaction: { profile: "code" } }, "keys only the user has are kept");
    assert.equal(s.lastChangelogVersion, "0.86.1");
  });

  test("package lists keep the user's additions and removals on top of the new list", () => {
    assert.deepEqual(s.packages, ["npm:pi-mcp-adapter", "npm:pi-subagents", "npm:pi-lsp", "npm:my-extra"]);
  });

  test("when both changed one value, the user's choice wins", () => {
    assert.equal(merge3("a", "mine", "theirs"), "mine");
    assert.equal(merge3(1, 1, 2), 2);
    assert.equal(merge3(1, 2, 1), 2);
    assert.equal(merge3(undefined, undefined, 3), 3);
    assert.equal(merge3(3, undefined, 3), undefined, "a key the user deleted stays deleted");
  });

  test("the summary names what was kept", () => {
    assert.ok(kept.includes("defaultModel"));
    assert.ok(kept.includes("subagents.agentOverrides.worker.thinking"));
    assert.ok(!kept.includes("compaction"), "untouched keys are not the user's");
  });

  test("key order alone is not a change", () => {
    const reordered = { subagents: v1.subagents, compaction: v1.compaction, packages: v1.packages, defaultModel: v1.defaultModel, defaultProvider: v1.defaultProvider };
    assert.deepEqual(userChanges(v1, reordered), []);
    assert.deepEqual(mergeSettings(v1, reordered, v2).settings, v2);
  });

  test("an old bundle without a shipped copy: the user's own keys are kept, everything else follows the release", () => {
    const { settings, legacy } = mergeSettings(undefined, user, v2);
    assert.ok(legacy);
    assert.equal(settings.defaultModel, "claude-sonnet-5");
    assert.deepEqual(settings.kernal, { compaction: { profile: "code" } });
    assert.equal(settings.subagents.defaultModel, "litellm/gemini-4-flash", "the old subagent block cannot be told from the old defaults, so the release's wins");
    assert.deepEqual(settings.packages, v2.packages);
    assert.ok(!("defaultModel" in legacyBase(user)));
  });

  test("the installer's script writes the merge and says what it kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-merge-"));
    const f = (n: string, v: unknown) => { writeFileSync(join(dir, n), JSON.stringify(v)); return join(dir, n); };
    const out = join(dir, "out.json");
    const said = execFileSync(process.execPath, [join(root, ".pi/extensions/connect/settings-merge.ts"), "--base", f("b.json", v1), "--ours", f("o.json", user), "--theirs", f("t.json", v2), "--out", out], { encoding: "utf8" });
    assert.match(said, /kept your \d+ changes \(.*defaultModel/);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).defaultModel, "claude-sonnet-5");
    writeFileSync(join(dir, "bad.json"), "{ nope");
    assert.throws(() => execFileSync(process.execPath, [join(root, ".pi/extensions/connect/settings-merge.ts"), "--ours", join(dir, "bad.json"), "--theirs", join(dir, "t.json"), "--out", out], { stdio: "pipe" }));
    assert.equal(JSON.parse(readFileSync(out, "utf8")).defaultModel, "claude-sonnet-5", "a failed merge leaves the output alone");
  });
});

describe("updateSettings", () => {
  test("changes one key and keeps the rest", () => {
    const file = join(mkdtempSync(join(tmpdir(), "kernal-set-")), "settings.json");
    writeFileSync(file, JSON.stringify({ a: 1, subagents: { defaultModel: "x" } }));
    updateSettings((s) => { (s.subagents as any).defaultModel = "y"; }, file);
    assert.deepEqual(readSettings(file), { a: 1, subagents: { defaultModel: "y" } });
  });

  test("refuses to overwrite a file it cannot parse", () => {
    const file = join(mkdtempSync(join(tmpdir(), "kernal-set-")), "settings.json");
    writeFileSync(file, "{ half an edit");
    assert.throws(() => updateSettings((s) => { s.x = 1; }, file));
    assert.equal(readFileSync(file, "utf8"), "{ half an edit");
  });
});
