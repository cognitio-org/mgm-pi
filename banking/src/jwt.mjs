import { createSign } from "node:crypto";

const LIFETIME_SECONDS = 300;

function b64url(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.toString("base64url");
}

// Enable Banking wants an RS256 JWT, kid = application id, lifetime at most 1 hour.
// Five minutes keeps a stolen token short-lived. The token is returned to the caller
// and must not be logged.
export function signJwt({ privateKey, appId, nowSec }) {
  const iat = nowSec;
  const exp = iat + LIFETIME_SECONDS;
  const header = { typ: "JWT", alg: "RS256", kid: appId };
  const body = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  const token = `${input}.${signer.sign(privateKey).toString("base64url")}`;
  return { token, exp };
}

export { LIFETIME_SECONDS };
