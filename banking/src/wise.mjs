// Read-only Wise client for one person on this Mac.
// Payment, recipient, quote, and profile-creation routes are rejected before any network call.
// The app credential is projects/97916961297/secrets/kernal_wise_key, read into memory only.
// A raw API key is sent as a bearer token. OAuth client JSON still uses the browser link.
// WISE_API_TOKEN and WISE_PERSONAL_TOKEN are refused so a pasted token never becomes the credential.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readCallbackQuery } from "./banking.mjs";
import { waitForCallback } from "./link.mjs";
import { clip } from "./redact.mjs";
import { readPrivateJson, removePrivate, writePrivate } from "./store.mjs";

const execFileAsync = promisify(execFile);

export const API_GENERATION = "2026Q4";
export const SANDBOX_ORIGIN = "https://api.wise-sandbox.com";
export const PRODUCTION_ORIGIN = "https://api.wise.com";
export const SANDBOX_AUTHORIZE = "https://wise-sandbox.com/oauth/authorize/";
export const PRODUCTION_AUTHORIZE = "https://wise.com/oauth/authorize/";
export const REDIRECT_URI = "http://127.0.0.1:8788/callback";
export const CALLBACK_PORT = 8788;

const DIGITS = /^[0-9]{1,20}$/;
const ALLOWED = [
  ["POST", /^\/oauth\/token$/],
  ["GET", /^\/profiles$/],
  ["GET", /^\/profiles\/[0-9]{1,20}$/],
  ["GET", /^\/profiles\/[0-9]{1,20}\/balances$/],
  ["GET", /^\/profiles\/[0-9]{1,20}\/balance-statements\/[0-9]{1,20}\/statement\.json$/],
];

export class WiseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function assertWisePath(method, pathname) {
  const ok = ALLOWED.some(([verb, pattern]) => verb === method && pattern.test(pathname));
  if (!ok) throw new WiseError("BLOCKED", `Blocked Wise request ${method} ${pathname}.`);
}

export function assertTokenGrant(form) {
  const params = form instanceof URLSearchParams ? form : new URLSearchParams(form);
  const grant = params.get("grant_type");
  if (grant !== "authorization_code" && grant !== "refresh_token") {
    throw new WiseError("BLOCKED", "Wise token grant is not allowed.");
  }
  if ([...params.keys()].some((key) => key === "client_secret")) {
    throw new WiseError("BLOCKED", "The Wise client secret is not sent in the token body.");
  }
  return params;
}

export function parseAppSecret(text) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new WiseError("NOT_CONFIGURED", "kernal_wise_key is empty.");
  if (!trimmed.startsWith("{")) {
    if (trimmed.length < 20 || /[\s]/.test(trimmed)) {
      throw new WiseError("NOT_CONFIGURED", "kernal_wise_key is not a Wise API key or a client id and secret.");
    }
    return { kind: "key", token: trimmed };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WiseError("NOT_CONFIGURED", "kernal_wise_key is not a Wise API key or a client id and secret.");
  }
  const clientId = parsed.client_id;
  const clientSecret = parsed.client_secret;
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || !clientId || !clientSecret) {
    const keys = Object.keys(parsed).join(", ") || "none";
    throw new WiseError(
      "NOT_CONFIGURED",
      `kernal_wise_key does not contain client_id and client_secret (keys: ${keys}). This provider stops rather than guessing another secret.`,
    );
  }
  if (/[\r\n:]/.test(clientId) || /[\r\n]/.test(clientSecret)) {
    throw new WiseError("NOT_CONFIGURED", "kernal_wise_key has a client id or secret this client will not send.");
  }
  return { kind: "oauth", clientId, clientSecret };
}

export function environmentOf(env) {
  return env.WISE_ALLOW_PRODUCTION === "1" ? "production" : "sandbox";
}

export function originFor(env) {
  return environmentOf(env) === "production" ? PRODUCTION_ORIGIN : SANDBOX_ORIGIN;
}

export function authorizeUrlFor(env) {
  return environmentOf(env) === "production" ? PRODUCTION_AUTHORIZE : SANDBOX_AUTHORIZE;
}

function storeRoot(env) {
  return env.WISE_CONFIG_DIR || path.join(homedir(), ".config", "finance", "wise");
}

export function configDir(env) {
  return path.join(storeRoot(env), environmentOf(env));
}

function keyDir(env) {
  return path.join(storeRoot(env), "key");
}

function kindOf(credentials) {
  if (credentials?.kind === "key") {
    if (typeof credentials.token !== "string" || credentials.token.length < 20 || /[\s]/.test(credentials.token)) {
      throw new WiseError("NOT_CONFIGURED", "kernal_wise_key is not a Wise API key.");
    }
    return "key";
  }
  if (credentials?.kind === "oauth" || (credentials?.clientId && credentials?.clientSecret)) {
    return "oauth";
  }
  throw new WiseError("NOT_CONFIGURED", "kernal_wise_key is not a Wise API key or a client id and secret.");
}

export async function loadAppCredentials(env, exec = execFileAsync) {
  if (env.WISE_API_TOKEN || env.WISE_PERSONAL_TOKEN) {
    throw new WiseError("NOT_CONFIGURED", "A personal Wise token is the wrong credential. This provider stops.");
  }
  if (env.WISE_CLIENT_ID || env.WISE_CLIENT_SECRET) {
    if (!env.WISE_CLIENT_ID || !env.WISE_CLIENT_SECRET) {
      throw new WiseError("NOT_CONFIGURED", "Set both WISE_CLIENT_ID and WISE_CLIENT_SECRET, or neither.");
    }
    return parseAppSecret(JSON.stringify({
      client_id: env.WISE_CLIENT_ID,
      client_secret: env.WISE_CLIENT_SECRET,
    }));
  }
  let stdout = "";
  try {
    const result = await exec("gcloud", [
      "--configuration=outfitter",
      "secrets", "versions", "access", "latest",
      "--secret=kernal_wise_key",
      "--project=outfitter-509211",
    ], { timeout: 20_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    stdout = result.stdout;
  } catch (err) {
    const detail = clip(err?.stderr || err?.message || "gcloud failed");
    throw new WiseError("NOT_CONFIGURED", `Could not read kernal_wise_key (${detail}).`);
  }
  return parseAppSecret(stdout);
}

function tokensPath(dir) {
  return path.join(dir, "tokens.json");
}

function connectionPath(dir) {
  return path.join(dir, "connection.json");
}

function expiry(absolute, seconds, now) {
  if (typeof absolute === "string" && !Number.isNaN(Date.parse(absolute))) return absolute;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }
  return null;
}

async function withTokenLock(dir, fn) {
  const lock = path.join(dir, "tokens.lock");
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try {
        return await fn();
      } finally {
        await handle.close();
        await unlink(lock).catch(() => {});
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - started > 10_000) {
        throw new WiseError("PROVIDER_ERROR", "Another Wise token refresh is still running.");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function createWiseClient({ origin, fetchImpl = globalThis.fetch, onSca }) {
  async function request(method, pathname, { query, form, basic, bearer, retry = true } = {}) {
    assertWisePath(method, pathname);
    if (form != null) assertTokenGrant(form);
    const url = new URL(`${API_GENERATION}${pathname}`, origin.endsWith("/") ? origin : `${origin}/`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = {
      Accept: "application/json",
      "User-Agent": "wise-local-poc/0.1",
      "X-External-Correlation-Id": randomUUID(),
    };
    if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.clientId}:${basic.clientSecret}`).toString("base64")}`;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (form != null) headers["Content-Type"] = "application/x-www-form-urlencoded";

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: form == null ? undefined : (form instanceof URLSearchParams ? form : new URLSearchParams(form)).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const message = String(err?.message || "");
      if (/certificate|mtls|tls/i.test(message)) {
        throw new WiseError("NOT_CONFIGURED", "Wise asked for a client certificate. This provider stops.");
      }
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new WiseError("PROVIDER_ERROR", "Wise did not respond within 30 seconds.");
      }
      throw new WiseError("PROVIDER_ERROR", "Could not reach Wise.");
    }

    if (res.status === 429 && retry) {
      const wait = Number(res.headers.get("retry-after"));
      if (Number.isFinite(wait) && wait >= 0 && wait <= 5) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return request(method, pathname, { query, form, basic, bearer, retry: false });
      }
      throw new WiseError("RATE_LIMIT", "Wise rate-limited this request.");
    }

    const approval = res.headers.get("x-2fa-approval-result");
    if (res.status === 403 && approval === "REJECTED" && res.headers.get("x-2fa-approval")) {
      if (onSca) await onSca();
      throw new WiseError(
        "SCA_REQUIRED",
        "Wise needs an in-app approval before another statement. Balances are unchanged. This tool does not run that challenge.",
      );
    }

    const text = await res.text();
    if (text.length > 2_000_000) throw new WiseError("PROVIDER_ERROR", "Wise response was larger than 2 MB.");
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (res.status < 200 || res.status >= 300) {
      if (body && body.error === "invalid_grant") {
        throw new WiseError("REAUTH_REQUIRED", "Wise login expired. Run: node src/wise-cli.mjs link");
      }
      throw new WiseError("PROVIDER_ERROR", clip(body?.error_description || body?.message || body?.error || `Wise returned HTTP ${res.status}`));
    }
    return body;
  }

  return { request };
}

function projectProfile(row) {
  const id = String(row?.id ?? "");
  const type = row?.type;
  if (!DIGITS.test(id) || (type !== "PERSONAL" && type !== "BUSINESS")) {
    throw new WiseError("PROVIDER_DATA", "Wise profile was missing an id or a known type.");
  }
  return { id, type };
}

function decimal(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  if (value && typeof value === "object" && "value" in value) return decimal(value.value);
  throw new WiseError("PROVIDER_DATA", "Wise amount was not a decimal.");
}

function projectBalance(row, index) {
  const id = String(row?.id ?? "");
  if (!DIGITS.test(id)) throw new WiseError("PROVIDER_DATA", "Wise balance was missing an id.");
  const currency = typeof row.currency === "string" ? row.currency : row.amount?.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new WiseError("PROVIDER_DATA", "Wise balance was missing a currency.");
  }
  return {
    index,
    id,
    currency,
    type: row.type === "SAVINGS" ? "SAVINGS" : "STANDARD",
    amount: decimal(row.amount),
  };
}

function projectStatement(body) {
  const rows = Array.isArray(body?.transactions) ? body.transactions : null;
  if (!rows) throw new WiseError("PROVIDER_DATA", "Wise statement did not include transactions.");
  return rows.slice(0, 40).map((row) => ({
    date: typeof row.date === "string" ? row.date.slice(0, 40) : null,
    type: typeof row.type === "string" ? row.type.slice(0, 40) : null,
    amount: row.amount == null ? null : decimal(row.amount),
    currency: typeof row.currency === "string" ? row.currency : row.amount?.currency || null,
    description: clip(row.details?.description || row.description || ""),
    reference: clip(row.details?.paymentReference || row.referenceNumber || ""),
  }));
}

async function markSca(dir, now) {
  const current = await readPrivateJson(connectionPath(dir), "Wise connection") || {};
  current.sca = { status: "required", action: "BALANCE__GET_STATEMENT", since: now.toISOString() };
  await saveConnection(dir, current);
}

async function clearTokens(dir) {
  await removePrivate(tokensPath(dir));
}

async function saveConnection(dir, value) {
  const stored = { ...value };
  for (const key of ["token", "access_token", "refresh_token", "client_secret", "clientSecret"]) {
    delete stored[key];
  }
  await writePrivate(connectionPath(dir), `${JSON.stringify(stored)}\n`);
}

async function fetchProfiles(client, accessToken) {
  const rows = await client.request("GET", "/profiles", { bearer: accessToken });
  if (!Array.isArray(rows)) throw new WiseError("PROVIDER_DATA", "Wise profiles response was not a list.");
  return rows.map(projectProfile);
}

async function fetchBalances(client, accessToken, profileId) {
  const rows = await client.request("GET", `/profiles/${profileId}/balances`, {
    bearer: accessToken,
    query: { types: "STANDARD,SAVINGS" },
  });
  if (!Array.isArray(rows)) throw new WiseError("PROVIDER_DATA", "Wise balances response was not a list.");
  return rows;
}

async function authorizedClient(env, deps) {
  const credentials = await (deps.loadCredentials || loadAppCredentials)(env);
  const now = deps.now ? deps.now() : new Date();
  if (kindOf(credentials) === "key") {
    const dir = keyDir(env);
    const connection = await readPrivateJson(connectionPath(dir), "Wise connection") || {};
    const client = createWiseClient({
      origin: PRODUCTION_ORIGIN,
      fetchImpl: deps.fetchImpl,
      onSca: () => markSca(dir, now),
    });
    return { mode: "key", client, dir, connection, accessToken: credentials.token };
  }
  const dir = configDir(env);
  const tokens = await readPrivateJson(tokensPath(dir), "Wise tokens");
  const connection = await readPrivateJson(connectionPath(dir), "Wise connection");
  if (!tokens?.refresh_token || !connection?.profileId) {
    throw new WiseError("NOT_LINKED", "No Wise account is linked. Run: node src/wise-cli.mjs link");
  }
  if (tokens.refresh_token_expires_at && Date.parse(tokens.refresh_token_expires_at) <= now.getTime()) {
    await clearTokens(dir);
    throw new WiseError("REAUTH_REQUIRED", "Wise login expired. Run: node src/wise-cli.mjs link");
  }
  const client = createWiseClient({
    origin: originFor(env),
    fetchImpl: deps.fetchImpl,
    onSca: () => markSca(dir, now),
  });

  const due = !tokens.expires_at || !tokens.access_token
    || Date.parse(tokens.expires_at) - now.getTime() < 6 * 60 * 60 * 1000;
  if (!due) return { mode: "oauth", client, dir, connection, accessToken: tokens.access_token };

  try {
    const refreshed = await withTokenLock(dir, async () => {
      const latest = await readPrivateJson(tokensPath(dir), "Wise tokens");
      const stillDue = !latest?.expires_at || !latest.access_token
        || Date.parse(latest.expires_at) - now.getTime() < 6 * 60 * 60 * 1000;
      if (latest?.access_token && !stillDue) return latest.access_token;
      let body;
      try {
        body = await client.request("POST", "/oauth/token", {
          basic: credentials,
          form: { grant_type: "refresh_token", refresh_token: latest?.refresh_token || tokens.refresh_token },
        });
      } catch (err) {
        if (err instanceof WiseError && err.code === "REAUTH_REQUIRED") await clearTokens(dir);
        throw err;
      }
      await storeTokens(dir, body, now);
      return body.access_token;
    });
    return { mode: "oauth", client, dir, connection, accessToken: refreshed };
  } catch (err) {
    if (err instanceof WiseError && err.code === "REAUTH_REQUIRED") await clearTokens(dir);
    throw err;
  }
}

async function storeTokens(dir, body, now) {
  if (typeof body?.access_token !== "string" || typeof body?.refresh_token !== "string") {
    throw new WiseError("PROVIDER_DATA", "Wise token response did not include an access token and a refresh token.");
  }
  const expiresAt = expiry(body.expires_at, body.expires_in, now) || new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  await writePrivate(tokensPath(dir), `${JSON.stringify({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: expiresAt,
    refresh_token_expires_at: expiry(body.refresh_token_expires_at, body.refresh_token_expires_in, now),
  })}\n`);
}

export async function wiseStatus(env = process.env, deps = {}) {
  let credential = "unavailable";
  let detail = null;
  try {
    credential = kindOf(await (deps.loadCredentials || loadAppCredentials)(env));
  } catch (err) {
    if (!(err instanceof WiseError) || err.code !== "NOT_CONFIGURED") throw err;
    detail = err.message;
  }
  const dir = credential === "key" ? keyDir(env) : configDir(env);
  const connection = await readPrivateJson(connectionPath(dir), "Wise connection");
  const tokens = credential === "key" ? null : await readPrivateJson(tokensPath(dir), "Wise tokens");
  const profiles = Array.isArray(connection?.profiles) ? connection.profiles : [];
  const balances = Array.isArray(connection?.balances) ? connection.balances : [];
  const only = profiles.length === 1 ? profiles[0] : null;
  const status = {
    credential,
    environment: credential === "key" ? "production" : environmentOf(env),
    linked: credential === "key"
      ? profiles.length > 0 || balances.length > 0
      : Boolean(tokens?.refresh_token && connection?.profileId),
    profileId: credential === "key" ? (only?.id || null) : (connection?.profileId || null),
    profileType: credential === "key" ? (only?.type || null) : (connection?.profileType || null),
    balances: balances.length,
    sca: connection?.sca?.status || null,
  };
  if (detail) status.detail = detail;
  return status;
}

export async function wiseProfiles(env = process.env, deps = {}) {
  const session = await authorizedClient(env, deps);
  const profiles = await fetchProfiles(session.client, session.accessToken);
  if (session.mode === "key") {
    const stored = await readPrivateJson(connectionPath(session.dir), "Wise connection") || {};
    stored.mode = "key";
    stored.profiles = profiles;
    if (!stored.sca) stored.sca = { status: "current" };
    await saveConnection(session.dir, stored);
    return { profiles };
  }
  const match = profiles.find((row) => row.id === String(session.connection.profileId));
  if (!match) throw new WiseError("PROVIDER_DATA", "The linked Wise profile was not in the profile list.");
  return { profiles: [match] };
}

export async function wiseBalances(env = process.env, deps = {}) {
  const session = await authorizedClient(env, deps);
  if (session.mode === "key") {
    const profiles = await fetchProfiles(session.client, session.accessToken);
    const balances = [];
    for (const profile of profiles) {
      const rows = await fetchBalances(session.client, session.accessToken, profile.id);
      for (const row of rows) {
        balances.push({ ...projectBalance(row, balances.length + 1), profileId: profile.id });
      }
    }
    const stored = await readPrivateJson(connectionPath(session.dir), "Wise connection") || {};
    stored.mode = "key";
    stored.profiles = profiles;
    stored.balances = balances.map(({ index, id, currency, type, profileId }) => ({ index, id, currency, type, profileId }));
    if (!stored.sca) stored.sca = { status: "current" };
    await saveConnection(session.dir, stored);
    return { balances: publicBalances(balances) };
  }
  const { client, dir, connection, accessToken } = session;
  const rows = await fetchBalances(client, accessToken, connection.profileId);
  const balances = rows.map((row, i) => projectBalance(row, i + 1));
  const stored = await readPrivateJson(connectionPath(dir), "Wise connection") || connection;
  stored.balances = balances.map(({ index, id, currency, type }) => ({ index, id, currency, type }));
  if (!stored.sca) stored.sca = { status: "current" };
  await saveConnection(dir, stored);
  return { balances: publicBalances(balances) };
}

function publicBalances(balances) {
  return balances.map(({ index, currency, type, amount }) => ({ index, currency, type, amount }));
}

export async function wiseStatement(env = process.env, balanceIndex, days, deps = {}) {
  const which = whole(balanceIndex, 1, 1, 30, "balance");
  const span = whole(days, 30, 1, 90, "days");
  const { client, connection, accessToken } = await authorizedClient(env, deps);
  const balance = (connection.balances || []).find((row) => row.index === which);
  if (!balance) throw new WiseError("NOT_LINKED", "That balance index is not in the last Wise balance list. Run balances first.");
  const profileId = balance.profileId || connection.profileId;
  if (!DIGITS.test(String(profileId || ""))) {
    throw new WiseError("NOT_LINKED", "That balance has no Wise profile. Run balances again.");
  }
  const now = deps.now ? deps.now() : new Date();
  const intervalEnd = now.toISOString();
  const intervalStart = new Date(now.getTime() - span * 24 * 60 * 60 * 1000).toISOString();
  const body = await client.request(
    "GET",
    `/profiles/${profileId}/balance-statements/${balance.id}/statement.json`,
    {
      bearer: accessToken,
      query: { currency: balance.currency, intervalStart, intervalEnd, type: "COMPACT" },
    },
  );
  return { balance: which, currency: balance.currency, transactions: projectStatement(body) };
}

export async function completeWiseLink({ code, profileId, env = process.env, fetchImpl, loadCredentials, now = () => new Date() }) {
  if (!DIGITS.test(String(profileId || ""))) {
    throw new WiseError("PROVIDER_DATA", "Wise did not return a numeric profile id. The login was not saved.");
  }
  const credentials = await (loadCredentials || loadAppCredentials)(env);
  if (kindOf(credentials) === "key") {
    throw new WiseError(
      "NOT_CONFIGURED",
      "kernal_wise_key is an API key, so there is nothing to link in a browser. Run: node src/wise-cli.mjs balances",
    );
  }
  const dir = configDir(env);
  const client = createWiseClient({ origin: originFor(env), fetchImpl });
  const at = now();
  const token = await client.request("POST", "/oauth/token", {
    basic: credentials,
    form: {
      grant_type: "authorization_code",
      client_id: credentials.clientId,
      code,
      redirect_uri: REDIRECT_URI,
    },
  });
  await storeTokens(dir, token, at);
  try {
    const rows = await client.request("GET", "/profiles", { bearer: token.access_token });
    const profile = (Array.isArray(rows) ? rows : []).map(projectProfile).find((row) => row.id === String(profileId));
    if (!profile) {
      throw new WiseError("PROVIDER_DATA", "Wise login did not include the profile from the redirect. Nothing was kept.");
    }
    const listed = await client.request("GET", `/profiles/${profile.id}/balances`, {
      bearer: token.access_token,
      query: { types: "STANDARD,SAVINGS" },
    });
    const balances = (Array.isArray(listed) ? listed : []).map((row, i) => projectBalance(row, i + 1));
    await saveConnection(dir, {
      profileId: profile.id,
      profileType: profile.type,
      balances: balances.map(({ index, id, currency, type }) => ({ index, id, currency, type })),
      sca: { status: "current" },
    });
    return { profileId: profile.id, profileType: profile.type, balances: balances.length };
  } catch (err) {
    await clearTokens(dir);
    throw err;
  }
}

export function readWiseCallback(requestUrl, expectedState) {
  const result = readCallbackQuery(requestUrl, expectedState);
  if (!result.code) return result;
  const url = new URL(requestUrl, "http://127.0.0.1");
  const profileId = url.searchParams.get("profileId");
  if (!DIGITS.test(profileId || "")) {
    return { status: 400, body: "Wise did not return a profile id. Close this tab and run link again.", failed: true };
  }
  return { ...result, profileId };
}

function whole(value, fallback, min, max, label) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new WiseError("PROVIDER_DATA", `${label} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

export function buildAuthorizeUrl(env, state) {
  const url = new URL(authorizeUrlFor(env));
  url.searchParams.set("client_id", "set-by-link");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url;
}

export async function linkWise({
  env = process.env,
  fetchImpl,
  loadCredentials,
  openBrowser,
  log = () => {},
  timeoutMs,
  now,
} = {}) {
  const credentials = await (loadCredentials || loadAppCredentials)(env);
  if (kindOf(credentials) === "key") {
    throw new WiseError(
      "NOT_CONFIGURED",
      "kernal_wise_key is an API key, so there is nothing to link in a browser. Run: node src/wise-cli.mjs balances",
    );
  }
  const state = randomUUID();
  const url = buildAuthorizeUrl(env, state);
  url.searchParams.set("client_id", credentials.clientId);
  const waiter = waitForCallback({
    port: CALLBACK_PORT,
    expectedState: state,
    timeoutMs,
    parse: (requestUrl) => readWiseCallback(requestUrl, state),
  });
  await waiter.ready;
  log("Opening the Wise login in your browser. This window waits five minutes.");
  if (openBrowser) openBrowser(url.toString());
  try {
    const found = await waiter.done;
    if (!found.profileId) {
      throw new WiseError("PROVIDER_DATA", "Wise did not return a profile id. Nothing was saved.");
    }
    return completeWiseLink({
      code: found.code,
      profileId: found.profileId,
      env,
      fetchImpl,
      loadCredentials: async () => credentials,
      now,
    });
  } finally {
    await waiter.close();
  }
}
