import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import https from "node:https";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { init } from "../src/actions.mjs";
import {
  consentBody,
  assertTransactionId,
  projectAccountDetails,
  projectTransaction,
  psuHeaders,
  readCallbackQuery,
  rememberAccount,
} from "../src/banking.mjs";
import { ApiError, assertAllowed, createClient } from "../src/client.mjs";
import { ConfigError, loadConfig, parseEnvFile, parseRedirect } from "../src/config.mjs";
import { signJwt } from "../src/jwt.mjs";
import { waitForCallback } from "../src/link.mjs";
import { ensureCallbackTls, loadCallbackTls } from "../src/tls.mjs";
import { maskSensitive } from "../src/redact.mjs";

const APP_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";

async function privateDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "eb-"));
  await chmod(dir, 0o700);
  return dir;
}

test("JWT is RS256, short-lived, and verifiable", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const { token, exp } = signJwt({ privateKey: pem, appId: APP_ID, nowSec: 1_700_000_000 });
  const [header, body, sig] = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${body}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(sig, "base64url")), true);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    typ: "JWT", alg: "RS256", kid: APP_ID,
  });
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.iss, "enablebanking.com");
  assert.equal(claims.aud, "api.enablebanking.com");
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(exp, claims.exp);
});

test("masks IBANs and JWTs and leaves amounts alone", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhcGkifQ.signaturevalue";
  const text = `pay FI17 3763 1867 6134 65 and FI1737631867613465 token ${jwt} balance 1000000.50`;
  const masked = maskSensitive(text);
  assert.equal(masked.includes("376318676134"), false);
  assert.equal(masked.includes("FI17 3763"), false);
  assert.equal(masked.includes("eyJhbGci"), false);
  assert.match(masked, /1000000\.50/);
  assert.match(masked, /FI••3465/);
});

test("consent requests balances and transactions only", () => {
  const body = consentBody({
    aspsp: { name: "Mock ASPSP", country: "FI" },
    state: "abc",
    redirectUrl: "http://127.0.0.1:8787/callback",
    validUntil: "2026-10-15T00:00:00.000000+00:00",
    psuType: "personal",
  });
  assert.equal(body.access.balances, true);
  assert.equal(body.access.transactions, true);
  assert.equal(JSON.stringify(body).includes("payment"), false);
  assert.throws(() => assertAllowed("POST", "/payments"), /Blocked/);
  assert.throws(() => psuHeaders(["Psu-Ip-Address\r\nX"], {}), /will not send/);
  assert.throws(() => assertAllowed("GET", "/accounts/not-a-uuid/balances"), /Blocked/);
  assert.throws(() => assertAllowed("GET", `/payments/${APP_ID}`), /Blocked/);
  assert.throws(() => assertAllowed("POST", `/payments/${APP_ID}/submit`), /Blocked/);
  assert.throws(() => assertAllowed("GET", `/accounts/${APP_ID}/transactions/../payments`), /Blocked/);
  assert.doesNotThrow(() => assertAllowed("GET", `/accounts/${APP_ID}/balances`));
  assert.doesNotThrow(() => assertAllowed("GET", `/accounts/${APP_ID}/details`));
  assert.doesNotThrow(() => assertAllowed("GET", `/accounts/${APP_ID}/transactions/5561990681`));
});

test("a mismatched bank redirect does not reveal the login code", () => {
  const code = "super-secret-code";
  const wrong = readCallbackQuery(`/callback?code=${code}&state=other`, "expected");
  assert.equal(wrong.code, undefined);
  assert.equal(wrong.body.includes(code), false);
  assert.equal(wrong.body.includes("other"), false);
  const right = readCallbackQuery(`/callback?code=${code}&state=expected`, "expected");
  assert.equal(right.code, code);
  assert.equal(right.body.includes(code), false);
});

test("saved accounts keep the last four IBAN characters", () => {
  const saved = rememberAccount({
    uid: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
    name: "Ada",
    currency: "EUR",
    cash_account_type: "CACC",
    account_id: { iban: "FI17 3763 1867 6134 65" },
  }, 1);
  assert.equal(JSON.stringify(saved).includes("FI1737631867613465"), false);
  assert.equal(saved.ibanLast4, "3465");
  assert.equal(saved.uid, "497f6eca-6276-4993-bfeb-53cbbbba6f08");
  const tx = projectTransaction({
    transaction_amount: { amount: "12.00", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-10-01",
    creditor: { name: "Cafe" },
    remittance_information: ["rent", "FI1737631867613465"],
  });
  assert.equal(JSON.stringify(tx).includes("FI1737631867613465"), false);
  assert.equal(tx.amount, "12.00");
  assert.equal(tx.id, undefined);

  const detailed = projectTransaction({
    transaction_id: "5561990681",
    transaction_amount: { amount: "9.00", currency: "EUR" },
    credit_debit_indicator: "CRDT",
    status: "BOOK",
    creditor_account: { iban: "FI1737631867613465" },
    debtor_account: { iban: "FI8821291587733472" },
    exchange_rate: { exchange_rate: "1.08", unit_currency: "USD", instructed_amount: { amount: "10.00", currency: "USD" } },
    note: "see FI1737631867613465",
  });
  assert.equal(detailed.id, "5561990681");
  assert.equal(JSON.stringify(detailed).includes("FI1737631867613465"), false);
  assert.equal(detailed.counterpartyAccount.id.endsWith("3472"), true);
  assert.equal(detailed.exchangeRate.rate, "1.08");
  const coded = projectTransaction({
    transaction_amount: { amount: "1.00", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    bank_transaction_code: { code: "EXCHANGE" },
  });
  assert.equal(coded.category, "EXCHANGE");
  assert.throws(() => assertTransactionId("../payments"), /transaction id/);

  const details = projectAccountDetails({
    name: "Ada",
    currency: "EUR",
    cash_account_type: "CACC",
    usage: "PRIV",
    psu_status: "Account Holder",
    legal_age: true,
    credit_limit: { amount: "500.00", currency: "EUR" },
    account_id: { iban: "FI1737631867613465", other: { identification: "REVOUS31214401601000", scheme_name: "OTHI" } },
    all_account_ids: [{ identification: "73ae9b2b-8981-4801-8ae2-a026ceca28ee", scheme_name: "OTHI" }],
    account_servicer: { name: "Revolut", bic_fi: "REVOLT21" },
    postal_address: { town_name: "Brussels", country: "BE", address_line: ["IBAN FI1737631867613465"] },
  });
  assert.equal(JSON.stringify(details).includes("FI1737631867613465"), false);
  assert.equal(JSON.stringify(details).includes("REVOUS31214401601000"), false);
  assert.equal(JSON.stringify(details).includes("73ae9b2b-8981-4801-8ae2-a026ceca28ee"), false);
  assert.equal(details.creditLimit.amount, "500.00");
  assert.equal(details.servicer.bic, "REVOLT21");
  assert.equal(details.address.town_name, "Brussels");
  assert.equal(details.legalAge, true);
});

test("redirect URL is loopback only", () => {
  assert.equal(parseRedirect("http://127.0.0.1:8787/callback").tls, false);
  const httpsRedirect = parseRedirect("https://127.0.0.1:8787/callback");
  assert.equal(httpsRedirect.tls, true);
  assert.equal(httpsRedirect.redirectUrl, "https://127.0.0.1:8787/callback");
  assert.throws(() => parseRedirect("https://example.com/callback"), ConfigError);
  assert.throws(() => parseRedirect("https://localhost:8787/callback"), ConfigError);
  assert.throws(() => parseRedirect("http://localhost:8787/callback"), ConfigError);
  assert.throws(() => parseRedirect("http://127.0.0.1:8787/callback?x=1"), ConfigError);
});

test("config.env cannot enable production by itself", () => {
  assert.throws(
    () => parseEnvFile("ENABLEBANKING_ALLOW_PRODUCTION=1\n"),
    /Remove ENABLEBANKING_ALLOW_PRODUCTION/,
  );
});

test("loadConfig refuses a world-readable key, a key inside the checkout, and production", async () => {
  const repo = await privateDir();
  const home = await privateDir();
  try {
    await writeFile(path.join(repo, ".git"), "gitdir: /tmp/example\n");
    const inside = path.join(repo, "app.pem");
    await writeFile(inside, PEM, { mode: 0o600 });
    await chmod(inside, 0o600);
    const insideEnv = path.join(repo, "config.env");
    await writeFile(insideEnv, `ENABLEBANKING_APP_ID=${APP_ID}\nENABLEBANKING_KEY_PATH=${inside}\nENABLEBANKING_ENVIRONMENT=sandbox\n`, { mode: 0o600 });
    await chmod(insideEnv, 0o600);
    await assert.rejects(
      loadConfig({ configDir: repo, env: {}, repoRoot: repo }),
      /inside the git checkout/,
    );

    const keyDir = path.join(home, "keys");
    await mkdir(keyDir, { mode: 0o700 });
    await chmod(keyDir, 0o700);
    const key = path.join(keyDir, "app.pem");
    await writeFile(key, PEM, { mode: 0o644 });
    await chmod(key, 0o644);
    const envFile = path.join(home, "config.env");
    await writeFile(envFile, `ENABLEBANKING_APP_ID=${APP_ID}\nENABLEBANKING_KEY_PATH=${key}\nENABLEBANKING_ENVIRONMENT=sandbox\n`, { mode: 0o600 });
    await chmod(envFile, 0o600);
    await assert.rejects(loadConfig({ configDir: home, env: {}, repoRoot: repo }), /chmod 600/);

    await chmod(key, 0o600);
    const loaded = await loadConfig({ configDir: home, env: {}, repoRoot: repo });
    assert.equal(loaded.environment, "sandbox");
    assert.equal(loaded.appId, APP_ID);
    assert.equal(loaded.allowProduction, false);

    await chmod(key, 0o600);
    await writeFile(envFile, `ENABLEBANKING_APP_ID=${APP_ID}\nENABLEBANKING_KEY_PATH=${key}\nENABLEBANKING_ENVIRONMENT=production\n`, { mode: 0o600 });
    await assert.rejects(
      loadConfig({ configDir: home, env: {}, repoRoot: repo }),
      /ENABLEBANKING_ALLOW_PRODUCTION=1/,
    );

    const link = path.join(keyDir, "link.pem");
    await symlink(key, link);
    await writeFile(envFile, `ENABLEBANKING_APP_ID=${APP_ID}\nENABLEBANKING_KEY_PATH=${link}\nENABLEBANKING_ENVIRONMENT=sandbox\n`, { mode: 0o600 });
    await assert.rejects(loadConfig({ configDir: home, env: {}, repoRoot: repo }), /symlink/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("init moves the key out of Downloads and does not return key material", async () => {
  const repo = await privateDir();
  const downloads = await privateDir();
  const configDir = await privateDir();
  try {
    await writeFile(path.join(repo, ".git"), "gitdir: /tmp/example\n");
    const leaked = path.join(repo, "app.pem");
    await writeFile(leaked, PEM, { mode: 0o600 });
    await assert.rejects(init({ appId: APP_ID, keyPath: leaked, configDir, repoRoot: repo }), /git checkout/);
    assert.equal((await lstat(leaked)).isFile(), true);

    const source = path.join(downloads, `${APP_ID}.pem`);
    await writeFile(source, PEM, { mode: 0o644 });
    await chmod(source, 0o644);
    const saved = await init({ appId: APP_ID, keyPath: source, configDir, repoRoot: repo });
    assert.equal(JSON.stringify(saved).includes("BEGIN PRIVATE KEY"), false);
    assert.equal((await lstat(saved.keyPath)).mode & 0o777, 0o600);
    await assert.rejects(lstat(source), (err) => err.code === "ENOENT");
    assert.equal((await lstat(path.join(configDir, "config.env"))).mode & 0o777, 0o600);
    const loaded = await loadConfig({ configDir, env: {}, repoRoot: repo });
    assert.equal(loaded.keyPath, await realpath(saved.keyPath));
    assert.equal(loaded.environment, "sandbox");
    assert.equal(loaded.tls, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("production init uses the https callback and leaves the sandbox directory alone", async () => {
  const repo = await privateDir();
  const downloads = await privateDir();
  const sandbox = await privateDir();
  const prod = await privateDir();
  try {
    await writeFile(path.join(repo, ".git"), "gitdir: /tmp/example\n");
    const source = path.join(downloads, `${APP_ID}.pem`);
    await writeFile(source, PEM, { mode: 0o644 });
    await chmod(source, 0o644);
    await assert.rejects(
      init({ appId: APP_ID, keyPath: source, configDir: prod, repoRoot: repo, environment: "production", allowProduction: false }),
      /ENABLEBANKING_ALLOW_PRODUCTION=1/,
    );
    assert.equal((await lstat(source)).isFile(), true);

    await assert.rejects(
      init({
        appId: APP_ID,
        keyPath: source,
        configDir: sandbox,
        sandboxDir: sandbox,
        repoRoot: repo,
        environment: "production",
        allowProduction: true,
      }),
      /will not write into the sandbox directory/,
    );
    assert.equal((await lstat(source)).isFile(), true);

    const saved = await init({
      appId: APP_ID,
      keyPath: source,
      configDir: prod,
      sandboxDir: sandbox,
      repoRoot: repo,
      environment: "production",
      allowProduction: true,
    });
    assert.equal(saved.environment, "production");
    assert.equal(saved.redirectUrl, "https://127.0.0.1:8787/callback");
    assert.equal(JSON.stringify(saved).includes("BEGIN PRIVATE KEY"), false);
    const text = await readFile(path.join(prod, "config.env"), "utf8");
    assert.match(text, /ENABLEBANKING_ENVIRONMENT=production/);
    assert.match(text, /ENABLEBANKING_REDIRECT_URL=https:\/\/127\.0\.0\.1:8787\/callback/);
    assert.equal(text.includes("ALLOW_PRODUCTION"), false);
    const loaded = await loadConfig({
      configDir: prod,
      env: { ENABLEBANKING_ALLOW_PRODUCTION: "1" },
      repoRoot: repo,
    });
    assert.equal(loaded.environment, "production");
    assert.equal(loaded.tls, true);
    assert.equal(loaded.allowProduction, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
    await rm(prod, { recursive: true, force: true });
  }
});

test("the local callback stays on loopback and hides the login code", async () => {
  const port = 25000 + Math.floor(Math.random() * 10000);
  const waiter = waitForCallback({ port, expectedState: "expected-state", timeoutMs: 5000 });
  try {
    await waiter.ready;
    const wrong = await fetch(`http://127.0.0.1:${port}/callback?code=super-secret-code&state=nope`);
    const wrongBody = await wrong.text();
    assert.equal(wrong.status, 400);
    assert.equal(wrongBody.includes("super-secret-code"), false);
    const right = await fetch(`http://127.0.0.1:${port}/callback?code=super-secret-code&state=expected-state`);
    const rightBody = await right.text();
    const got = await waiter.done;
    assert.equal(got.code, "super-secret-code");
    assert.equal(rightBody.includes("super-secret-code"), false);
    assert.match(rightBody, /Link complete/);
  } finally {
    await waiter.close();
  }
});

function httpsGet(port, requestPath, ca) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: "127.0.0.1", port, path: requestPath, ca, rejectUnauthorized: true }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
  });
}

test("the HTTPS callback is trusted only with its own CA", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eb-tls-"));
  const port = 26000 + Math.floor(Math.random() * 10000);
  let waiter;
  try {
    await ensureCallbackTls(dir);
    const tls = await loadCallbackTls(dir);
    waiter = waitForCallback({ port, expectedState: "expected-state", timeoutMs: 5000, tls });
    await waiter.ready;
    await assert.rejects(httpsGet(port, "/callback?code=secret&state=expected-state"));
    const wrong = await httpsGet(port, "/callback?code=super-secret-code&state=nope", tls.ca);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.includes("super-secret-code"), false);
    const right = await httpsGet(port, "/callback?code=super-secret-code&state=expected-state", tls.ca);
    const got = await waiter.done;
    assert.equal(got.code, "super-secret-code");
    assert.equal(right.body.includes("super-secret-code"), false);
  } finally {
    await waiter?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("API client follows the allowlist and does not follow redirects", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  let seen;
  const client = createClient({
    appId: APP_ID,
    privateKey: pem,
    fetchImpl: async (url, options) => {
      seen = options;
      return { ok: true, async text() { return JSON.stringify({ name: "PoC" }); } };
    },
  });
  await client.application();
  assert.equal(seen.redirect, "error");
  assert.match(seen.headers.Authorization, /^Bearer eyJ/);
  assert.equal(JSON.stringify(seen.headers).includes("BEGIN PRIVATE KEY"), false);

  const failing = createClient({
    appId: APP_ID,
    privateKey: pem,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ message: "bad eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhcGkifQ.signaturevalue", error: "NOT_A_CODE!" });
      },
    }),
  });
  await assert.rejects(failing.application(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message.includes("eyJhbGci"), false);
    assert.equal(err.message.includes("NOT_A_CODE"), false);
    return true;
  });
});
