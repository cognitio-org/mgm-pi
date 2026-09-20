import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { identityFromRequest, verifyAgentToken, bearerFromHeader } from "../src/auth.ts";

const devConfig = loadConfig({
  OUTFITTER_DEV: "1",
  OUTFITTER_DEV_TOKEN: "dev-secret",
  AGENT_SA_EMAIL: "agent@test.local",
} as NodeJS.ProcessEnv);

describe("identityFromRequest (dev mode)", () => {
  test("always returns dev@localhost, no header needed", async () => {
    const identity = await identityFromRequest({ headers: {} }, devConfig);
    assert.equal(identity.email, "dev@localhost");
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
