// GcpSecretsBroker with a stubbed fetchSecret (no ADC/network): the "not found" -> "" fallback,
// the outfitter-litellm-key-default fallback, and that non-404 errors still propagate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GcpSecretsBroker } from "../src/secrets.ts";
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

  test("a non-404 error still propagates instead of resolving to \"\"", async () => {
    const broker = new GcpSecretsBroker("proj", async () => {
      throw new Error("boom: auth failure");
    });
    await assert.rejects(() => broker.secretsForRun(testSession(), testGuru()), /boom/);
  });
});
