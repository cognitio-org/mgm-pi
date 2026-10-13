/**
 * Live: does the Claude CLI actually honour the `apiKeyHelper` override that `claudeArgs` relies on?
 *
 * runner.ts no longer refuses when a settings file sets `apiKeyHelper`, because `claudeArgs` clears
 * it for the child with `--settings {"apiKeyHelper":""}` (NO_API_KEY_HELPER). If a Claude version
 * ignored that flag — or `""` stopped meaning "none" — the child would silently authenticate with
 * an API key and bill it instead of the plan. No unit test can catch that: they assert the args we
 * pass, not what the CLI does with them. This does.
 *
 * Each case is a control/canary pair, because "the helper did not run" only means something if the
 * helper *would* have run. The helper writes a file and then exits 1, so a control run can never
 * spend anything: it proves the canary detects helper invocation without billing an API key.
 *
 * What this proves: the helper is not consulted, and the flag is understood. What it does not
 * prove: that the child authenticates on the plan — that is the runner comment's manual check.
 *
 * Gated: KERNAL_LIVE_CLAUDE=1 and `claude` on PATH. Costs two tiny plan calls.
 *   KERNAL_LIVE_CLAUDE=1 node --test --import ./tests/resolve-pi.mjs tests/subscriptions-live.test.ts
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "../.pi/extensions/kernal-subscriptions/runner.ts";
import { binaryOnPath } from "../.pi/extensions/kernal-subscriptions/local-login.ts";

const enabled = process.env.KERNAL_LIVE_CLAUDE === "1" && binaryOnPath("claude");
const gate = !enabled && "set KERNAL_LIVE_CLAUDE=1 with claude on PATH";
const PROMPT = "Reply with OK.";

const tempDirs: string[] = [];
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

/** A temp HOME with the canary helper in one settings file, and an empty MCP config. */
function fixture(where: "user" | "project"): { home: string; cwd: string; canary: string; mcp: string } {
  const home = mkdtempSync(join(tmpdir(), "kernal-live-claude-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "kernal-live-claude-cwd-"));
  tempDirs.push(home, cwd);
  const canary = join(home, "helper-ran");
  const helper = join(home, "api-key-helper.sh");
  writeFileSync(helper, `#!/bin/sh\ntouch ${JSON.stringify(canary)}\nexit 1\n`);
  chmodSync(helper, 0o755);
  const settingsDir = where === "user" ? join(home, ".claude") : join(cwd, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ apiKeyHelper: helper }));
  const mcp = join(home, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  return { home, cwd, canary, mcp };
}

/** The pre-fix shape: both settings sources load, nothing clears the helper. */
const controlArgs = (mcp: string) =>
  ["--strict-mcp-config", "--mcp-config", mcp, "--setting-sources", "user,project", "--no-session-persistence", "-p", PROMPT];

/** Runs the real `claude` with HOME overridden. A non-zero exit is expected and returned. */
function runClaude(args: string[], home: string, cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync("claude", args, {
      cwd, encoding: "utf8", timeout: 180_000,
      env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("live: the apiKeyHelper override", { skip: gate }, () => {
  test("the installed CLI supports --settings, which the override depends on", () => {
    const help = execFileSync("claude", ["--help"], { encoding: "utf8", timeout: 60_000 });
    assert.match(help, /--settings/, "an older CLI would reject the flag and the checks below would pass for the wrong reason");
  });

  for (const where of ["user", "project"] as const) {
    test(`${where} settings: the canary detects the helper when it is not overridden (cannot bill)`, () => {
      const { home, cwd, canary, mcp } = fixture(where);
      const res = runClaude(controlArgs(mcp), home, cwd);
      assert.equal(existsSync(canary), true, `the control must run the helper, else this proves nothing (exit ${res.code})`);
    });

    test(`${where} settings: claudeArgs clears it, so the helper never runs`, () => {
      const { home, cwd, canary, mcp } = fixture(where);
      const res = runClaude(claudeArgs("full", PROMPT, mcp), home, cwd);
      assert.equal(existsSync(canary), false, `the helper must not run; claude said: ${res.out.slice(0, 400)}`);
      assert.doesNotMatch(res.out, /unknown (option|argument|flag)|unrecognized|invalid option/i, `--settings must be accepted: ${res.out.slice(0, 400)}`);
    });
  }
});
