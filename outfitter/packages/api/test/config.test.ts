// loadConfig: OUTFITTER_ROLE and SANDBOX_PROVIDER are validated against a fixed set of literal
// values at boot, instead of silently falling back (or failing later, e.g. the first time
// createProvider() is called — see docs/reports/maintainability-review-pr1.md).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertGkeConfigured, assertSandboxOrigin, isCloudProvider, loadConfig, mailboxWarning, tokenAudiences } from "../src/config.ts";

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

  test("gke plan §5 item 5: also accepts SANDBOX_PROVIDER=gke, with GKE_* defaults", () => {
    const config = loadConfig({ SANDBOX_PROVIDER: "gke" } as NodeJS.ProcessEnv);
    assert.equal(config.sandboxProvider, "gke");
    assert.equal(config.gkeNamespace, "outfitter-sandboxes");
    assert.equal(config.gkeWarmPool, "outfitter-agent");
    assert.equal(config.gkeLaunchMode, "cold");
    assert.equal(config.gkeMaxActive, 3);
    assert.equal(config.gkeLocation, config.gcpRegion);
  });

  // Review round 1, L3: gke.ts builds request URLs as `https://${gkeEndpoint}${path}`, so a value
  // with a scheme or a trailing slash would silently produce a malformed URL that only fails at
  // request time. Normalize at boot instead of rejecting -- an operator pasting straight from
  // `gcloud container clusters describe` (a bare host) is unaffected either way.
  test("GKE_ENDPOINT is normalized: scheme and trailing slash are stripped", () => {
    const bare = loadConfig({ GKE_ENDPOINT: "gke-abc-123.us-central1.gke.goog" } as NodeJS.ProcessEnv);
    assert.equal(bare.gkeEndpoint, "gke-abc-123.us-central1.gke.goog");

    const withScheme = loadConfig({ GKE_ENDPOINT: "https://gke-abc-123.us-central1.gke.goog" } as NodeJS.ProcessEnv);
    assert.equal(withScheme.gkeEndpoint, "gke-abc-123.us-central1.gke.goog");

    const withSlash = loadConfig({ GKE_ENDPOINT: "gke-abc-123.us-central1.gke.goog/" } as NodeJS.ProcessEnv);
    assert.equal(withSlash.gkeEndpoint, "gke-abc-123.us-central1.gke.goog");

    const withBoth = loadConfig({ GKE_ENDPOINT: "  https://gke-abc-123.us-central1.gke.goog/  " } as NodeJS.ProcessEnv);
    assert.equal(withBoth.gkeEndpoint, "gke-abc-123.us-central1.gke.goog");

    const unset = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(unset.gkeEndpoint, "");
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
  test("a web role waking gke sandboxes without OUTFITTER_LINK_ORIGIN also refuses (isCloudProvider)", () => {
    const config = loadConfig({ OUTFITTER_ROLE: "web", SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" } as NodeJS.ProcessEnv);
    assert.throws(() => assertSandboxOrigin(config), /OUTFITTER_LINK_ORIGIN is required/);
  });
});

describe("isCloudProvider", () => {
  test("true for cloudrun and gke, false for the local dev providers", () => {
    assert.equal(isCloudProvider("cloudrun"), true);
    assert.equal(isCloudProvider("gke"), true);
    assert.equal(isCloudProvider("inprocess"), false);
    assert.equal(isCloudProvider("docker"), false);
  });
});

describe("assertGkeConfigured", () => {
  test("SANDBOX_PROVIDER=gke with no GKE_CLUSTER fails at boot", () => {
    const config = loadConfig({ SANDBOX_PROVIDER: "gke" } as NodeJS.ProcessEnv);
    assert.throws(() => assertGkeConfigured(config), /GKE_CLUSTER is required/);
  });
  test("passes once GKE_CLUSTER is set, and for every other provider regardless", () => {
    assertGkeConfigured(loadConfig({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" } as NodeJS.ProcessEnv));
    assertGkeConfigured(loadConfig({ SANDBOX_PROVIDER: "cloudrun" } as NodeJS.ProcessEnv));
    assertGkeConfigured(loadConfig({} as NodeJS.ProcessEnv));
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
  test("gke is a cloud provider too: a deployed link role without TASKS_SA_EMAIL is warned the same as cloudrun", () => {
    const config = loadConfig({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter", OUTFITTER_ROLE: "link" } as NodeJS.ProcessEnv);
    assert.match(mailboxWarning(config) ?? "", /hooks\/tick .* reject every call/);
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

describe("voice config (#252)", () => {
  test("defaults, and clamps the token TTL and per-minute limit to what makes sense", () => {
    const d = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(d.deepgramApiKey, "");
    assert.equal(d.voiceModel, "nova-3");
    assert.equal(d.voiceTokenTtlSeconds, 30);
    assert.equal(d.voiceTokensPerMinute, 20);
    // The owner's rate (2026-09-28): Pay As You Go's current nova-3 price; Aura-2 at list.
    assert.equal(d.voiceSttUsdPerMinute, 0.0048);
    assert.equal(d.voiceTtsUsdPer1kChars, 0.03);
    assert.equal(loadConfig({ VOICE_STT_USD_PER_MINUTE: "0.0077" } as NodeJS.ProcessEnv).voiceSttUsdPerMinute, 0.0077);
    const low = loadConfig({ VOICE_TOKEN_TTL_SECONDS: "0", VOICE_TOKENS_PER_MINUTE: "-3" } as NodeJS.ProcessEnv);
    assert.equal(low.voiceTokenTtlSeconds, 1);
    assert.equal(low.voiceTokensPerMinute, 1);
    assert.equal(loadConfig({ VOICE_TOKEN_TTL_SECONDS: "99999" } as NodeJS.ProcessEnv).voiceTokenTtlSeconds, 3600);
  });
});
