/**
 * Kernal's sign-in to Outfitter (#391 CA-2, outfitter/docs/specs/central-auth.md §2): `kernal login`
 * runs the device-code flow against the link origin and keeps the tokens in the OS keychain, one
 * login per machine, shared by every Kernal process. Owned by task E; the exports below are the
 * contract central-config.ts (CA-8), /admin (CA-9), the migration (CA-10) and outfitter-env.ts
 * build against.
 *
 * Until CA-2 lands every function here reports "signed out", so callers fall back to the Dongle.
 */

/** Baked into releases (spec §2.1); OUTFITTER_API overrides it, for dev. */
export const DEFAULT_OUTFITTER_API = "https://link.kernal.one";

export interface SessionAccount {
  /** The link origin this login belongs to, no trailing slash. */
  api: string;
  email: string;
  /** Outfitter's user id (`u_...`). */
  userId: string;
  deviceId: string;
  deviceName: string;
}

/** The secret half of a login, one keychain item per account (spec §2.3). */
export interface SessionSecrets {
  accessToken: string;
  /** ISO time. */
  accessExpiresAt: string;
  refreshToken: string;
  /** CA-5: this device's router key, delivered once at login. */
  routerKey?: { key: string; baseUrl: string; alias: string; expiresAt?: string };
}

export type LoginState = { signedIn: false } | { signedIn: true; account: SessionAccount };

/** Where the secret half lives. Synchronous on purpose: start-up reads it before any await. */
export interface SecretBackend {
  name: "keychain" | "secret-service" | "file";
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  delete(account: string): void;
}

/** The API this process talks to: OUTFITTER_API, else DEFAULT_OUTFITTER_API. */
export function outfitterApi(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OUTFITTER_API?.trim() || DEFAULT_OUTFITTER_API).replace(/\/+$/, "");
}

/** Sync, no network: whether this machine is signed in to `api` (default outfitterApi()), and as
 * whom. `email` picks one of several accounts (a profile names its account, spec §2.3). */
export function loginState(_opts: { api?: string; email?: string } = {}): LoginState {
  return { signedIn: false };
}

/** A valid access token, refreshed first when it has under 2 minutes left (single-flight across
 * processes, spec §2.4). Undefined when signed out or when the refresh was refused (then the
 * login is cleared). Never throws. */
export async function getAccessToken(_opts: { api?: string; email?: string; fetch?: typeof fetch } = {}): Promise<string | undefined> {
  return undefined;
}

/** CA-5's router key for this device, from the keychain. Sync. */
export function getRouterKey(_opts: { api?: string; email?: string } = {}): SessionSecrets["routerKey"] | undefined {
  return undefined;
}

/** Replaces the stored router key (after POST /api/device/router-key re-minted it). */
export function setRouterKey(_key: NonNullable<SessionSecrets["routerKey"]>, _opts: { api?: string; email?: string } = {}): void {
  throw new Error("kernal login is not available yet (CA-2)");
}

export interface LoginOptions {
  api?: string;
  /** Default: the machine's hostname. */
  deviceName?: string;
  /** False with KERNAL_NO_BROWSER or no display: print the URL and code instead. */
  openBrowser?: boolean;
  /** Where the URL, the code and progress go (the CLI passes a stderr writer). */
  print: (line: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Runs the whole device-code flow and stores the result. Throws with a one-line reason. */
export async function login(_opts: LoginOptions): Promise<SessionAccount> {
  throw new Error("kernal login is not available yet (CA-2)");
}

/** Revokes this device on the server (best-effort) and forgets the login locally. */
export async function logout(_opts: { api?: string; email?: string; fetch?: typeof fetch } = {}): Promise<void> {
  throw new Error("kernal logout is not available yet (CA-2)");
}
