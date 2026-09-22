/** The shared KERNAL_ (falling back to MGM_) env-var helper (docs/rename.md): env(), envIsSet()
 *  and the once-per-process warning. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { env, envIsSet, inSandbox, _resetEnvFallbackWarnings } from "../.pi/extensions/_shared/env.ts";

let originalError: typeof console.error;
let errors: string[];

beforeEach(() => {
  delete process.env.KERNAL_FOO;
  delete process.env.MGM_FOO;
  delete process.env.KERNAL_BAR;
  delete process.env.MGM_BAR;
  _resetEnvFallbackWarnings();
  errors = [];
  originalError = console.error;
  console.error = (msg?: unknown) => { errors.push(String(msg)); };
});
afterEach(() => {
  console.error = originalError;
  delete process.env.KERNAL_FOO;
  delete process.env.MGM_FOO;
  delete process.env.KERNAL_BAR;
  delete process.env.MGM_BAR;
});

describe("env()", () => {
  test("returns undefined when neither name is set", () => {
    assert.equal(env("FOO"), undefined);
    assert.equal(envIsSet("FOO"), false);
  });

  test("prefers KERNAL_<NAME> when both are set, without warning", () => {
    process.env.KERNAL_FOO = "new"; process.env.MGM_FOO = "old";
    assert.equal(env("FOO"), "new");
    assert.equal(errors.length, 0, "no warning when the new name is set");
  });

  test("falls back to MGM_<NAME> and warns once", () => {
    process.env.MGM_FOO = "legacy-value";
    assert.equal(env("FOO"), "legacy-value");
    assert.equal(env("FOO"), "legacy-value", "repeated reads keep returning the legacy value");
    assert.equal(errors.length, 1, "the fallback warns exactly once per name per process");
    assert.match(errors[0], /MGM_FOO is now KERNAL_FOO/);
  });

  test("warns once per name, independently for different names", () => {
    process.env.MGM_FOO = "f"; process.env.MGM_BAR = "b";
    env("FOO"); env("FOO"); env("BAR"); env("BAR"); env("BAR");
    assert.equal(errors.length, 2, "one warning per distinct old name, not per call");
    assert.ok(errors.some((e) => e.includes("MGM_FOO")));
    assert.ok(errors.some((e) => e.includes("MGM_BAR")));
  });

  test("envIsSet() reports true for either name without warning", () => {
    process.env.MGM_FOO = "x";
    assert.equal(envIsSet("FOO"), true);
    assert.equal(errors.length, 0, "envIsSet never warns; only a read through env() does");
  });

  test("_resetEnvFallbackWarnings() lets a later test observe the warning again", () => {
    process.env.MGM_FOO = "x";
    env("FOO");
    assert.equal(errors.length, 1);
    _resetEnvFallbackWarnings();
    env("FOO");
    assert.equal(errors.length, 2, "warns again after an explicit reset");
  });

  test("an empty string is a set value, not 'unset' (falls back like any other value)", () => {
    process.env.MGM_FOO = "";
    assert.equal(env("FOO"), "");
    assert.equal(envIsSet("FOO"), true);
  });
});

describe("inSandbox()", () => {
  afterEach(() => { delete process.env.KERNAL_SANDBOX; delete process.env.MGM_SANDBOX; });
  test("is false unless KERNAL_SANDBOX is set to something truthy (the Outfitter image sets it to 1)", () => {
    delete process.env.KERNAL_SANDBOX;
    assert.equal(inSandbox(), false, "a laptop never sets it");
    for (const off of ["", "0", "false", "FALSE"]) { process.env.KERNAL_SANDBOX = off; assert.equal(inSandbox(), false, JSON.stringify(off)); }
    for (const on of ["1", "true", "yes"]) { process.env.KERNAL_SANDBOX = on; assert.equal(inSandbox(), true, on); }
  });
});
