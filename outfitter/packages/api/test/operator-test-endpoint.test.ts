// Unit tests for routes/operator.ts's per-kind secret test probes (POST /api/operator/secrets/
// :secretName/test), exercised directly against testSecretValue/detailFromJson with a fake fetch --
// same approach as providers-status.test.ts's exported probe functions, so no real network calls
// happen in CI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { testSecretValue, detailFromJson } from "../src/routes/operator.ts";

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("testSecretValue: litellm", () => {
  test("ok when GET <root>/key/info succeeds", async () => {
    const fetchImpl = fakeFetch((url) => {
      assert.equal(url, "https://litellm.example.com/key/info");
      return jsonResponse({ info: { spend: 1 } });
    });
    const result = await testSecretValue("litellm", "sk-test", "https://litellm.example.com/v1", "", fetchImpl);
    assert.deepEqual(result, { ok: true });
  });

  test("not ok with the provider's own error text on a non-2xx", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ error: { message: "invalid key" } }, 401));
    const result = await testSecretValue("litellm", "bad-key", "https://litellm.example.com/v1", "", fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.detail, "invalid key");
  });
});

describe("testSecretValue: github", () => {
  test("ok when GET https://api.github.com/user succeeds", async () => {
    const fetchImpl = fakeFetch((url) => {
      assert.equal(url, "https://api.github.com/user");
      return jsonResponse({ login: "mgm" });
    });
    const result = await testSecretValue("github", "ghp_test", "", "", fetchImpl);
    assert.deepEqual(result, { ok: true });
  });

  test("not ok with GitHub's own message on a non-2xx", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ message: "Bad credentials" }, 401));
    const result = await testSecretValue("github", "bad-pat", "", "", fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.detail, "Bad credentials");
  });
});

describe("testSecretValue: ngrok", () => {
  test("ok when GET https://api.ngrok.com/endpoints succeeds, with the ngrok headers", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      assert.equal(url, "https://api.ngrok.com/endpoints");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer ngrok-key");
      assert.equal(headers["Ngrok-Version"], "2");
      return jsonResponse({ endpoints: [] });
    });
    const result = await testSecretValue("ngrok", "ngrok-key", "", "", fetchImpl);
    assert.deepEqual(result, { ok: true });
  });

  test("not ok on a non-2xx", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ error: { message: "invalid api key" } }, 401));
    const result = await testSecretValue("ngrok", "bad-key", "", "", fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.detail, "invalid api key");
  });
});

describe("testSecretValue: tunnel", () => {
  test("ok when GET https://<tunnelDomain>/v1/models succeeds", async () => {
    const fetchImpl = fakeFetch((url) => {
      assert.equal(url, "https://mgm-lmstudio.ngrok.app/v1/models");
      return jsonResponse({ data: [] });
    });
    const result = await testSecretValue("tunnel", "tunnel-token", "", "mgm-lmstudio.ngrok.app", fetchImpl);
    assert.deepEqual(result, { ok: true });
  });

  test("not ok when the tunnel domain isn't configured", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({}));
    const result = await testSecretValue("tunnel", "tunnel-token", "", "", fetchImpl);
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /not configured/);
  });
});

describe("testSecretValue: network failure / timeout", () => {
  test("not ok, with the failure reason as detail, when fetch itself rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const result = await testSecretValue("github", "ghp_test", "", "", fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.detail, "fetch failed");
  });
});

describe("detailFromJson", () => {
  test("prefers message, then error, then detail, then msg", () => {
    assert.equal(detailFromJson({ message: "m" }, 400), "m");
    assert.equal(detailFromJson({ error: "e" }, 400), "e");
    assert.equal(detailFromJson({ detail: "d" }, 400), "d");
    assert.equal(detailFromJson({ msg: "ms" }, 400), "ms");
  });

  test("reads a nested error.message shape", () => {
    assert.equal(detailFromJson({ error: { message: "nested" } }, 400), "nested");
  });

  test("falls back to the HTTP status when nothing usable is present", () => {
    assert.equal(detailFromJson({}, 503), "HTTP 503");
    assert.equal(detailFromJson(undefined, 500), "HTTP 500");
  });
});
