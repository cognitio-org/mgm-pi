// The live suite's IAP credential (#219): an ID token for the live-test service account, audience =
// the custom IAP OAuth client, email claim included. IAP accepts it in Authorization or
// Proxy-Authorization on every request (deploy/README.md "Live-test identity"); the browser uses
// Authorization, since Chrome won't send Proxy-Authorization on page loads.
//
// E2E_IAP_TOKEN, when set, is used as is: CI mints it with google-github-actions/auth. Otherwise it
// is minted here the way deploy/iap-probe.sh does, through the IAM Credentials generateIdToken API
// with the caller's gcloud login, which must be one of E2E_TOKEN_MINTERS. The gcloud configuration is
// always named (E2E_GCLOUD_CONFIG, default "outfitter"), never whatever happens to be active.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const LIVE = {
  origin: process.env.E2E_WEB_ORIGIN ?? "https://app.kernal.one",
  serviceAccount: process.env.E2E_SERVICE_ACCOUNT ?? "outfitter-e2e@outfitter-509211.iam.gserviceaccount.com",
  audience: process.env.E2E_IAP_AUDIENCE ?? "97916961297-ul9tkt3hh0l8i16imltqcarfrkat1k17.apps.googleusercontent.com",
};

export async function iapToken() {
  if (process.env.E2E_IAP_TOKEN) return process.env.E2E_IAP_TOKEN;
  const config = process.env.E2E_GCLOUD_CONFIG ?? "outfitter";
  const { stdout } = await run("gcloud", ["auth", "print-access-token", `--configuration=${config}`]);
  const res = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${LIVE.serviceAccount}:generateIdToken`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${stdout.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ audience: LIVE.audience, includeEmail: true }),
    },
  );
  const body = await res.json();
  if (!res.ok || !body.token) {
    throw new Error(`could not mint an ID token for ${LIVE.serviceAccount} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.token;
}
