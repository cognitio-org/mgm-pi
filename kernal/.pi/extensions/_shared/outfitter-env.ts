/**
 * The laptop's Outfitter credentials, read once per process for teleport, the admin tools, Agent
 * Engine memory, fleet settings and Sentry (outfitter/docs/specs/central-auth.md §2.7):
 *
 * - Signed in with `kernal login` (outfitter-session.ts) to outfitterApi(): the session. `token` is
 *   the stored access token, maybe stale; a request takes its bearer from outfitterBearer(), which
 *   refreshes it when needed.
 * - Else OUTFITTER_API (the link service's origin) and OUTFITTER_TOKEN (a Dongle), deprecated: one
 *   warning per process says to run `kernal login`. CA-10 removes this fallback.
 *
 * The Dongle is then removed from process.env, so the shells and tools pi starts (the agent's
 * `bash`) don't inherit it. An agent that could read it could call the admin ops itself with
 * `confirmed`, past the TUI confirm (outfitter/docs/specs/sysop-tools.md). The person's own shell
 * keeps it.
 *
 * This is a speed bump, not a boundary: the agent's shell runs as the same user, so it can still
 * read the token from the .env file it came from, or from pi's original environment (`ps eww` on
 * macOS), or ask the keychain for the session. The API's `confirmed` is the client's word
 * (atlas-agent-engine-and-a2a.md §3.5).
 */
import { join } from "node:path";
import { currentAccessToken, getAccessToken, loginState, outfitterApi, type SessionStorage } from "./outfitter-session.ts";

export interface OutfitterCredentials {
  api?: string;
  token?: string;
  source?: "session" | "dongle";
}

/**
 * Process-wide, not module-wide: pi loads each extension through its own jiti with
 * `moduleCache: false`, so every extension gets its own copy of this module. A module-level cache
 * would let the first extension scrub the token and leave the next one (outfitter-agentengine after
 * outfitter-admin, teleport) with nothing. One slot on globalThis is shared by all of them.
 */
const SLOT = Symbol.for("kernal.outfitterCredentials");
const WARNED = Symbol.for("kernal.outfitterDongleWarned");
/** Where a session's credentials came from, for outfitterBearer (shared across copies too). */
const STORAGE = Symbol.for("kernal.outfitterSessionStorage");
type Slot = { [SLOT]?: OutfitterCredentials; [WARNED]?: boolean; [STORAGE]?: WeakMap<OutfitterCredentials, SessionStorage> };

function storageMap(): WeakMap<OutfitterCredentials, SessionStorage> {
  const g = globalThis as Slot;
  return (g[STORAGE] ??= new WeakMap());
}

/** `storage` undefined: don't look for a session (an explicit env with no home or auth dir). */
function read(env: NodeJS.ProcessEnv, storage: SessionStorage | undefined): OutfitterCredentials {
  if (storage) {
    const api = outfitterApi(env);
    const which = { ...storage, api };
    const token = loginState(which).signedIn ? currentAccessToken(which) : undefined;
    if (token) {
      const creds: OutfitterCredentials = { api, token, source: "session" };
      storageMap().set(creds, storage);
      return creds;
    }
  }
  const api = env.OUTFITTER_API?.trim() || undefined;
  const token = env.OUTFITTER_TOKEN?.trim() || undefined;
  return token ? { api, token, source: "dongle" } : { api, token };
}

/** With no argument: this process's credentials, cached, and the token scrubbed from process.env.
 * With an env object (tests): read from it, nothing cached or scrubbed; a session is looked for
 * only under that env's KERNAL_AUTH_DIR or HOME, never this machine's real login. */
export function outfitterCredentials(env?: NodeJS.ProcessEnv): OutfitterCredentials {
  if (env) {
    const dir = env.KERNAL_AUTH_DIR?.trim() || (env.HOME?.trim() ? join(env.HOME.trim(), ".kernal", "auth") : undefined);
    return read(env, dir ? { env, authDir: dir } : undefined);
  }
  const g = globalThis as Slot;
  if (!g[SLOT]) {
    g[SLOT] = read(process.env, {});
    delete process.env.OUTFITTER_TOKEN;
    if (g[SLOT].source === "dongle" && !g[WARNED]) {
      g[WARNED] = true;
      process.stderr.write("OUTFITTER_TOKEN is deprecated: run kernal login\n");
    }
  }
  return g[SLOT];
}

/** The bearer for one request: the session's access token, refreshed when it is nearly out, or the
 * Dongle. Undefined when there is neither (or the server refused the refresh). Never throws.
 *
 * `rejected`: the bearer a request just got a 401 for. A session re-reads the keychain once and
 * hands back a newer token (another process rotated it) or undefined; a Dongle gives the same one
 * back, which tells the caller not to retry (§2.4). */
export async function outfitterBearer(creds: OutfitterCredentials = outfitterCredentials(), rejected?: string): Promise<string | undefined> {
  if (creds.source !== "session") return creds.token;
  return getAccessToken({ ...storageMap().get(creds), api: creds.api, ...(rejected ? { rejected } : {}) });
}

/**
 * Sends one request with a bearer from `bearer` and, after a 401, asks it again with the rejected
 * token and retries once when it hands back a different one (§2.4: "after a 401 on any request with
 * an access token: re-read the keychain once and retry once"). `bearer` is outfitterBearer bound to
 * the credentials, or a fixed token (which never retries).
 */
export async function sendWithBearer(
  bearer: string | ((rejected?: string) => Promise<string | undefined>),
  send: (token: string | undefined) => Promise<Response>,
): Promise<Response> {
  const first = typeof bearer === "string" ? bearer : await bearer();
  const res = await send(first);
  if (res.status !== 401 || typeof bearer === "string" || !first) return res;
  const next = await bearer(first);
  if (!next || next === first) return res;
  return send(next);
}
