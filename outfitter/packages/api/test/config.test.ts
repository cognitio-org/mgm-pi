// loadConfig: OUTFITTER_ROLE and SANDBOX_PROVIDER are validated against a fixed set of literal
// values at boot, instead of silently falling back (or failing later, e.g. the first time
// createProvider() is called — see docs/reports/maintainability-review-pr1.md).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertSandboxOrigin, loadConfig, mailboxWarning, tokenAudiences } from "../src/config.ts";

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


describe("mailboxWarning", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ SANDBOX_PROVIDER: "cloudrun", ...env } as NodeJS.ProcessEnv);
  const full = { CLOUD_TASKS_QUEUE: "outfitter-wake", TASKS_SA_EMAIL: "tasks@p.iam.gserviceaccount.com" };

  test("a deployed link role without TASKS_SA_EMAIL is warned that its hooks will reject everything", () => {
    assert.match(mailboxWarning(cfg({ OUTFITTER_ROLE: "link" })) ?? "", /hooks\/tick .* reject every call/);
  });
  test("a deployed web role without the queue is warned that wakes won't be retried", () => {
    assert.match(mailboxWarning(cfg({ OUTFITTER_ROLE: "web", TASKS_SA_EMAIL: full.TASKS_SA_EMAIL })) ?? "", /won't be retried/);
  });
  test("quiet when configured, in dev mode, and for non-Cloud Run providers", () => {
    assert.equal(mailboxWarning(cfg({ OUTFITTER_ROLE: "link", ...full })), undefined);
    assert.equal(mailboxWarning(cfg({ OUTFITTER_ROLE: "web", ...full })), undefined);
    assert.equal(mailboxWarning(cfg({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "1" })), undefined);
    assert.equal(mailboxWarning(loadConfig({ OUTFITTER_ROLE: "link" } as NodeJS.ProcessEnv)), undefined);
  });
});

describe("tokenAudiences (OUTFITTER_ORIGIN_ALIASES)", () => {
  test("is just the origin when no aliases are set", () => {
    const config = loadConfig({ OUTFITTER_ORIGIN: "https://link.kernal.one" } as NodeJS.ProcessEnv);
    assert.deepEqual(config.originAliases, []);
    assert.deepEqual(tokenAudiences(config), ["https://link.kernal.one"]);
  });

  test("adds the aliases, split like OUTFITTER_OPERATORS, de-duplicated and without trailing slashes", () => {
    const config = loadConfig({
      OUTFITTER_ORIGIN: "https://link.kernal.one",
      OUTFITTER_ORIGIN_ALIASES: "https://outfitter-link-abc-uc.a.run.app/; https://link.kernal.one , ",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(tokenAudiences(config), ["https://link.kernal.one", "https://outfitter-link-abc-uc.a.run.app"]);
  });
});
