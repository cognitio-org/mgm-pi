// loadConfig: OUTFITTER_ROLE and SANDBOX_PROVIDER are validated against a fixed set of literal
// values at boot, instead of silently falling back (or failing later, e.g. the first time
// createProvider() is called — see docs/reports/maintainability-review-pr1.md).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("defaults OUTFITTER_ROLE to \"all\" and SANDBOX_PROVIDER to \"inprocess\" when unset", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.role, "all");
    assert.equal(config.sandboxProvider, "inprocess");
  });

  test("accepts every documented OUTFITTER_ROLE value", () => {
    for (const role of ["all", "web", "link"]) {
      const config = loadConfig({ OUTFITTER_ROLE: role } as NodeJS.ProcessEnv);
      assert.equal(config.role, role);
    }
  });

  test("accepts every documented SANDBOX_PROVIDER value", () => {
    for (const provider of ["inprocess", "docker", "cloudrun"]) {
      const config = loadConfig({ SANDBOX_PROVIDER: provider } as NodeJS.ProcessEnv);
      assert.equal(config.sandboxProvider, provider);
    }
  });

  test("throws a clear error on an unrecognized OUTFITTER_ROLE (e.g. a typo)", () => {
    assert.throws(
      () => loadConfig({ OUTFITTER_ROLE: "wbe" } as NodeJS.ProcessEnv),
      /invalid OUTFITTER_ROLE: "wbe"/,
    );
  });

  test("throws a clear error on an unrecognized SANDBOX_PROVIDER (e.g. a typo)", () => {
    assert.throws(
      () => loadConfig({ SANDBOX_PROVIDER: "Cloudrun" } as NodeJS.ProcessEnv),
      /invalid SANDBOX_PROVIDER: "Cloudrun"/,
    );
  });
});
