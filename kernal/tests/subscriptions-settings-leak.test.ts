/**
 * Claude applies settings-file env after the child environment is built. These cases refuse
 * before spawn. The reader is injected, so nothing here reads the real ~/.claude/settings.json.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeSettingsRefusal, runClaudeWorker,
  type ClaudeSpawn, type ClaudeSpawnResult,
} from "../.pi/extensions/kernal-subscriptions/runner.ts";

const KEY = "sk-ant-api03-settings-leak-secret";
const HELPER = "/opt/bin/claude-key-helper";
const FOREIGN = "https://example.test";
const HOME = "/tmp/kernal-settings-home";
const CWD = "/work/kernal-settings";
const USER_PATH = join(HOME, ".claude", "settings.json");
const PROJECT_PATH = join(CWD, ".claude", "settings.json");

function launch(
  mode: "sandboxed" | "full",
  read: (kind: "user" | "project", filePath: string) => string | undefined,
) {
  const calls: ClaudeSpawn[] = [];
  const reads: { kind: "user" | "project"; filePath: string }[] = [];
  const spawn = async (req: ClaudeSpawn): Promise<ClaudeSpawnResult> => {
    calls.push(req);
    return { code: 0, stdout: "done\n", stderr: "" };
  };
  const result = runClaudeWorker(
    { prompt: "x", cwd: CWD },
    {
      home: HOME,
      mode: () => mode,
      secret: { ok: true, value: "account-secret" },
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: KEY },
      writeMcpConfig: () => "/tmp/mcp.json",
      readSettingsFile: (kind, filePath) => {
        reads.push({ kind, filePath });
        return read(kind, filePath);
      },
      spawn,
    },
  );
  return { calls, reads, result };
}

function hidesSecrets(text: string): void {
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(HELPER), false);
  assert.equal(text.includes(FOREIGN), false);
}

describe("claudeSettingsRefusal", () => {
  test("names the file role and the field, and does not include the secret, helper, or base URL", () => {
    const key = claudeSettingsRefusal([{ kind: "user", settings: { env: { ANTHROPIC_API_KEY: KEY }, apiKeyHelper: HELPER } }]);
    assert.equal(key, "user settings set env.ANTHROPIC_API_KEY");
    // apiKeyHelper is neutralised for the child by `--settings` (NO_API_KEY_HELPER), not refused.
    assert.equal(claudeSettingsRefusal([{ kind: "user", settings: { apiKeyHelper: HELPER } }]), undefined);
    const project = claudeSettingsRefusal([
      { kind: "user", settings: { env: { OTHER: "1" } } },
      { kind: "project", settings: { env: { ANTHROPIC_AUTH_TOKEN: KEY } } },
    ]);
    assert.equal(project, "project settings set env.ANTHROPIC_AUTH_TOKEN");
    const foreign = claudeSettingsRefusal([{ kind: "project", settings: { env: { ANTHROPIC_BASE_URL: FOREIGN } } }]);
    assert.equal(foreign, "project settings set env.ANTHROPIC_BASE_URL");
    assert.equal(claudeSettingsRefusal([{ kind: "user", settings: { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } } }]), undefined);
    assert.equal(claudeSettingsRefusal([{ kind: "user", settings: { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com/" } } }]), undefined);
    assert.equal(claudeSettingsRefusal([{ kind: "user", settings: { env: { ANTHROPIC_API_KEY: "", OTHER: "x" }, apiKeyHelper: "" } }]), undefined);
    for (const text of [key, project, foreign]) hidesSecrets(text!);
  });
});

describe("Claude settings are refused before spawn", () => {
  test("sandboxed refuses user env.ANTHROPIC_API_KEY and does not spawn", async () => {
    const { calls, reads, result } = launch("sandboxed", () => JSON.stringify({
      env: { ANTHROPIC_API_KEY: KEY },
      apiKeyHelper: HELPER,
    }));
    const out = await result;
    assert.equal(out.kind, "refused");
    assert.equal(out.text, "user settings set env.ANTHROPIC_API_KEY");
    hidesSecrets(out.text);
    assert.equal(calls.length, 0);
    assert.deepEqual(reads, [{ kind: "user", filePath: USER_PATH }]);
  });

  test("sandboxed neutralises apiKeyHelper instead of refusing, and the helper never reaches the child", async () => {
    const { calls, reads, result } = launch("sandboxed", () => JSON.stringify({ apiKeyHelper: HELPER }));
    const out = await result;
    assert.equal(out.kind, "ok");
    assert.equal(calls.length, 1);
    assert.deepEqual(reads, [{ kind: "user", filePath: USER_PATH }]);
    const args = calls[0].args;
    const settings = args[args.indexOf("--settings") + 1];
    assert.deepEqual(JSON.parse(settings), { apiKeyHelper: "" }, "the child is told there is no helper");
    assert.equal(settings.includes(HELPER), false, "the helper path is not carried into the args");
    assert.equal(args.indexOf("--settings") < args.indexOf("-p"), true, "--settings precedes the prompt");
    assert.equal(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, "account-secret");
    assert.equal(calls[0].env.ANTHROPIC_API_KEY, undefined);
  });

  test("full refuses project settings too", async () => {
    const { calls, reads, result } = launch("full", (kind) => {
      if (kind === "user") return JSON.stringify({ env: { OTHER: "1" } });
      return JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: KEY }, apiKeyHelper: HELPER });
    });
    const out = await result;
    assert.equal(out.kind, "refused");
    assert.equal(out.text, "project settings set env.ANTHROPIC_AUTH_TOKEN");
    hidesSecrets(out.text);
    assert.equal(calls.length, 0);
    assert.deepEqual(reads, [
      { kind: "user", filePath: USER_PATH },
      { kind: "project", filePath: PROJECT_PATH },
    ]);
  });

  test("both modes carry the helper override", async () => {
    for (const mode of ["sandboxed", "full"] as const) {
      const { calls, result } = launch(mode, () => "{}");
      const out = await result;
      assert.equal(out.kind, "ok", mode);
      const args = calls[0].args;
      assert.equal(args[args.indexOf("--settings") + 1], "{\"apiKeyHelper\":\"\"}", mode);
    }
  });

  test("sandboxed does not read project settings", async () => {
    const { calls, reads, result } = launch("sandboxed", (kind) => {
      if (kind === "project") return JSON.stringify({ env: { ANTHROPIC_API_KEY: KEY }, apiKeyHelper: HELPER });
      return "{}";
    });
    const out = await result;
    assert.equal(out.kind, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes("--no-session-persistence"), true);
    assert.deepEqual(reads.map((r) => r.kind), ["user"]);
    assert.equal(reads.some((r) => r.filePath.includes("settings.local.json")), false);
  });

  test("full allows an absent project file and a user file with only an unrelated env key", async () => {
    const { calls, reads, result } = launch("full", (kind) => kind === "user" ? JSON.stringify({ env: { OTHER_KEY: "value" } }) : undefined);
    const out = await result;
    assert.equal(out.kind, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.ANTHROPIC_API_KEY, undefined);
    assert.equal(calls[0].args[calls[0].args.indexOf("--setting-sources") + 1], "user,project");
    assert.deepEqual(reads, [
      { kind: "user", filePath: USER_PATH },
      { kind: "project", filePath: PROJECT_PATH },
    ]);
    assert.equal(reads.some((r) => r.filePath.endsWith("settings.local.json")), false);
  });

  test("ANTHROPIC_BASE_URL https://api.anthropic.com is allowed", async () => {
    for (const url of ["https://api.anthropic.com", "https://api.anthropic.com/"]) {
      const { calls, result } = launch("full", () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }));
      const out = await result;
      assert.equal(out.kind, "ok", url);
      assert.equal(calls.length, 1);
    }
  });

  test("ANTHROPIC_BASE_URL https://example.test is refused and does not spawn", async () => {
    const { calls, result } = launch("sandboxed", () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: FOREIGN } }));
    const out = await result;
    assert.equal(out.kind, "refused");
    assert.equal(out.text, "user settings set env.ANTHROPIC_BASE_URL");
    hidesSecrets(out.text);
    assert.equal(calls.length, 0);
  });

  test("invalid JSON is refused", async () => {
    const { calls, result } = launch("sandboxed", () => `{not json ${KEY} ${HELPER}`);
    const out = await result;
    assert.equal(out.kind, "refused");
    assert.equal(out.text, "user settings are not valid JSON");
    hidesSecrets(out.text);
    assert.equal(calls.length, 0);
  });

  test("a throw from the reader is a refusal and does not spawn", async () => {
    const { calls, reads, result } = launch("full", () => { throw new Error(`read failed ${KEY} ${HELPER} ${FOREIGN}`); });
    const out = await result;
    assert.equal(out.kind, "refused");
    assert.equal(out.text, "user settings could not be read");
    hidesSecrets(out.text);
    assert.equal(calls.length, 0);
    assert.deepEqual(reads.map((r) => r.kind), ["user"]);
  });

  test("the default reader allows a missing file and refuses invalid JSON without the real home", async () => {
    const home = mkdtempSync(join(tmpdir(), "kernal-claude-settings-"));
    const cwd = mkdtempSync(join(tmpdir(), "kernal-claude-cwd-"));
    const calls: ClaudeSpawn[] = [];
    const spawn = async (req: ClaudeSpawn): Promise<ClaudeSpawnResult> => {
      calls.push(req);
      return { code: 0, stdout: "done\n", stderr: "" };
    };
    const deps = {
      home, mode: () => "full" as const, secret: { ok: true, value: "account-secret" }, env: { PATH: "/usr/bin" },
      writeMcpConfig: () => "/tmp/mcp.json", spawn,
    };
    const missing = await runClaudeWorker({ prompt: "x", cwd }, deps);
    assert.equal(missing.kind, "ok");
    assert.equal(calls.length, 1);

    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), `{"env":{"ANTHROPIC_API_KEY":${JSON.stringify(KEY)}}}`);
    calls.length = 0;
    const project = await runClaudeWorker({ prompt: "x", cwd }, deps);
    assert.equal(project.kind, "refused");
    assert.equal(project.text, "project settings set env.ANTHROPIC_API_KEY");
    hidesSecrets(project.text);
    assert.equal(calls.length, 0);

    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "{");
    const bad = await runClaudeWorker({ prompt: "x", cwd }, { ...deps, mode: () => "sandboxed" });
    assert.equal(bad.kind, "refused");
    assert.equal(bad.text, "user settings are not valid JSON");
    assert.equal(calls.length, 0);
  });
});
