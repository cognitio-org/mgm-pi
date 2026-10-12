// Read one Secret Manager payload with the Cloud Run metadata token.
// The payload stays in memory. Errors report the HTTP status only.

import { WiseError, parseAppSecret } from "./wise.mjs";

const PROJECT = "97916961297";
const SECRET = "kernal_wise_key";
const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SECRET_URL = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET}/versions/latest:access`;

export function createGsmReader({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
} = {}) {
  let google = null;
  let secretCache = null;

  async function googleToken() {
    if (google && google.until > now() + 60_000) return google.token;
    const res = await fetchImpl(METADATA, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new WiseError("NOT_CONFIGURED", `Could not read kernal_wise_key (metadata HTTP ${res.status}).`);
    }
    const body = await readJson(res, "metadata");
    if (typeof body?.access_token !== "string" || !body.access_token) {
      throw new WiseError("NOT_CONFIGURED", "Could not read kernal_wise_key (metadata token missing).");
    }
    const expiresIn = Number(body.expires_in);
    const life = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 5 * 60 * 1000;
    google = { token: body.access_token, until: now() + life };
    return google.token;
  }

  return async function loadWiseSecret() {
    if (secretCache && secretCache.until > now()) return secretCache.value;
    const token = await googleToken();
    const res = await fetchImpl(SECRET_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new WiseError("NOT_CONFIGURED", `Could not read kernal_wise_key (Secret Manager HTTP ${res.status}).`);
    }
    const body = await readJson(res, "Secret Manager");
    const data = body?.payload?.data;
    if (typeof data !== "string" || !data) {
      throw new WiseError("NOT_CONFIGURED", "Could not read kernal_wise_key (empty payload).");
    }
    const value = parseAppSecret(Buffer.from(data, "base64").toString("utf8"));
    secretCache = { value, until: now() + ttlMs };
    return value;
  };
}

async function readJson(res, label) {
  try {
    return await res.json();
  } catch {
    throw new WiseError("NOT_CONFIGURED", `Could not read kernal_wise_key (${label} HTTP ${res.status}).`);
  }
}
