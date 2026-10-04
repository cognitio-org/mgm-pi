// A person signed in through IAP, for tests with dev mode off. #390 made every token identity
// `operator: false`, so a test that needs a sysop (or any person, e.g. to approve a device code) on
// a non-dev app signs in the way a browser does: an IAP assertion header. The assertion's
// verification is stubbed here (test/token-verification.test.ts runs the real one): the header
// value `test-iap:<email>` is accepted as that email.

import type { TestContext } from "node:test";
import { OAuth2Client } from "google-auth-library";

/** Set as IAP_AUDIENCE on the app; auth.ts refuses an assertion without one configured. */
export const TEST_IAP_AUDIENCE = "/projects/1/locations/test/services/outfitter-api";

const PREFIX = "test-iap:";

/** Stubs IAP's key fetch and signature check for the rest of test `t`. */
export function useFakeIap(t: TestContext): void {
  t.mock.method(OAuth2Client.prototype, "getIapPublicKeys", async () => ({ pubkeys: {}, res: null }));
  t.mock.method(OAuth2Client.prototype, "verifySignedJwtWithCertsAsync", async (jwt: string) => {
    if (!jwt.startsWith(PREFIX)) throw new Error("not a test IAP assertion");
    const email = jwt.slice(PREFIX.length);
    return { getPayload: () => ({ email }) };
  });
}

/** The request headers of `email` signed in through (fake) IAP. */
export function iapHeaders(email: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "x-goog-iap-jwt-assertion": `${PREFIX}${email}`, ...extra };
}
