// loadConfig: OUTFITTER_ROLE and SANDBOX_PROVIDER are validated against a fixed set of literal
// values at boot, instead of silently falling back (or failing later, e.g. the first time
// createProvider() is called — see docs/reports/maintainability-review-pr1.md).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertSandboxOrigin, loadConfig } from "../src/config.ts";

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

  test("OUTFITTER_OPERATORS defaults to an empty list", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    assert.deepEqual(config.operators, []);
  });

  test("OUTFITTER_OPERATORS splits on ';' -- what deploy/service.sh actually uses, since gcloud's --set-env-vars splits on ','", () => {
    const config = loadConfig({ OUTFITTER_OPERATORS: "mgm@mgms.eu;matej@mgms.eu" } as NodeJS.ProcessEnv);
    assert.deepEqual(config.operators, ["mgm@mgms.eu", "matej@mgms.eu"]);
  });

  test("OUTFITTER_OPERATORS also accepts ',' and whitespace separators, trimming and dropping empties", () => {
    const config = loadConfig({ OUTFITTER_OPERATORS: " a@x.com,  b@x.com \t c@x.com ;; d@x.com" } as NodeJS.ProcessEnv);
    assert.deepEqual(config.operators, ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  });
});

describe("assertSandboxOrigin", () => {
  test("a web role waking Cloud Run sandboxes without OUTFITTER_LINK_ORIGIN refuses to start", () => {
    const config = loadConfig({ OUTFITTER_ROLE: "web", SANDBOX_PROVIDER: "cloudrun" } as NodeJS.ProcessEnv);
    assert.throws(() => assertSandboxOrigin(config), /OUTFITTER_LINK_ORIGIN is required/);
  });
  test("passes with the link origin set, and for the other roles and providers", () => {
    assertSandboxOrigin(loadConfig({ OUTFITTER_ROLE: "web", SANDBOX_PROVIDER: "cloudrun", OUTFITTER_LINK_ORIGIN: "https://link.example" } as NodeJS.ProcessEnv));
    assertSandboxOrigin(loadConfig({ OUTFITTER_ROLE: "link", SANDBOX_PROVIDER: "cloudrun" } as NodeJS.ProcessEnv));
    assertSandboxOrigin(loadConfig({ SANDBOX_PROVIDER: "cloudrun" } as NodeJS.ProcessEnv));
    assertSandboxOrigin(loadConfig({ OUTFITTER_ROLE: "web" } as NodeJS.ProcessEnv));
  });
});

