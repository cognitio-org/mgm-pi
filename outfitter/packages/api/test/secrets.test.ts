// GcpSecretsBroker with a stubbed fetchSecret (no ADC/network): the "not found" -> "" fallback,
// the outfitter-litellm-key-default / outfitter-github-token-default fallbacks, and that non-404
// errors still propagate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GcpSecretsBroker, GITHUB_TOKEN_DEFAULT_SECRET } from "../src/secrets.ts";
import { GITHUB_APP_ID_SECRET, GITHUB_APP_INSTALLATION_SECRET, GITHUB_APP_KEY_SECRET, GithubAppTokens } from "../src/github-app.ts";
import type { Session, Guru } from "../src/store/types.ts";

function testSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: "s1",
    guruId: "g1",
    repo: "o/r",
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function testGuru(overrides: Partial<Guru> = {}): Guru {
  const now = new Date().toISOString();
  return { id: "g1", name: "Test Guru", model: "provider/model", createdAt: now, updatedAt: now, ...overrides };
}

function notFoundError(): Error & { response: { status: number } } {
  const err = new Error("Secret [projects/x/secrets/y] not found") as Error & { response: { status: number } };
  err.response = { status: 404 };
  return err;
}

describe("GcpSecretsBroker", () => {
  test("a missing githubToken/litellmKey secret resolves to \"\" instead of throwing", async () => {
    const broker = new GcpSecretsBroker("proj", async () => {
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.deepEqual(secrets, { githubToken: "", litellmKey: "" });
  });

  test("falls back to outfitter-litellm-key-default when outfitter-litellm-key-<guruId> is missing", async () => {
    const requested: string[] = [];
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      requested.push(secretId);
      if (secretId === "outfitter-litellm-key-default") return "default-key";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.litellmKey, "default-key");
    assert.ok(requested.includes("outfitter-litellm-key-g1"));
    assert.ok(requested.includes("outfitter-litellm-key-default"));
  });

  test("does not fall back to the default key when the guru's own key exists", async () => {
    const requested: string[] = [];
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      requested.push(secretId);
      if (secretId === "outfitter-litellm-key-g1") return "guru-key";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.litellmKey, "guru-key");
    assert.ok(!requested.includes("outfitter-litellm-key-default"));
  });

  test("fetches the per-session github token by id", async () => {
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      if (secretId === "outfitter-github-token-s1") return "gh-token";
      if (secretId === "outfitter-litellm-key-g1") return "guru-key";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "gh-token");
  });

  test("falls back to outfitter-github-token-default when outfitter-github-token-<sessionId> is missing", async () => {
    const requested: string[] = [];
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      requested.push(secretId);
      if (secretId === GITHUB_TOKEN_DEFAULT_SECRET) return "shared-token";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "shared-token");
    assert.ok(requested.includes("outfitter-github-token-s1"));
    assert.ok(requested.includes(GITHUB_TOKEN_DEFAULT_SECRET));
  });

  test("does not fall back to the shared token when the session's own token exists", async () => {
    const requested: string[] = [];
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      requested.push(secretId);
      if (secretId === "outfitter-github-token-s1") return "own-token";
      if (secretId === "outfitter-github-token-default") return "shared-token";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "own-token");
    assert.ok(!requested.includes("outfitter-github-token-default"));
  });

  // Neither secret exists: still "" rather than a throw, because that's what agentlink.ts's
  // buildRunSpec turns into the terminal MissingGithubTokenError for a *repo* session (and
  // deliberately ignores for a repo-less one).
  test("a configured GitHub App is minted and the shared PAT is left unused", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const requested: string[] = [];
    const fetchSecret = async (secretId: string) => {
      requested.push(secretId);
      if (secretId === GITHUB_APP_ID_SECRET) return "42";
      if (secretId === GITHUB_APP_INSTALLATION_SECRET) return "7";
      if (secretId === GITHUB_APP_KEY_SECRET) return pem;
      if (secretId === GITHUB_TOKEN_DEFAULT_SECRET) return "shared-token";
      throw notFoundError();
    };
    const app = new GithubAppTokens(
      async (secretId) => {
        try { return (await fetchSecret(secretId)).trim(); } catch { return ""; }
      },
      (async (url: string) => {
        if (String(url).includes("/installation/repositories")) {
          return new Response(JSON.stringify({ repositories: [{ full_name: "o/r" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ token: "ghs_from_app", expires_at: "2026-09-24T06:00:00Z" }), { status: 201 });
      }) as typeof fetch,
    );
    const broker = new GcpSecretsBroker("proj", fetchSecret, app);
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "ghs_from_app");
    assert.equal(secrets.githubTokenExpiresAt, "2026-09-24T06:00:00Z");
    assert.ok(!requested.includes(GITHUB_TOKEN_DEFAULT_SECRET));
    assert.equal(JSON.stringify(secrets).includes(pem), false);
  });

  test("#158: a non-404 error reading an App secret is unavailable, not a reason to use the shared PAT", async () => {
    const requested: string[] = [];
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      requested.push(secretId);
      if (secretId === GITHUB_TOKEN_DEFAULT_SECRET) return "shared-token";
      if (secretId === GITHUB_APP_ID_SECRET) {
        const err = new Error("unavailable") as Error & { response: { status: number } };
        err.response = { status: 503 };
        throw err;
      }
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "");
    assert.equal(secrets.githubAppFailure, "unavailable");
    assert.ok(!requested.includes(GITHUB_TOKEN_DEFAULT_SECRET));
  });

  test("#158: an App key that won't sign is unavailable, not a reason to use the shared PAT", async () => {
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      if (secretId === GITHUB_APP_ID_SECRET) return "42";
      if (secretId === GITHUB_APP_INSTALLATION_SECRET) return "7";
      if (secretId === GITHUB_APP_KEY_SECRET) return "-----BEGIN PRIVATE KEY-----\nnot-a-pem\n-----END PRIVATE KEY-----";
      if (secretId === GITHUB_TOKEN_DEFAULT_SECRET) return "shared-token";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "");
    assert.equal(secrets.githubAppFailure, "unavailable");
    assert.equal(secrets.githubTokenExpiresAt, undefined);
  });

  test("#158: a repo the App isn't installed on gets no token and not-installed, never the shared PAT", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const requested: string[] = [];
    const fetchSecret = async (secretId: string) => {
      requested.push(secretId);
      if (secretId === GITHUB_APP_ID_SECRET) return "42";
      if (secretId === GITHUB_APP_INSTALLATION_SECRET) return "7";
      if (secretId === GITHUB_APP_KEY_SECRET) return pem;
      if (secretId === GITHUB_TOKEN_DEFAULT_SECRET) return "shared-token";
      throw notFoundError();
    };
    const app = new GithubAppTokens(
      async (secretId) => (await fetchSecret(secretId)).trim(),
      (async () => new Response(JSON.stringify({ message: "not accessible" }), { status: 422 })) as typeof fetch,
    );
    const secrets = await new GcpSecretsBroker("proj", fetchSecret, app).secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "");
    assert.equal(secrets.githubAppFailure, "not-installed");
    assert.ok(!requested.includes(GITHUB_TOKEN_DEFAULT_SECRET));
  });

  test("a failed refresh returns nothing, and secretsForRun doesn't hand out the shared PAT either", async () => {
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      if (secretId === GITHUB_TOKEN_DEFAULT_SECRET) return "shared-token";
      if (secretId === GITHUB_APP_ID_SECRET) return "42";
      if (secretId === GITHUB_APP_INSTALLATION_SECRET) return "7";
      if (secretId === GITHUB_APP_KEY_SECRET) return "-----BEGIN PRIVATE KEY-----\nnot-a-pem\n-----END PRIVATE KEY-----";
      throw notFoundError();
    });
    assert.equal(await broker.refreshGithubAppToken(testSession()), undefined);
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "");
    assert.equal(secrets.githubAppFailure, "unavailable");
  });

  test("a refresh after a per-session PAT is added returns that PAT and stops the App", async () => {
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      if (secretId === "outfitter-github-token-s1") return "own-token";
      if (secretId === GITHUB_APP_ID_SECRET) return "42";
      if (secretId === GITHUB_APP_INSTALLATION_SECRET) return "7";
      if (secretId === GITHUB_APP_KEY_SECRET) return "-----BEGIN PRIVATE KEY-----\nnot-used\n-----END PRIVATE KEY-----";
      throw notFoundError();
    });
    const next = await broker.refreshGithubAppToken(testSession());
    assert.deepEqual(next, { token: "own-token" });
  });

  test("a session PAT wins over a configured GitHub App", async () => {
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      if (secretId === "outfitter-github-token-s1") return "own-token";
      if (secretId === GITHUB_APP_ID_SECRET) return "42";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "own-token");
    assert.equal(secrets.githubTokenExpiresAt, undefined);
  });

  test("resolves to \"\" when neither the per-session nor the shared github token exists", async () => {
    const requested: string[] = [];
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      requested.push(secretId);
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession(), testGuru());
    assert.equal(secrets.githubToken, "");
    assert.ok(requested.includes("outfitter-github-token-s1"));
    assert.ok(requested.includes(GITHUB_TOKEN_DEFAULT_SECRET));
  });

  // run.spec carries `secrets` for every run, repo or not, so an unconditional fallback would put
  // the org-wide token in sandboxes that have nothing to clone or push.
  test("a repo-less session does not fall back to the shared token", async () => {
    const requested: string[] = [];
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      requested.push(secretId);
      if (secretId === GITHUB_TOKEN_DEFAULT_SECRET) return "shared-token";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession({ repo: undefined }), testGuru());
    assert.equal(secrets.githubToken, "");
    assert.ok(!requested.includes(GITHUB_TOKEN_DEFAULT_SECRET));
  });

  // ...but a token created for that session by hand is a deliberate grant, so it still flows.
  test("a repo-less session still gets its own token when one exists", async () => {
    const broker = new GcpSecretsBroker("proj", async (secretId) => {
      if (secretId === "outfitter-github-token-s1") return "own-token";
      throw notFoundError();
    });
    const secrets = await broker.secretsForRun(testSession({ repo: undefined }), testGuru());
    assert.equal(secrets.githubToken, "own-token");
  });

  test("a non-404 error still propagates instead of resolving to \"\"", async () => {
    const broker = new GcpSecretsBroker("proj", async () => {
      throw new Error("boom: auth failure");
    });
    await assert.rejects(() => broker.secretsForRun(testSession(), testGuru()), /boom/);
  });
});
