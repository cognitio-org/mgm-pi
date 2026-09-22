/**
 * Env-var compatibility shim for the mgm → kernal rename. Every extension that used to read
 * `process.env.MGM_<NAME>` now reads `process.env.KERNAL_<NAME>` through `env(name)`, which falls
 * back to the legacy `MGM_<NAME>` name (existing installs upgrade in place; their `.env` is
 * migrated to `KERNAL_*` by scripts/install.sh, but anything set in the shell's own environment,
 * e.g. a dotfile export, is not). The fallback warns once per process per old name, to stderr, and
 * is meant to be deleted — along with every `MGM_*` reference — in a later release; see
 * docs/rename.md for the removal plan.
 */
const warnedOnce = new Set<string>();

export function env(name: string): string | undefined {
  const current = process.env[`KERNAL_${name}`];
  if (current !== undefined) return current;
  const legacy = process.env[`MGM_${name}`];
  if (legacy !== undefined) {
    if (!warnedOnce.has(name)) {
      warnedOnce.add(name);
      console.error(`MGM_${name} is now KERNAL_${name}; the old name stops working in a later release.`);
    }
    return legacy;
  }
  return undefined;
}

/** True if either the new or the legacy name is set (does not warn by itself; `env()` does). */
export function envIsSet(name: string): boolean {
  return process.env[`KERNAL_${name}`] !== undefined || process.env[`MGM_${name}`] !== undefined;
}

/**
 * True inside an Outfitter cloud sandbox. The one explicit signal is `KERNAL_SANDBOX=1`, set by
 * outfitter/image/Dockerfile and nowhere else, so a laptop install never sees it. Extensions use it
 * to skip start-up work that only makes sense on a laptop (probing a local model server, re-checking
 * a key the control plane minted seconds ago, blocking start-up on footer data) so the first prompt
 * is answered sooner; see outfitter/docs/reports/startup-trim.md. Nothing is inferred from the rest
 * of the environment.
 */
export function inSandbox(): boolean {
  const v = env("SANDBOX")?.trim().toLowerCase();
  return v !== undefined && !["", "0", "false", "no", "off"].includes(v);
}

/** Test-only: clear the once-per-process warning memory between test cases. */
export function _resetEnvFallbackWarnings(): void {
  warnedOnce.clear();
}
