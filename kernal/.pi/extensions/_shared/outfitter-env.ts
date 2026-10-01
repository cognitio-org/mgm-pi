/**
 * The laptop's Outfitter credentials: OUTFITTER_API (the link service's origin) and OUTFITTER_TOKEN
 * (a Dongle), read once per process for teleport and the admin tools.
 *
 * The token is then removed from process.env, so the shells and tools pi starts (the agent's `bash`)
 * don't inherit it. An agent that could read it could call the admin ops itself with `confirmed`,
 * past the TUI confirm (outfitter/docs/specs/sysop-tools.md). The person's own shell keeps it.
 *
 * This is a speed bump, not a boundary: the agent's shell runs as the same user, so it can still
 * read the token from the .env file it came from, or from pi's original environment (`ps eww` on
 * macOS). The API's `confirmed` is the client's word (atlas-agent-engine-and-a2a.md §3.5).
 */
export interface OutfitterCredentials {
  api?: string;
  token?: string;
}

/**
 * Process-wide, not module-wide: pi loads each extension through its own jiti with
 * `moduleCache: false`, so every extension gets its own copy of this module. A module-level cache
 * would let the first extension scrub the token and leave the next one (outfitter-agentengine after
 * outfitter-admin, teleport) with nothing. One slot on globalThis is shared by all of them.
 */
const SLOT = Symbol.for("kernal.outfitterCredentials");
type Slot = { [SLOT]?: OutfitterCredentials };

function read(env: NodeJS.ProcessEnv): OutfitterCredentials {
  return { api: env.OUTFITTER_API?.trim() || undefined, token: env.OUTFITTER_TOKEN?.trim() || undefined };
}

/** With no argument: this process's credentials, cached, and the token scrubbed from process.env.
 * With an env object (tests): read from it, nothing cached or scrubbed. */
export function outfitterCredentials(env?: NodeJS.ProcessEnv): OutfitterCredentials {
  if (env) return read(env);
  const g = globalThis as Slot;
  if (!g[SLOT]) {
    g[SLOT] = read(process.env);
    delete process.env.OUTFITTER_TOKEN;
  }
  return g[SLOT];
}
