import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { GithubAppTokens, githubAppJwt, refreshDelayMs, type MintResult } from "../src/github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const tokenOf = (result: MintResult) => (result.ok ? result.token : undefined);

const appSecrets = async (name: string) => {
  if (name.includes("installation")) return "99";
  if (name.includes("private-key")) return pem;
  return "12345";
};

/** GithubAppTokens whose access_tokens call answers with `answer`. */
function tokensAnswering(answer: () => Promise<Response>) {
  return new GithubAppTokens(appSecrets, (async () => answer()) as typeof fetch, () => Date.parse("2026-09-24T04:00:00Z"));
}

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
      if (url.includes("/installation/repositories")) {
        return new Response(JSON.stringify({ repositories: [{ full_name: "cognitio-org/testit" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2026-09-24T06:00:00Z" }), { status: 201 });
    }) as typeof fetch,
    () => Date.parse("2026-09-24T04:00:00Z"),
  );
  const first = await tokens.mint("cognitio-org/testit");
  const second = await tokens.mint("cognitio-org/testit");
  assert.equal(tokenOf(first), "ghs_minted");
  assert.equal(tokenOf(second), "ghs_minted");
  const minted = calls.filter((call) => call.url.includes("/access_tokens"));
  assert.equal(minted.length, 1);
  assert.equal(minted[0].url, "https://api.github.com/app/installations/99/access_tokens");
  const headers = minted[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization.startsWith("Bearer "), true);
  assert.equal(headers.Authorization.includes(pem), false);
  assert.ok(minted[0].init?.signal);
  const body = JSON.parse(String(minted[0].init?.body));
  assert.deepEqual(body.repositories, ["testit"]);
  assert.equal(body.permissions.contents, "write");
  assert.equal(body.permissions.metadata, "read");
  assert.deepEqual(await tokens.mint("not a repo"), { ok: false, reason: "not-installed" });
  // A same-named repo on the installation's own account is not this one.
  assert.deepEqual(await tokens.mint("fork/testit"), { ok: false, reason: "not-installed" });
  assert.equal(tokenOf(await tokens.mint("Cognitio-Org/testit")), "ghs_minted");
});

test("GithubAppTokens reports not-configured when the App secrets are absent", async () => {
  const tokens = new GithubAppTokens(async () => "");
  assert.deepEqual(await tokens.mint("o/r"), { ok: false, reason: "not-configured" });
});

test("GithubAppTokens mints the repo name from URL and .git forms", async () => {
  const repos: string[] = [];
  const tokens = new GithubAppTokens(
    async (name) => {
      if (name.includes("installation")) return "99";
      if (name.includes("private-key")) return pem;
      return "12345";
    },
    (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/installation/repositories")) {
        return new Response(JSON.stringify({
          repositories: [
            { full_name: "cognitio-org/testit" },
            { full_name: "cognitio-org/other" },
            { full_name: "cognitio-org/third" },
          ],
        }), { status: 200 });
      }
      const repoName = JSON.parse(String(init?.body)).repositories[0] as string;
      repos.push(repoName);
      const full = repoName === "other" ? "cognitio-org/other" : repoName === "third" ? "cognitio-org/third" : "cognitio-org/testit";
      return new Response(JSON.stringify({
        token: "ghs_minted",
        expires_at: "2026-09-24T06:00:00Z",
        repositories: [{ full_name: full }],
      }), { status: 201 });
    }) as typeof fetch,
    () => Date.parse("2026-09-24T04:00:00Z"),
  );
  assert.equal(tokenOf(await tokens.mint("https://github.com/cognitio-org/testit.git")), "ghs_minted");
  assert.equal(tokenOf(await tokens.mint("git@github.com:cognitio-org/other.git")), "ghs_minted");
  assert.equal(tokenOf(await tokens.mint("cognitio-org/third.git")), "ghs_minted");
  assert.deepEqual(repos, ["testit", "other", "third"]);
});

test("GithubAppTokens reports unavailable, not not-configured, for a key that will not sign", async () => {
  const tokens = new GithubAppTokens(async (name) => {
    if (name.includes("installation")) return "99";
    if (name.includes("private-key")) return "-----BEGIN PRIVATE KEY-----\nnot-a-pem\n-----END PRIVATE KEY-----";
    return "12345";
  });
  assert.deepEqual(await tokens.mint("o/r"), { ok: false, reason: "unavailable" });
});

test("GithubAppTokens reports unavailable when GitHub's body is not JSON", async () => {
  const tokens = new GithubAppTokens(
    async (name) => {
      if (name.includes("installation")) return "99";
      if (name.includes("private-key")) return pem;
      return "12345";
    },
    (async () => new Response("nope", { status: 200 })) as typeof fetch,
  );
  assert.deepEqual(await tokens.mint("o/r"), { ok: false, reason: "unavailable" });
});

test("GithubAppTokens reports unavailable when a secret read throws", async () => {
  const tokens = new GithubAppTokens(async () => {
    throw new Error("secret manager unavailable");
  });
  assert.deepEqual(await tokens.mint("o/r"), { ok: false, reason: "unavailable" });
});

test("#158: a partly set or wrong App secret is misconfigured, not not-configured", async () => {
  const secrets = (values: Record<string, string>) => async (name: string) =>
    name.includes("installation") ? (values.installation ?? "") : name.includes("private-key") ? (values.key ?? "") : (values.id ?? "");
  for (const [label, values] of [
    ["a Client ID instead of the numeric App id", { id: "Iv1.abc123", key: pem, installation: "99" }],
    ["no installation id (mid-reinstall)", { id: "12345", key: pem }],
    ["a key without a PEM header", { id: "12345", key: "bm90IGEga2V5", installation: "99" }],
    ["only the App id", { id: "12345" }],
  ] as const) {
    const tokens = new GithubAppTokens(secrets(values), (async () => {
      throw new Error("must not call GitHub");
    }) as typeof fetch);
    assert.deepEqual(await tokens.mint("o/r"), { ok: false, reason: "misconfigured" }, label);
  }
  const blank = new GithubAppTokens(async () => "  ");
  assert.deepEqual(await blank.mint("o/r"), { ok: false, reason: "not-configured" }, "whitespace only counts as unset");
});

test("#158: with no App at all, even an odd repo string is not-configured (the shared PAT still applies)", async () => {
  const tokens = new GithubAppTokens(async () => "");
  assert.deepEqual(await tokens.mint("not a repo"), { ok: false, reason: "not-configured" });
});

test("#158: GitHub refusing the repo or the installation is not-installed", async () => {
  for (const status of [422, 404]) {
    const tokens = tokensAnswering(async () => new Response(JSON.stringify({ message: "nope" }), { status }));
    assert.deepEqual(await tokens.mint("o/r"), { ok: false, reason: "not-installed" }, `status ${status}`);
  }
});

test("#158: a 5xx, a 401, a rate limit, or a network error is unavailable, never not-configured", async () => {
  for (const status of [500, 502, 401, 403, 429]) {
    const tokens = tokensAnswering(async () => new Response("{}", { status }));
    assert.deepEqual(await tokens.mint("o/r"), { ok: false, reason: "unavailable" }, `status ${status}`);
  }
  const offline = tokensAnswering(async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await offline.mint("o/r"), { ok: false, reason: "unavailable" });
});

test("#158: a repository check that can't be read is unavailable; one naming another repo is not-installed", async () => {
  const minted = () => new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2026-09-24T06:00:00Z" }), { status: 201 });
  const checkDown = new GithubAppTokens(
    appSecrets,
    (async (url: string) => (String(url).includes("/installation/repositories") ? new Response("", { status: 503 }) : minted())) as typeof fetch,
    () => Date.parse("2026-09-24T04:00:00Z"),
  );
  assert.deepEqual(await checkDown.mint("o/r"), { ok: false, reason: "unavailable" });
  const otherRepo = new GithubAppTokens(
    appSecrets,
    (async (url: string) =>
      String(url).includes("/installation/repositories")
        ? new Response(JSON.stringify({ repositories: [{ full_name: "someone/r" }] }), { status: 200 })
        : minted()) as typeof fetch,
    () => Date.parse("2026-09-24T04:00:00Z"),
  );
  assert.deepEqual(await otherRepo.mint("o/r"), { ok: false, reason: "not-installed" });
});
