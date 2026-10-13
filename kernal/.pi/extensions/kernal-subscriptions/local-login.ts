/**
 * Whether the vendor's own CLI is already signed in on this machine (subscriptions.md §5).
 * Account secrets are a different store. Nothing here returns a credential.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubscriptionVendor } from "./vendors.ts";

export interface LocalLoginOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** When set, used instead of `security` (tests). Must not return the secret. */
  keychain?: (service: string) => boolean;
}

function nonEmpty(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * Whether Claude Code's stored credential is actually usable. An item that exists but holds no
 * access token — or an expired one with nothing to refresh it — is not a login. Treating mere
 * existence as a login makes the worker spawn and then fail with an opaque "OAuth session expired"
 * error instead of asking this person to connect.
 */
export function usableClaudeCredentials(raw: string): boolean {
  let oauth: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
  try {
    oauth = (JSON.parse(raw) as { claudeAiOauth?: typeof oauth } | null)?.claudeAiOauth ?? {};
  } catch {
    return false;
  }
  if (typeof oauth.accessToken !== "string" || oauth.accessToken.trim() === "") return false;
  const refresh = typeof oauth.refreshToken === "string" && oauth.refreshToken.trim() !== "";
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  // An expired access token is still a login while a refresh token can renew it.
  return !(expiresAt > 0 && expiresAt <= Date.now() && !refresh);
}

/** Claude Code's on-disk login: `claudeAiOauth.accessToken` in ~/.claude/.credentials.json. */
function claudeFile(home: string): boolean {
  try {
    return usableClaudeCredentials(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"));
  } catch {
    return false;
  }
}

/** macOS Keychain item Claude Code writes. Read only to check it holds a usable token, never logged. */
function darwinKeychain(service: string): boolean {
  if (process.env.KERNAL_TEST_NO_KEYCHAIN === "1" || process.platform !== "darwin") return false;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return usableClaudeCredentials(raw);
  } catch {
    return false;
  }
}

/** True when this machine already has that vendor's login. Never a secret. */
export function localVendorLogin(vendor: SubscriptionVendor, opts: LocalLoginOpts = {}): boolean {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME?.trim() ?? homedir();
  switch (vendor) {
    case "claude": {
      if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
      if (claudeFile(home)) return true;
      const keychain = opts.keychain ?? darwinKeychain;
      return keychain("Claude Code-credentials");
    }
    case "grok":
      return nonEmpty(join(home, ".grok", "auth.json"));
    case "codex":
      return nonEmpty(join(env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json"));
    case "gemini":
      // agy_acp_server's oauth-personal profile. The runner for it is a later slice.
      return nonEmpty(join(home, ".gemini", "antigravity-acp", "settings.json"));
  }
}

/** `bin` is a PATH entry, not a path. `exists` is injectable so tests don't need a real binary. */
export function binaryOnPath(bin: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  if (!bin || bin.includes("/") || bin.includes("\\")) return false;
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(sep)) {
    if (dir && exists(join(dir, bin))) return true;
  }
  return false;
}
