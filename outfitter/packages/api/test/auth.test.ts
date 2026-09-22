import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { identityFromRequest, identityFromLinkRequest, verifyAgentToken, bearerFromHeader, isOperator } from "../src/auth.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { ApiToken } from "../src/store/types.ts";

const devConfig = loadConfig({
  OUTFITTER_DEV: "1",
  OUTFITTER_DEV_TOKEN: "dev-secret",
  AGENT_SA_EMAIL: "agent@test.local",
} as NodeJS.ProcessEnv);

describe("identityFromRequest (dev mode)", () => {
  test("always returns dev@localhost, no header needed", async () => {
    const identity = await identityFromRequest({ headers: {} }, devConfig, new MemoryStore());
    assert.equal(identity.email, "dev@localhost");
  });

  test("dev@localhost is always an operator (EPIC.md Decisions table), even with OUTFITTER_OPERATORS unset", async () => {
    const identity = await identityFromRequest({ headers: {} }, devConfig, new MemoryStore());
    assert.equal(identity.operator, true);
  });
});

describe("isOperator", () => {
  test("matches case-insensitively after trimming", () => {
    const operators = ["mgm@mgms.eu", " matej@mgms.eu "];
    assert.equal(isOperator("MGM@mgms.eu", operators), true);
    assert.equal(isOperator("  matej@mgms.eu", operators), true);
    assert.equal(isOperator("someone-else@mgms.eu", operators), false);
  });

  test("an empty operators list matches no one", () => {
    assert.equal(isOperator("mgm@mgms.eu", []), false);
  });
});

async function tokenFor(store: MemoryStore, ownerEmail: string): Promise<string> {
  const { generateToken, hashToken, tokenPrefix } = await import("../src/tokens.ts");
  const plaintext = generateToken();
  const record: ApiToken = {
    id: crypto.randomUUID(),
    ownerEmail,
    name: "t",
    prefix: tokenPrefix(plaintext),
    hash: hashToken(plaintext),
    createdAt: new Date().toISOString(),
  };
  await store.tokens.insert(record);
  return plaintext;
}

describe("identityFromRequest: operator flag (non-dev)", () => {
  const prodConfig = loadConfig({ OUTFITTER_OPERATORS: "operator@mgms.eu" } as NodeJS.ProcessEnv);

  test("an outf_ token owned by an operator resolves operator: true", async () => {
    const store = new MemoryStore();
    const token = await tokenFor(store, "operator@mgms.eu");
    const identity = await identityFromRequest({ headers: { authorization: `Bearer ${token}` } }, prodConfig, store);
    assert.equal(identity.operator, true);
  });

  test("an outf_ token owned by a non-operator resolves operator: false", async () => {
    const store = new MemoryStore();
    const token = await tokenFor(store, "someone-else@mgms.eu");
    const identity = await identityFromRequest({ headers: { authorization: `Bearer ${token}` } }, prodConfig, store);
    assert.equal(identity.operator, false);
  });
});

describe("identityFromLinkRequest: never grants the operator role", () => {
  test("a link-role token owned by an operator still resolves operator: false", async () => {
    const store = new MemoryStore();
    const token = await tokenFor(store, "operator@mgms.eu");
    const identity = await identityFromLinkRequest({ headers: { authorization: `Bearer ${token}` } }, store);
    assert.equal(identity.email, "operator@mgms.eu");
    assert.equal(identity.operator, false);
  });
});

describe("verifyAgentToken (dev mode)", () => {
  test("accepts OUTFITTER_DEV_TOKEN and returns AGENT_SA_EMAIL", async () => {
    const identity = await verifyAgentToken("dev-secret", devConfig);
    assert.equal(identity.email, "agent@test.local");
  });

  test("rejects any other token", async () => {
    await assert.rejects(() => verifyAgentToken("wrong-token", devConfig));
  });

  test("rejects a missing token", async () => {
    await assert.rejects(() => verifyAgentToken(undefined, devConfig));
  });
});

describe("bearerFromHeader", () => {
  test("extracts the token from a well-formed header", () => {
    const token = bearerFromHeader({ headers: { authorization: "Bearer abc123" } });
    assert.equal(token, "abc123");
  });

  test("returns undefined for a missing or malformed header", () => {
    assert.equal(bearerFromHeader({ headers: {} }), undefined);
    assert.equal(bearerFromHeader({ headers: { authorization: "Basic abc123" } }), undefined);
    assert.equal(bearerFromHeader({ headers: { authorization: "Bearer" } }), undefined);
  });
});
