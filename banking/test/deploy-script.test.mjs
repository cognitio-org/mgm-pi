import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const banking = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function runDeploy(listMode) {
  const root = await mkdtemp(path.join(tmpdir(), "finance-deploy-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const fake = `#!/bin/bash
case "$*" in
  *"secrets versions list"*)
    case "$LIST_MODE" in
      fail)
        echo "transient list failure" >&2
        exit 1
        ;;
      present)
        echo 1
        exit 0
        ;;
    esac
    ;;
esac
exit 0
`;
  await writeFile(path.join(bin, "gcloud"), fake, { mode: 0o755 });
  await chmod(path.join(bin, "gcloud"), 0o755);
  try {
    return await exec("bash", ["deploy/finance-mcp.sh"], {
      cwd: banking,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DRY_RUN: "1",
        LIST_MODE: listMode,
      },
    });
  } catch (err) {
    return err;
  }
}

test("a failed caller-token version list does not mint a new token", async () => {
  const result = await runDeploy("fail");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not list versions of kernal-finance-mcp-token/);
  assert.equal(String(result.stdout || "").includes("would add a token version"), false);
});

test("an existing caller-token version is left alone", async () => {
  const result = await runDeploy("present");
  assert.equal(result.code, undefined);
  assert.match(result.stdout, /caller token version exists/);
  assert.equal(result.stdout.includes("would add a token version"), false);
});

test("a secret with no enabled version gets a token in dry run", async () => {
  const result = await runDeploy("empty");
  assert.equal(result.code, undefined);
  assert.match(result.stdout, /would add a token version/);
});
