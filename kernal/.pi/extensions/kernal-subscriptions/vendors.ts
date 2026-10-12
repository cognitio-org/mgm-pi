/**
 * Personal subscription workers (outfitter/docs/specs/subscriptions.md §2, §5). The four vendors,
 * the binaries and API-key env vars the status command reports, and which builtin subagents a
 * switch hides. Runners live beside this file; only Claude's is implemented.
 */

export const SUBSCRIPTION_VENDORS = ["claude", "grok", "codex", "gemini"] as const;
export type SubscriptionVendor = (typeof SUBSCRIPTION_VENDORS)[number];
export type SubscriptionMode = "off" | "sandboxed" | "full";

export function isVendor(value: string): value is SubscriptionVendor {
  return (SUBSCRIPTION_VENDORS as readonly string[]).includes(value);
}

export function isMode(value: string | undefined): value is SubscriptionMode {
  return value === "off" || value === "sandboxed" || value === "full";
}

/** On PATH. Gemini's worker is `agy_acp_server`, not `agy` and not `gemini`. */
export const SUBSCRIPTION_BINARY: Record<SubscriptionVendor, string> = {
  claude: "claude",
  grok: "grok",
  codex: "codex",
  gemini: "agy_acp_server",
};

/**
 * Set in the environment, these bill the API instead of the plan. Status reports the names only.
 * The Claude runner deletes the Claude pair from the child's environment.
 */
export const SUBSCRIPTION_API_KEY_ENV: Record<SubscriptionVendor, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  grok: ["XAI_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

/** Builtin pi-subagents to hide while that vendor's switch is not off. Hiding them stops a Console bill. */
export const HIDDEN_BUILTIN_AGENTS: Record<"claude" | "codex", readonly string[]> = {
  claude: ["claude-code", "claude-code-writer"],
  codex: ["codex-exec", "codex-exec-writer"],
};

/** Names to drop from subagent list/get/models text. `off` and a missing mode leave the builtins. */
export function hiddenSubscriptionAgents(modes: { claude?: string; codex?: string }): string[] {
  const out: string[] = [];
  if (modes.claude && modes.claude !== "off") out.push(...HIDDEN_BUILTIN_AGENTS.claude);
  if (modes.codex && modes.codex !== "off") out.push(...HIDDEN_BUILTIN_AGENTS.codex);
  return out;
}

/** Which of the shadowing API-key variables are set. Names only, never values. */
export function apiKeyEnvSet(vendor: SubscriptionVendor, env: NodeJS.ProcessEnv): string[] {
  return SUBSCRIPTION_API_KEY_ENV[vendor].filter((name) => !!env[name]?.trim());
}
