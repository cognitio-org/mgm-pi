// Operator settings (EPIC.md Decisions table / operators.md): the fixed list of Secret Manager
// secrets the /api/operator/* routes (routes/operator.ts) let an operator see and change, plus the
// "which provider does this secret authenticate against" mapping the test endpoint uses. Kept in
// its own module (not routes/operator.ts) so the definitions are easy to find and reuse from tests.

import type { Guru } from "./store/types.ts";
import { GITHUB_TOKEN_DEFAULT_SECRET } from "./secrets.ts";
import { GITHUB_APP_ID_SECRET, GITHUB_APP_INSTALLATION_SECRET, GITHUB_APP_KEY_SECRET, GITHUB_APP_SLUG_SECRET } from "./github-app.ts";

/** When a change to this secret takes effect: "next run" for a secret read live via SecretsBroker
 * at run start (never mounted as container env), "next deploy" for one mounted as a container env
 * var at deploy time (deploy/service.sh's --set-secrets). */
export type SecretAppliesAt = "next run" | "next deploy";

/** Which provider a secret's value authenticates against, for POST /api/operator/secrets/:name/test. */
export type SecretKind = "litellm" | "github" | "ngrok" | "tunnel";

export interface ManagedSecretDef {
  secretName: string;
  label: string;
  purpose: string;
  appliesAt: SecretAppliesAt;
  kind: SecretKind;
}

/** Secret names that exist independently of the current guru list (EPIC.md E2.5 / README.md's
 * Secret Manager section, group (a): mounted as container env vars, read once at boot -- and
 * outfitter-litellm-key-default and outfitter-github-token-default from group (b), read live
 * per run). */
const STATIC_SECRETS: ManagedSecretDef[] = [
  {
    secretName: "outfitter-litellm-key-default",
    label: "Default LiteLLM key",
    purpose: "Used for every run's LiteLLM key unless its guru has its own key.",
    appliesAt: "next run",
    kind: "litellm",
  },
  {
    secretName: GITHUB_TOKEN_DEFAULT_SECRET,
    label: "Default GitHub token",
    purpose: "Fallback GitHub token when the session has none of its own and the GitHub App is not configured.",
    appliesAt: "next run",
    kind: "github",
  },
  {
    secretName: "outfitter-github-pat",
    label: "GitHub PAT",
    purpose: "Fine-grained PAT mounted into the API's environment as GITHUB_PAT.",
    appliesAt: "next deploy",
    kind: "github",
  },
  {
    secretName: GITHUB_APP_ID_SECRET,
    label: "GitHub App id",
    purpose: "Numeric App id. With the private key and installation id, repo sessions mint an installation token.",
    appliesAt: "next run",
    kind: "github",
  },
  {
    secretName: GITHUB_APP_KEY_SECRET,
    label: "GitHub App private key",
    purpose: "PEM private key of the GitHub App, including the BEGIN line. Never sent to a sandbox.",
    appliesAt: "next run",
    kind: "github",
  },
  {
    secretName: GITHUB_APP_INSTALLATION_SECRET,
    label: "GitHub App installation id",
    purpose: "Numeric installation id from the App's installation URL.",
    appliesAt: "next run",
    kind: "github",
  },
  {
    secretName: GITHUB_APP_SLUG_SECRET,
    label: "GitHub App slug",
    purpose: "The App's URL slug, shown on the session page as who a cloud action appears as. Not a credential.",
    appliesAt: "next run",
    kind: "github",
  },
  {
    secretName: "outfitter-litellm-admin",
    label: "LiteLLM admin key",
    purpose: "Used by the provider status service's LiteLLM probe (health/model/key info).",
    appliesAt: "next deploy",
    kind: "litellm",
  },
  {
    secretName: "outfitter-ngrok-api-key",
    label: "ngrok API key",
    purpose: "Used by the provider status service's ngrok probe (GET /endpoints).",
    appliesAt: "next deploy",
    kind: "ngrok",
  },
  {
    secretName: "outfitter-local-tunnel-token",
    label: "Laptop tunnel token",
    purpose: "Bearer token the laptop tunnel's traffic policy requires (LaptopProbe, E2.8 preflight).",
    appliesAt: "next deploy",
    kind: "tunnel",
  },
];

/** Name of the per-guru LiteLLM key secret (README.md group (b)). */
export function guruLitellmKeySecretName(guruId: string): string {
  return `outfitter-litellm-key-${guruId}`;
}

/** Name of a session's own GitHub token. Not operator-managed; the delete guard for the
 * shared default reads it to see who would be left with nothing. */
export function sessionGithubTokenSecretName(sessionId: string): string {
  return `outfitter-github-token-${sessionId}`;
}

const GURU_KEY_PREFIX = "outfitter-litellm-key-";

/** Every managed secret definition right now: the fixed list plus one per existing guru. Order
 * matches GET /api/operator/settings's `secrets` array. */
export function managedSecretDefs(gurus: Guru[]): ManagedSecretDef[] {
  const guruDefs: ManagedSecretDef[] = gurus.map((guru) => ({
    secretName: guruLitellmKeySecretName(guru.id),
    label: `LiteLLM key: ${guru.name}`,
    purpose: `Used for this guru's runs instead of the default key.`,
    appliesAt: "next run",
    kind: "litellm",
  }));
  return [...STATIC_SECRETS, ...guruDefs];
}

/** True when `secretName` is one this deployment manages: a static name, or
 * outfitter-litellm-key-<guruId> for a guru that currently exists. Anything else (including a
 * per-session GitHub token secret, README.md group (b)'s other kind) is rejected -- those aren't
 * operator-managed. */
export function isManagedSecretName(secretName: string, gurus: Guru[]): boolean {
  if (STATIC_SECRETS.some((def) => def.secretName === secretName)) return true;
  if (!secretName.startsWith(GURU_KEY_PREFIX)) return false;
  const guruId = secretName.slice(GURU_KEY_PREFIX.length);
  if (guruId === "default" || !guruId) return false; // the static default secret, handled above
  return gurus.some((guru) => guru.id === guruId);
}

/** Looks up one secret's definition by name, given the current guru list (for the per-guru case). */
export function managedSecretDef(secretName: string, gurus: Guru[]): ManagedSecretDef | undefined {
  return managedSecretDefs(gurus).find((def) => def.secretName === secretName);
}
