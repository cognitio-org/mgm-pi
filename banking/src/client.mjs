import { signJwt } from "./jwt.mjs";
import { clip } from "./redact.mjs";

const ORIGIN = "https://api.enablebanking.com";

// Account information only. Payment routes are rejected before any network call.
const ALLOWED = [
  ["GET", /^\/application$/],
  ["GET", /^\/aspsps$/],
  ["POST", /^\/auth$/],
  ["POST", /^\/sessions$/],
  ["GET", /^\/sessions\/[0-9a-f-]{36}$/i],
  ["GET", /^\/accounts\/[0-9a-f-]{36}\/balances$/i],
  ["GET", /^\/accounts\/[0-9a-f-]{36}\/details$/i],
  ["GET", /^\/accounts\/[0-9a-f-]{36}\/transactions$/i],
  ["GET", /^\/accounts\/[0-9a-f-]{36}\/transactions\/[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/],
];

export function assertAllowed(method, pathname) {
  const ok = ALLOWED.some(([verb, pattern]) => verb === method && pattern.test(pathname));
  if (!ok) throw new Error(`Blocked Enable Banking request ${method} ${pathname}.`);
}

export class ApiError extends Error {
  constructor(status, body) {
    const code = body && typeof body.error === "string" && /^[A-Z0-9_]{1,64}$/.test(body.error) ? body.error : "";
    const message = clip(body && typeof body.message === "string" ? body.message : `Enable Banking returned HTTP ${status}`);
    const detail = body && typeof body.detail === "string" ? clip(body.detail) : "";
    const extra = [code, detail].filter(Boolean).join(": ");
    super(extra ? `${message} (${extra})` : message);
    this.status = status;
    this.errorCode = code;
  }
}

export function createClient({ appId, privateKey, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  let cached = null;

  function bearer() {
    const nowSec = Math.floor(now().getTime() / 1000);
    if (!cached || cached.exp - nowSec < 30) cached = signJwt({ privateKey, appId, nowSec });
    return cached.token;
  }

  async function request(method, pathname, { query, body, psu } = {}) {
    assertAllowed(method, pathname);
    const url = new URL(pathname, ORIGIN);
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = {
      Authorization: `Bearer ${bearer()}`,
      Accept: "application/json",
      "User-Agent": "enablebanking-local-poc/0.1",
    };
    for (const [key, value] of Object.entries(psu || {})) {
      if (key.toLowerCase() === "authorization") throw new Error("Refusing to override Authorization.");
      headers[key] = value;
    }
    if (body) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new Error("Enable Banking did not respond within 30 seconds.");
      }
      throw new Error("Could not reach api.enablebanking.com.");
    }

    const text = await res.text();
    if (text.length > 2_000_000) throw new Error("Enable Banking response was larger than 2 MB.");
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) throw new ApiError(res.status, parsed);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Enable Banking returned an unexpected response for ${method} ${pathname}.`);
    }
    return parsed;
  }

  return {
    application: () => request("GET", "/application"),
    aspsps: (country) => request("GET", "/aspsps", { query: { country } }),
    startAuth: (payload, psu) => request("POST", "/auth", { body: payload, psu }),
    createSession: (code, psu) => request("POST", "/sessions", { body: { code }, psu }),
    getSession: (sessionId, psu) => request("GET", `/sessions/${sessionId}`, { psu }),
    balances: (accountId, psu) => request("GET", `/accounts/${accountId}/balances`, { psu }),
    accountDetails: (accountId, psu) => request("GET", `/accounts/${accountId}/details`, { psu }),
    transactions: (accountId, query, psu) => request("GET", `/accounts/${accountId}/transactions`, { query, psu }),
    transaction: (accountId, transactionId, psu) => request("GET", `/accounts/${accountId}/transactions/${transactionId}`, { psu }),
  };
}
