import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { GithubAppTokens, githubAppJwt, refreshDelayMs } from "../src/github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("githubAppJwt is an RS256 JWT for the app id", () => {
  const now = 1_700_000_000;
  const jwt = githubAppJwt("12345", pem, now);
  const [header, payload, sig] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  const body = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(body.iss, "12345");
  assert.equal(body.iat, now - 60);
  assert.equal(body.exp, now + 9 * 60);
  assert.equal(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, sig, "base64url"), true);
});

test("refreshDelayMs asks five minutes before expiry and never sooner than 30s", () => {
  const now = Date.parse("2026-09-24T04:00:00Z");
  assert.equal(refreshDelayMs("2026-09-24T05:00:00Z", now), 55 * 60_000);
  assert.equal(refreshDelayMs("2026-09-24T04:01:00Z", now), 30_000);
  assert.equal(refreshDelayMs("not-a-date", now), undefined);
});

test("GithubAppTokens mints once per repo and a per-session PAT is not involved", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const tokens = new GithubAppTokens(
    async (name) => {
      if (name.endsWith("-id") && name.includes("installation")) return "99";
      if (name.endsWith("-id")) return "12345";
      if (name.includes("private-key")) return pem;
      return "";
    },
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2026-09-24T06:00:00Z" }), { status: 201 });
    }) as typeof fetch,
    () => Date.parse("2026-09-24T04:00:00Z"),
  );
  const first = await tokens.mint("cognitio-org/testit");
  const second = await tokens.mint("cognitio-org/testit");
  assert.equal(first?.token, "ghs_minted");
  assert.equal(second?.token, "ghs_minted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/app/installations/99/access_tokens");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization.startsWith("Bearer "), true);
  assert.equal(headers.Authorization.includes(pem), false);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { repositories: ["testit"] });
  assert.equal(await tokens.mint("not a repo"), undefined);
});

test("GithubAppTokens returns undefined when the App secrets are absent", async () => {
  const tokens = new GithubAppTokens(async () => "");
  assert.equal(await tokens.mint("o/r"), undefined);
});

test("GithubAppTokens mints the repo name from URL and .git forms", async () => {
  const repos: string[] = [];
  const tokens = new GithubAppTokens(
    async (name) => {
      if (name.includes("installation")) return "99";
      if (name.includes("private-key")) return pem;
      return "12345";
    },
    (async (_url: string, init?: RequestInit) => {
      repos.push(JSON.parse(String(init?.body)).repositories[0]);
      return new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2026-09-24T06:00:00Z" }), { status: 201 });
    }) as typeof fetch,
    () => Date.parse("2026-09-24T04:00:00Z"),
  );
  assert.equal((await tokens.mint("https://github.com/cognitio-org/testit.git"))?.token, "ghs_minted");
  assert.equal((await tokens.mint("git@github.com:cognitio-org/other.git"))?.token, "ghs_minted");
  assert.equal((await tokens.mint("cognitio-org/third.git"))?.token, "ghs_minted");
  assert.deepEqual(repos, ["testit", "other", "third"]);
});

test("GithubAppTokens returns undefined for a key that is not a usable PEM", async () => {
  const tokens = new GithubAppTokens(async (name) => {
    if (name.includes("installation")) return "99";
    if (name.includes("private-key")) return "-----BEGIN PRIVATE KEY-----\nnot-a-pem\n-----END PRIVATE KEY-----";
    return "12345";
  });
  assert.equal(await tokens.mint("o/r"), undefined);
});

test("GithubAppTokens returns undefined when GitHub's body is not JSON", async () => {
  const tokens = new GithubAppTokens(
    async (name) => {
      if (name.includes("installation")) return "99";
      if (name.includes("private-key")) return pem;
      return "12345";
    },
    (async () => new Response("nope", { status: 200 })) as typeof fetch,
  );
  assert.equal(await tokens.mint("o/r"), undefined);
});

test("GithubAppTokens returns undefined when a secret read throws", async () => {
  const tokens = new GithubAppTokens(async () => {
    throw new Error("secret manager unavailable");
  });
  assert.equal(await tokens.mint("o/r"), undefined);
});
