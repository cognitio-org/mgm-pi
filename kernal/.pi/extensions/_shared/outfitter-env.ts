/**
 * The laptop's Outfitter credentials: OUTFITTER_API (the link service's origin) and OUTFITTER_TOKEN
 * (a Dongle), read once per process for teleport and the admin tools.
 *
 * The token is then removed from process.env, so the shells and tools pi starts (the agent's `bash`)
 * don't inherit it. An agent that could read it could call the admin ops itself with `confirmed`,
 * past the TUI confirm (outfitter/docs/specs/sysop-tools.md). The person's own shell keeps it.
 */
export interface OutfitterCredentials {
  api?: string;
  token?: string;
}

let cached: OutfitterCredentials | undefined;

function read(env: NodeJS.ProcessEnv): OutfitterCredentials {
  return { api: env.OUTFITTER_API?.trim() || undefined, token: env.OUTFITTER_TOKEN?.trim() || undefined };
}

/** With no argument: this process's credentials, cached, and the token scrubbed from process.env.
 * With an env object (tests): read from it, nothing cached or scrubbed. */
export function outfitterCredentials(env?: NodeJS.ProcessEnv): OutfitterCredentials {
  if (env) return read(env);
  if (!cached) {
    cached = read(process.env);
    delete process.env.OUTFITTER_TOKEN;
  }
  return cached;
}
