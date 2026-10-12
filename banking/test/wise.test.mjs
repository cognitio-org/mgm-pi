import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool, handleRequest } from "../src/wise-mcp.mjs";
import {
  assertTokenGrant,
  assertWisePath,
  completeWiseLink,
  loadAppCredentials,
  parseAppSecret,
  readWiseCallback,
  wiseBalances,
  wiseProfiles,
  wiseStatement,
  wiseStatus,
  WiseError,
} from "../src/wise.mjs";

const CREDS = { client_id: "client-id", client_secret: "client-secret" };

async function privateEnv() {
  const dir = await mkdtemp(path.join(tmpdir(), "wise-"));
  await chmod(dir, 0o700);
  return { WISE_CONFIG_DIR: dir, WISE_CLIENT_ID: "client-id", WISE_CLIENT_SECRET: "client-secret" };
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    async text() { return JSON.stringify(body); },
  };
}

test("allowlist blocks payments, profile creation, and client-credential grants", () => {
  assert.throws(() => assertWisePath("POST", "/profiles/personal-profile"), /Blocked/);
  assert.throws(() => assertWisePath("POST", "/profiles/1/balances"), /Blocked/);
  assert.throws(() => assertWisePath("GET", "/profiles/1/balance-statements/2/statement.pdf"), /Blocked/);
  assert.throws(() => assertWisePath("GET", "/v1/identity/one-time-token/status"), /Blocked/);
  assert.throws(() => assertWisePath("POST", "/quotes"), /Blocked/);
  assert.throws(() => assertWisePath("POST", "/transfers"), /Blocked/);
  assert.doesNotThrow(() => assertWisePath("GET", "/profiles/42/balance-statements/7/statement.json"));
  assert.throws(() => assertTokenGrant("grant_type=client_credentials"), /not allowed/);
  assert.throws(() => assertTokenGrant("grant_type=authorization_code&client_secret=nope"), /client secret/);
  assert.throws(() => parseAppSecret("a-personal-token"), /not a Wise API key/);
  assert.throws(() => parseAppSecret(JSON.stringify({ token: "kernal-wise-key-token-value" })), /client_id/);
  assert.deepEqual(parseAppSecret("kernal-wise-key-token-value"), { kind: "key", token: "kernal-wise-key-token-value" });
  assert.deepEqual(parseAppSecret(JSON.stringify(CREDS)), {
    kind: "oauth", clientId: "client-id", clientSecret: "client-secret",
  });
});

test("a pasted personal token env var is refused", async () => {
  await assert.rejects(
    loadAppCredentials({ WISE_API_TOKEN: "kernal-wise-key-token-value" }),
    (err) => err instanceof WiseError && /personal Wise token/.test(err.message),
  );
});

test("callback requires the echoed state and a numeric profile id", () => {
  const ok = readWiseCallback("/callback?code=abc&state=state-1&profileId=99", "state-1");
  assert.equal(ok.code, "abc");
  assert.equal(ok.profileId, "99");
  const missing = readWiseCallback("/callback?code=abc&state=state-1", "state-1");
  assert.equal(missing.failed, true);
  assert.equal(missing.code, undefined);
  const mismatched = readWiseCallback("/callback?code=abc&state=other&profileId=99", "state-1");
  assert.equal(mismatched.status, 400);
});

test("status is unlinked before any Wise call", async () => {
  const env = await privateEnv();
  assert.deepEqual(await wiseStatus(env), {
    credential: "oauth",
    environment: "sandbox",
    linked: false,
    profileId: null,
    profileType: null,
    balances: 0,
    sca: null,
  });
  assert.equal((await wiseStatus({ ...env, WISE_ALLOW_PRODUCTION: "1" })).environment, "production");
});

test("link stores the profile and a later balance read stays on the sandbox host", async () => {
  const env = await privateEnv();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, body: init.body, authorization: init.headers.Authorization });
    if (String(url).endsWith("/oauth/token")) {
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 43199,
        refresh_token_expires_in: 100000,
      });
    }
    if (String(url).endsWith("/profiles")) {
      return jsonResponse([{ id: 99, type: "PERSONAL", fullName: "Hidden Person", email: "hidden@example.com" }]);
    }
    if (String(url).includes("/balances")) {
      return jsonResponse([{
        id: 7,
        currency: "EUR",
        type: "STANDARD",
        amount: { value: 12.5, currency: "EUR" },
        iban: "DE89370400440532013000",
      }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const linked = await completeWiseLink({
    code: "one-time-code",
    profileId: "99",
    env,
    fetchImpl,
    now: () => new Date("2026-10-12T00:00:00.000Z"),
  });
  assert.deepEqual(linked, { profileId: "99", profileType: "PERSONAL", balances: 1 });
  assert.equal(seen[0].url.startsWith("https://api.wise-sandbox.com/2026Q4/oauth/token"), true);
  assert.equal(seen[0].body.includes("client_secret"), false);
  assert.equal(seen[0].body.includes("grant_type=authorization_code"), true);
  assert.match(seen[0].authorization, /^Basic /);

  const balances = await wiseBalances(env, {
    fetchImpl: async (url) => {
      seen.push({ url: String(url) });
      if (String(url).includes("/balances")) {
        return jsonResponse([{ id: 7, currency: "EUR", type: "STANDARD", amount: { value: 12.5, currency: "EUR" } }]);
      }
      throw new Error(`unexpected ${url}`);
    },
    now: () => new Date("2026-10-12T01:00:00.000Z"),
  });
  assert.deepEqual(balances.balances, [{ index: 1, currency: "EUR", type: "STANDARD", amount: "12.5" }]);
  assert.equal(JSON.stringify(balances).includes("DE893"), false);
  assert.equal(JSON.stringify(balances).includes("Hidden"), false);
});

test("a statement that needs SCA stops without calling the challenge endpoint", async () => {
  const env = await privateEnv();
  const fetchImpl = async (url) => {
    const href = String(url);
    assert.equal(href.includes("one-time-token"), false);
    assert.equal(href.includes("statement.pdf"), false);
    if (href.endsWith("/oauth/token")) {
      return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 43199 });
    }
    if (href.endsWith("/profiles")) return jsonResponse([{ id: 99, type: "BUSINESS" }]);
    if (href.includes("/balances")) {
      return jsonResponse([{ id: 7, currency: "USD", type: "STANDARD", amount: { value: 1, currency: "USD" } }]);
    }
    if (href.includes("statement.json")) {
      return jsonResponse({ message: "sca" }, 403, { "x-2fa-approval-result": "REJECTED", "x-2fa-approval": "one-time" });
    }
    throw new Error(`unexpected ${href}`);
  };
  await completeWiseLink({ code: "c", profileId: "99", env, fetchImpl, now: () => new Date("2026-10-12T00:00:00.000Z") });
  await assert.rejects(
    wiseStatement(env, 1, 30, { fetchImpl, now: () => new Date("2026-10-12T01:00:00.000Z") }),
    (err) => err instanceof WiseError && err.code === "SCA_REQUIRED",
  );
  const status = await wiseStatus(env);
  assert.equal(status.sca, "required");
  assert.equal(status.linked, true);
});

test("statement text is masked and more than 90 days is refused", async () => {
  const env = await privateEnv();
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("/oauth/token")) {
      return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 43199 });
    }
    if (href.endsWith("/profiles")) return jsonResponse([{ id: 5, type: "PERSONAL" }]);
    if (href.includes("/balances")) {
      return jsonResponse([{ id: 8, currency: "GBP", type: "SAVINGS", amount: { value: 3, currency: "GBP" } }]);
    }
    if (href.includes("statement.json")) {
      assert.equal(href.includes("type=COMPACT"), true);
      return jsonResponse({
        transactions: [{
          date: "2026-10-01T00:00:00Z",
          type: "CREDIT",
          amount: { value: 10, currency: "GBP" },
          details: { description: "from GB29NWBK60161331926819", paymentReference: "rent" },
        }],
      });
    }
    throw new Error(`unexpected ${href}`);
  };
  await completeWiseLink({ code: "c", profileId: "5", env, fetchImpl, now: () => new Date("2026-10-12T00:00:00.000Z") });
  const statement = await wiseStatement(env, 1, 7, {
    fetchImpl,
    now: () => new Date("2026-10-12T01:00:00.000Z"),
  });
  assert.equal(JSON.stringify(statement).includes("31926819"), false);
  assert.match(statement.transactions[0].description, /GB••6819/);
  await assert.rejects(wiseStatement(env, 1, 91, { fetchImpl }), /days/);
});

test("an API key reads every profile on the production host and is not stored", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wise-key-"));
  await chmod(dir, 0o700);
  const env = { WISE_CONFIG_DIR: dir };
  const token = "kernal-wise-key-token-value";
  const loadCredentials = async () => ({ kind: "key", token });
  const fetchImpl = async (url, init) => {
    const href = String(url);
    assert.equal(href.startsWith("https://api.wise.com/2026Q4/"), true);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    if (href.endsWith("/profiles")) {
      return jsonResponse([
        { id: 1, type: "PERSONAL", fullName: "Hidden Person" },
        { id: 2, type: "BUSINESS", email: "hidden@example.com" },
      ]);
    }
    if (href.includes("/profiles/1/balances")) {
      return jsonResponse([{
        id: 10, currency: "EUR", type: "STANDARD", amount: { value: 1, currency: "EUR" }, iban: "DE89370400440532013000",
      }]);
    }
    if (href.includes("/profiles/2/balances")) {
      return jsonResponse([{ id: 11, currency: "USD", type: "SAVINGS", amount: { value: 2, currency: "USD" } }]);
    }
    if (href.includes("statement.json")) {
      assert.equal(href.includes("/profiles/2/balance-statements/11/"), true);
      return jsonResponse({ transactions: [] });
    }
    throw new Error(`unexpected ${href}`);
  };
  const profiles = await wiseProfiles(env, { fetchImpl, loadCredentials });
  assert.deepEqual(profiles.profiles, [
    { id: "1", type: "PERSONAL" },
    { id: "2", type: "BUSINESS" },
  ]);
  const balances = await wiseBalances(env, { fetchImpl, loadCredentials });
  assert.deepEqual(balances.balances, [
    { index: 1, currency: "EUR", type: "STANDARD", amount: "1" },
    { index: 2, currency: "USD", type: "SAVINGS", amount: "2" },
  ]);
  assert.equal(JSON.stringify(balances).includes("DE893"), false);
  assert.equal(JSON.stringify(balances).includes("Hidden"), false);
  const statement = await wiseStatement(env, 2, 7, {
    fetchImpl,
    loadCredentials,
    now: () => new Date("2026-10-12T00:00:00.000Z"),
  });
  assert.equal(statement.balance, 2);
  assert.equal(statement.currency, "USD");
  const stored = await readFile(path.join(dir, "key", "connection.json"), "utf8");
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes("DE893"), false);
  assert.equal(stored.includes("Hidden"), false);
  await assert.rejects(
    completeWiseLink({ code: "c", profileId: "1", env, fetchImpl, loadCredentials }),
    (err) => err instanceof WiseError && err.code === "NOT_CONFIGURED",
  );
  const before = await wiseStatus(env, { loadCredentials: async () => ({ kind: "key", token: "another-wise-key-value" }) });
  assert.equal(before.credential, "key");
  assert.equal(before.environment, "production");
  assert.equal(before.linked, true);
  const freshDir = await mkdtemp(path.join(tmpdir(), "wise-key-"));
  await chmod(freshDir, 0o700);
  const unlinked = await wiseStatus(
    { WISE_CONFIG_DIR: freshDir },
    { loadCredentials },
  );
  assert.equal(unlinked.linked, false);
  assert.equal(unlinked.credential, "key");
});

test("MCP tools are the read-only Wise set", async () => {
  const env = await privateEnv();
  const listed = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, env);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "wise_status", "wise_profiles", "wise_balances", "wise_statement",
  ]);
  const status = await callTool("wise_status", {}, env);
  assert.equal(status.linked, false);
  await assert.rejects(callTool("wise_balances", { code: "secret" }, env), /Unexpected argument/);
  await assert.rejects(callTool("transfer", {}, env), /Unknown tool/);
  const unlinked = await handleRequest({
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wise_balances", arguments: {} },
  }, env);
  assert.equal(unlinked.result.isError, true);
  assert.match(unlinked.result.content[0].text, /No Wise account is linked/);
});

test("a gcloud failure does not return the Wise key", async () => {
  const key = "kernal-wise-key-token-value";
  await assert.rejects(
    loadAppCredentials({}, async () => {
      const err = new Error(`gcloud failed: ${key}`);
      err.stderr = `secret ${key}`;
      err.code = 1;
      throw err;
    }),
    (err) => {
      assert.equal(err instanceof WiseError, true);
      assert.equal(err.message.includes(key), false);
      assert.equal(err.message, "Could not read kernal_wise_key.");
      return true;
    },
  );
});

test("statement balance must be a digit index, and an omitted index needs one stored balance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wise-idx-"));
  await chmod(root, 0o700);
  const env = { WISE_CONFIG_DIR: root };
  const loadCredentials = async () => ({ kind: "key", token: "kernal-wise-key-token-value" });
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("statement.json")) return jsonResponse({ transactions: [] });
    throw new Error(`unexpected ${href}`);
  };
  await assert.rejects(wiseStatement(env, true, 7, { fetchImpl, loadCredentials }), /balance/);
  await assert.rejects(wiseStatement(env, "1e1", 7, { fetchImpl, loadCredentials }), /balance/);
  await assert.rejects(wiseStatement(env, "0x10", 7, { fetchImpl, loadCredentials }), /balance/);
  await assert.rejects(wiseStatement(env, 1, "1e1", { fetchImpl, loadCredentials }), /days/);
  assert.equal(calls.length, 0);

  const keyDir = path.join(root, "key");
  await mkdir(keyDir, { mode: 0o700 });
  await chmod(keyDir, 0o700);
  const writeBalances = async (balances) => {
    const file = path.join(keyDir, "connection.json");
    await writeFile(file, `${JSON.stringify({ mode: "key", balances, sca: { status: "current" } })}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
  };
  const now = () => new Date("2026-10-12T00:00:00.000Z");
  await writeBalances([
    { index: 1, id: "10", currency: "EUR", type: "STANDARD", profileId: "1" },
    { index: 2, id: "11", currency: "USD", type: "SAVINGS", profileId: "2" },
  ]);
  await assert.rejects(
    wiseStatement(env, undefined, 7, { fetchImpl, loadCredentials, now }),
    /balance index/,
  );
  assert.equal(calls.length, 0);

  await writeBalances([{ index: 1, id: "10", currency: "EUR", type: "STANDARD", profileId: "1" }]);
  const statement = await wiseStatement(env, undefined, 7, { fetchImpl, loadCredentials, now });
  assert.equal(statement.balance, 1);
  assert.equal(calls.some((href) => href.includes("/profiles/1/balance-statements/10/")), true);
});

test("a stale Wise token lock is replaced and the refresh still runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wise-lock-"));
  await chmod(root, 0o700);
  const dir = path.join(root, "sandbox");
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  const env = { WISE_CONFIG_DIR: root, WISE_CLIENT_ID: "client-id", WISE_CLIENT_SECRET: "client-secret" };
  const tokens = path.join(dir, "tokens.json");
  const connection = path.join(dir, "connection.json");
  await writeFile(tokens, `${JSON.stringify({
    access_token: "old-access-token",
    refresh_token: "refresh-1",
    expires_at: "2020-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  await chmod(tokens, 0o600);
  await writeFile(connection, `${JSON.stringify({
    profileId: "5",
    profileType: "PERSONAL",
    balances: [{ index: 1, id: "8", currency: "GBP", type: "SAVINGS" }],
  })}\n`, { mode: 0o600 });
  await chmod(connection, 0o600);
  const lock = path.join(dir, "tokens.lock");
  await writeFile(lock, "2147483646", { mode: 0o600 });
  await chmod(lock, 0o600);
  try {
    process.kill(2147483646, 0);
    throw new Error("expected pid 2147483646 to be unused");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
  let refreshed = false;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("/oauth/token")) {
      refreshed = true;
      return jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 43199 });
    }
    if (href.includes("/balances")) return jsonResponse([]);
    throw new Error(`unexpected ${href}`);
  };
  const balances = await wiseBalances(env, { fetchImpl, now: () => new Date("2026-10-12T00:00:00.000Z") });
  assert.equal(refreshed, true);
  assert.deepEqual(balances.balances, []);
  await assert.rejects(lstat(lock), (err) => err.code === "ENOENT");
});

test("a live Wise token lock is left in place", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wise-live-lock-"));
  await chmod(root, 0o700);
  const dir = path.join(root, "sandbox");
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  const env = { WISE_CONFIG_DIR: root, WISE_CLIENT_ID: "client-id", WISE_CLIENT_SECRET: "client-secret" };
  const tokens = path.join(dir, "tokens.json");
  const connection = path.join(dir, "connection.json");
  await writeFile(tokens, `${JSON.stringify({
    access_token: "old-access-token",
    refresh_token: "refresh-1",
    expires_at: "2020-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  await chmod(tokens, 0o600);
  await writeFile(connection, `${JSON.stringify({
    profileId: "5",
    profileType: "PERSONAL",
    balances: [{ index: 1, id: "8", currency: "GBP", type: "SAVINGS" }],
  })}\n`, { mode: 0o600 });
  await chmod(connection, 0o600);
  const lock = path.join(dir, "tokens.lock");
  await writeFile(lock, String(process.pid), { mode: 0o600 });
  await chmod(lock, 0o600);
  let refreshed = false;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("/oauth/token")) {
      refreshed = true;
      return jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 43199 });
    }
    if (href.includes("/balances")) return jsonResponse([]);
    throw new Error(`unexpected ${href}`);
  };
  const pending = wiseBalances(env, { fetchImpl, now: () => new Date("2026-10-12T00:00:00.000Z") });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(refreshed, false);
  assert.equal(await readFile(lock, "utf8"), String(process.pid));
  await unlink(lock);
  const balances = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("refresh did not start after the lock was removed")), 2000)),
  ]);
  assert.equal(refreshed, true);
  assert.deepEqual(balances.balances, []);
});
