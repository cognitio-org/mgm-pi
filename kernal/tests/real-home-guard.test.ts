/**
 * #433: the test harness (tests/isolate.mjs, loaded by tests/resolve-pi.mjs) gives every test
 * process a temporary HOME and no keychain, so a developer's real Kernal login never leaks into a
 * test and no test writes into the real ~/.kernal or ~/.pi/agent. These check that it is in effect.
 * tests/home-guard.mjs, the runner's global setup, also compares the real home at the end of the
 * run and fails the whole run if it changed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chooseBackend, keychainBackend, realRunner, secretServiceBackend } from "../.pi/extensions/_shared/keychain.ts";
import { authDir } from "../.pi/extensions/_shared/outfitter-session.ts";
import { diffSnapshots, snapshotRealHome } from "./home-guard.mjs";

const realHome = process.env.KERNAL_TEST_REAL_HOME ?? "";

describe("test isolation (#433)", () => {
  it("runs under a temporary HOME, not the developer's", () => {
    assert.ok(realHome, "KERNAL_TEST_REAL_HOME is set by tests/isolate.mjs");
    assert.notEqual(homedir(), realHome);
    assert.notEqual(process.env.HOME, realHome);
    assert.ok(!authDir().startsWith(join(realHome, ".kernal")), authDir());
    for (const k of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
      assert.ok(process.env[k]?.startsWith(homedir()), `${k}=${process.env[k]}`);
    }
  });

  it("keeps the login off the real Keychain and Secret Service", () => {
    assert.equal(process.env.KERNAL_AUTH_BACKEND, "file");
    assert.equal(chooseBackend(join(homedir(), ".kernal", "auth")).name, "file");
    // Even a backend asked for by name, through the real runner, cannot run the tool.
    assert.deepEqual(realRunner("/usr/bin/security", ["find-generic-password", "-s", "kernal-outfitter", "-w"]), { status: null, stdout: "" });
    assert.equal(keychainBackend().get("https://example.test|a@example.com"), undefined);
    assert.equal(secretServiceBackend().get("https://example.test|a@example.com"), undefined);
    assert.throws(() => keychainBackend().set("x|y", "z"), /Keychain/);
  });

  it("drops inherited overrides that point at user state", () => {
    for (const k of Object.keys(process.env)) {
      if (/^(KERNAL_(HOME|HOME_DIR|AUTH_DIR|CONFIG_CACHE_DIR|REPORT_DIR|INDEX_CONFIG|VOICE_SETTINGS|TELEPORT_STORE|SESSIONS_DIR)|MGM_|OUTFITTER_|PI_CODING_AGENT_DIR)/.test(k)) {
        assert.fail(`${k} leaked into the test environment`);
      }
    }
  });

  it("has not changed the real home so far", { skip: !process.env.KERNAL_TEST_HOME_SNAPSHOT && "run through npm test (--test-global-setup)" }, () => {
    const file = process.env.KERNAL_TEST_HOME_SNAPSHOT as string;
    const before = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(diffSnapshots(before, snapshotRealHome(realHome)), []);
  });

  it("diffSnapshots names what was created, removed or modified", () => {
    assert.deepEqual(diffSnapshots({ a: "1 2", b: "1 2", c: "missing" }, { a: "1 3", c: "5 dir" }), ["created c", "modified a", "removed b"]);
  });
});
