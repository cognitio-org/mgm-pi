/**
 * A throwaway HOME signed in to `api` with `kernal login` (file backend, fake device flow, no
 * network), for tests that need a laptop's Outfitter credentials now that Dongles are retired (#399).
 * Returns the env to pass to outfitterCredentials/adminTransport/register.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../.pi/extensions/_shared/outfitter-session.ts";

export async function signedInEnv(api: string): Promise<{ HOME: string; KERNAL_AUTH_BACKEND: string; OUTFITTER_API: string }> {
  const HOME = mkdtempSync(join(tmpdir(), "kernal-home-"));
  const authDir = join(HOME, ".kernal", "auth");
  mkdirSync(authDir, { recursive: true });
  const env = { HOME, KERNAL_AUTH_BACKEND: "file", OUTFITTER_API: api };
  const answers: Record<string, unknown> = {
    "/api/device/code": { device_code: "kdc_t", user_code: "BCDF-GHJK", verification_uri: `${api}/device`, expires_in: 600, interval: 5 },
    "/api/device/token": {
      token_type: "Bearer",
      access_token: "kda_test",
      expires_in: 3600,
      refresh_token: "kdr_test",
      refresh_expires_in: 2592000,
      device: { id: "dev_aaaaaaaaaaaaaaa1", name: "test" },
      account: { email: "a@example.com", userId: "u_123" },
      problems: [],
    },
  };
  const fetchFn = (async (url: string) => {
    const body = answers[new URL(url).pathname];
    return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await login({ env, authDir, api, print: () => {}, fetch: fetchFn, openBrowser: false, sleep: async () => {}, kernalVersion: "0.0.0-test" });
  return env;
}
