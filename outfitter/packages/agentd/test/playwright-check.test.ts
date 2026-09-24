import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlaywrightBeforeCheckpoint, type PlaywrightSpawn } from "../src/playwright-check.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "outfitter-pw-"));
}

async function plant(root: string, testDir = "tests"): Promise<void> {
  await mkdir(join(root, testDir), { recursive: true });
  await writeFile(join(root, "playwright.config.ts"), `export default { testDir: ${JSON.stringify(testDir)} };\n`);
  await writeFile(join(root, testDir, "home.spec.ts"), "test('home', () => {});\n");
}

test("playwright check: flag off does not spawn even when a spec exists", async () => {
  const root = await workspace();
  await plant(root);
  let calls = 0;
  const spawn: PlaywrightSpawn = async () => {
    calls += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.equal(await runPlaywrightBeforeCheckpoint({ enabled: false, workspace: root, spawn }), null);
  assert.equal(calls, 0);
});

test("playwright check: no spec does not spawn and says nothing to run", async () => {
  const root = await workspace();
  let calls = 0;
  const spawn: PlaywrightSpawn = async () => {
    calls += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  const entry = await runPlaywrightBeforeCheckpoint({ enabled: true, workspace: root, spawn });
  assert.equal(calls, 0);
  assert.equal(entry?.data.status, "skipped");
  assert.match(entry?.data.text ?? "", /nothing to run/);
});

test("playwright check: a config with only node:test files is not a Playwright suite", async () => {
  const root = await workspace();
  await writeFile(join(root, "playwright.config.ts"), "export default {};\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.test.ts"), "test('unit', () => {});\n");
  let calls = 0;
  const spawn: PlaywrightSpawn = async () => {
    calls += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  const entry = await runPlaywrightBeforeCheckpoint({ enabled: true, workspace: root, spawn });
  assert.equal(calls, 0);
  assert.match(entry?.data.text ?? "", /nothing to run/);
});

test("playwright check: a spec spawns the runner without agentd's env", async () => {
  const root = await workspace();
  await plant(root, "e2e");
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_should_not_leak";
  try {
    let seen: NodeJS.ProcessEnv | undefined;
    let args: string[] = [];
    const spawn: PlaywrightSpawn = async (_command, spawnArgs, opts) => {
      args = spawnArgs;
      seen = opts.env;
      return { code: 0, stdout: "1 passed", stderr: "" };
    };
    const entry = await runPlaywrightBeforeCheckpoint({
      enabled: true,
      workspace: root,
      spawn,
      cliPath: "/opt/outfitter/playwright/node_modules/.bin/playwright",
    });
    assert.equal(entry?.data.status, "pass");
    assert.match(entry?.data.text ?? "", /Playwright: pass/);
    assert.match(entry?.data.text ?? "", /1 passed/);
    assert.ok(args.includes("--config"));
    assert.ok(args.includes(join(root, "playwright.config.ts")));
    assert.equal(seen?.GITHUB_TOKEN, undefined);
    assert.equal(seen?.CI, "1");
    assert.equal(seen?.HOME, "/tmp");
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test("playwright check: a missing browser says Chromium could not start and does not throw", async () => {
  const root = await workspace();
  await plant(root);
  const spawn: PlaywrightSpawn = async () => ({ code: null, stdout: "", stderr: "", error: "spawn ENOENT" });
  const entry = await runPlaywrightBeforeCheckpoint({ enabled: true, workspace: root, spawn });
  assert.equal(entry?.data.status, "unavailable");
  assert.match(entry?.data.text ?? "", /Chromium could not start/);
});

test("playwright check: a failed spec is fail and still returns", async () => {
  const root = await workspace();
  await plant(root);
  const spawn: PlaywrightSpawn = async () => ({ code: 1, stdout: "", stderr: "Expected 1 to be 2" });
  const entry = await runPlaywrightBeforeCheckpoint({ enabled: true, workspace: root, spawn });
  assert.equal(entry?.data.status, "fail");
  assert.match(entry?.data.text ?? "", /Playwright: fail/);
  assert.match(entry?.data.log ?? "", /Expected 1 to be 2/);
});

test("playwright check: a screenshot produced by the run is named in the entry", async () => {
  const root = await workspace();
  const output = await mkdtemp(join(tmpdir(), "outfitter-pw-out-"));
  await plant(root);
  const spawn: PlaywrightSpawn = async (_command, args) => {
    const dir = args[args.indexOf("--output") + 1];
    await writeFile(join(dir, "shot.png"), "png");
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const entry = await runPlaywrightBeforeCheckpoint({ enabled: true, workspace: root, spawn, outputDir: output });
  assert.equal(entry?.data.screenshotPath, join(output, "shot.png"));
  assert.match(entry?.data.text ?? "", /Screenshot:/);
});

test("playwright check: the default output directory is removed and a caller outputDir stays", async () => {
  const root = await workspace();
  await plant(root);

  const spawnInto = (outcome: { code: number | null; timedOut?: boolean }): PlaywrightSpawn => {
    return async (_command, args) => {
      const dir = args[args.indexOf("--output") + 1];
      await writeFile(join(dir, "shot.png"), "png");
      await writeFile(join(dir, "trace.zip"), "trace");
      return { code: outcome.code, stdout: "", stderr: "boom", timedOut: outcome.timedOut };
    };
  };

  let failedDir = "";
  const failed = await runPlaywrightBeforeCheckpoint({
    enabled: true,
    workspace: root,
    spawn: async (command, args, opts) => {
      failedDir = args[args.indexOf("--output") + 1];
      return spawnInto({ code: 1 })(command, args, opts);
    },
  });
  assert.match(failedDir, /outfitter-playwright-/);
  await assert.rejects(stat(failedDir), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  assert.equal(failed?.data.status, "fail");
  assert.equal(failed?.data.screenshotPath, undefined);
  assert.doesNotMatch(failed?.data.text ?? "", /Screenshot:/);
  assert.doesNotMatch(failed?.data.text ?? "", /outfitter-playwright-/);

  let timedOutDir = "";
  const timedOut = await runPlaywrightBeforeCheckpoint({
    enabled: true,
    workspace: root,
    spawn: async (command, args, opts) => {
      timedOutDir = args[args.indexOf("--output") + 1];
      return spawnInto({ code: null, timedOut: true })(command, args, opts);
    },
  });
  assert.notEqual(timedOutDir, failedDir);
  await assert.rejects(stat(timedOutDir), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  assert.equal(timedOut?.data.status, "fail");
  assert.equal(timedOut?.data.screenshotPath, undefined);

  const output = await mkdtemp(join(tmpdir(), "outfitter-pw-out-"));
  const kept = await runPlaywrightBeforeCheckpoint({
    enabled: true,
    workspace: root,
    spawn: spawnInto({ code: 0 }),
    outputDir: output,
  });
  assert.equal((await stat(output)).isDirectory(), true);
  assert.equal((await stat(join(output, "trace.zip"))).isFile(), true);
  assert.equal(kept?.data.screenshotPath, join(output, "shot.png"));
});
