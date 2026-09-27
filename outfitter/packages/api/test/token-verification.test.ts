/**
 * The real google-auth-library verification behind verifyAgentToken, verifyTasksToken and the IAP
 * assertion, with only the public-key fetch stubbed: tokens are signed here with test keys, so the
 * library's own signature, audience, issuer and expiry checks run. The other tests stub
 * verifyIdToken wholesale, so a library upgrade (PR #233: v9 -> v11) that loosened any of these
 * would not show up there.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { loadConfig } from "../src/config.ts";
import { identityFromRequest, verifyAgentToken, verifyTasksToken } from "../src/auth.ts";
import { MemoryStore } from "../src/store/memory.ts";

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

function jwt(alg: "RS256" | "ES256", key: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signer = createSign("SHA256");
  signer.update(`${head}.${body}`);
  const sig = alg === "ES256" ? signer.sign({ key, dsaEncoding: "ieee-p1363" }) : signer.sign(key);
  return `${head}.${body}.${b64url(sig)}`;
}

const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const iap = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const GOOGLE_KID = "test-google-kid";
const IAP_KID = "test-iap-kid";
const googlePem = google.publicKey.export({ type: "spki", format: "pem" }).toString();
const iapPem = iap.publicKey.export({ type: "spki", format: "pem" }).toString();

const ORIGIN = "https://link.example.com";
const config = loadConfig({
  OUTFITTER_DEV: "0",
  OUTFITTER_ORIGIN: ORIGIN,
  AGENT_SA_EMAIL: "agent@p.iam.gserviceaccount.com",
  TASKS_SA_EMAIL: "tasks@p.iam.gserviceaccount.com",
  IAP_AUDIENCE: "/projects/1/global/backendServices/2",
} as NodeJS.ProcessEnv);

const now = () => Math.floor(Date.now() / 1000);
function idToken(over: Record<string, unknown> = {}, key: KeyObject = google.privateKey): string {
  return jwt("RS256", key, GOOGLE_KID, {
    iss: "https://accounts.google.com",
    aud: ORIGIN,
    sub: "1234567890",
    email: "agent@p.iam.gserviceaccount.com",
    email_verified: true,
    iat: now() - 10,
    exp: now() + 600,
    ...over,
  });
}

/** Stubs only the key fetch: Google's (verifyIdToken) and IAP's (getIapPublicKeys). */
function stubKeys(t: { mock: { method: typeof import("node:test").mock.method } }) {
  t.mock.method(OAuth2Client.prototype, "getFederatedSignonCertsAsync", async () => ({ certs: { [GOOGLE_KID]: googlePem }, format: "PEM" }));
  t.mock.method(OAuth2Client.prototype, "getIapPublicKeys", async () => ({ pubkeys: { [IAP_KID]: iapPem } }));
}

describe("verifyAgentToken with real verification", () => {
  test("accepts a valid token for the agent account", async (t) => {
    stubKeys(t);
    assert.equal((await verifyAgentToken(idToken(), config)).email, "agent@p.iam.gserviceaccount.com");
  });

  const rejects: Array<[string, () => string]> = [
    ["a wrong audience", () => idToken({ aud: "https://evil.example.com" })],
    ["a wrong issuer", () => idToken({ iss: "https://evil.example.com" })],
    ["an expired token", () => idToken({ iat: now() - 7200, exp: now() - 3600 })],
    ["a missing email", () => idToken({ email: undefined })],
    ["an unverified email", () => idToken({ email_verified: false })],
    ["another account", () => idToken({ email: "someone@p.iam.gserviceaccount.com" })],
    ["a signature by another key", () => idToken({}, stranger.privateKey)],
    ["a tampered payload", () => { const [h, , s] = idToken().split("."); return `${h}.${b64url(JSON.stringify({ iss: "https://accounts.google.com", aud: ORIGIN, email: "agent@p.iam.gserviceaccount.com", exp: now() + 600, iat: now() }))}.${s}`; }],
  ];
  for (const [name, make] of rejects) {
    test(`rejects ${name}`, async (t) => {
      stubKeys(t);
      await assert.rejects(verifyAgentToken(make(), config));
    });
  }
});

describe("verifyTasksToken with real verification", () => {
  test("accepts the tasks account, rejects the agent account and a wrong audience", async (t) => {
    stubKeys(t);
    await verifyTasksToken(idToken({ email: "tasks@p.iam.gserviceaccount.com" }), config);
    await assert.rejects(verifyTasksToken(idToken(), config), /TASKS_SA_EMAIL/);
    await assert.rejects(verifyTasksToken(idToken({ email: "tasks@p.iam.gserviceaccount.com", aud: "https://other" }), config));
  });
});

describe("IAP assertion with real verification", () => {
  const iapJwt = (over: Record<string, unknown> = {}, key: KeyObject = iap.privateKey) =>
    jwt("ES256", key, IAP_KID, {
      iss: "https://cloud.google.com/iap",
      aud: config.iapAudience,
      sub: "accounts.google.com:1",
      email: "person@example.com",
      iat: now() - 10,
      exp: now() + 600,
      ...over,
    });
  const asRequest = (assertion: string) => ({ headers: { "x-goog-iap-jwt-assertion": assertion } });

  test("accepts a valid assertion", async (t) => {
    stubKeys(t);
    assert.equal((await identityFromRequest(asRequest(iapJwt()), config, new MemoryStore())).email, "person@example.com");
  });

  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rejects: Array<[string, () => string]> = [
    ["a wrong audience", () => iapJwt({ aud: "/projects/1/global/backendServices/999" })],
    ["a wrong issuer", () => iapJwt({ iss: "https://accounts.google.com" })],
    ["an expired assertion", () => iapJwt({ iat: now() - 7200, exp: now() - 3600 })],
    ["a missing email", () => iapJwt({ email: undefined })],
    ["a signature by another key", () => iapJwt({}, other.privateKey)],
  ];
  for (const [name, make] of rejects) {
    test(`rejects ${name}`, async (t) => {
      stubKeys(t);
      await assert.rejects(identityFromRequest(asRequest(make()), config, new MemoryStore()));
    });
  }
});
