// SecretsBroker: hands a run its per-session GitHub token and LiteLLM key. Per EPIC.md's "no
// shared secrets between our components" decision, these are only ever sent to agentd over the
// authenticated WebSocket inside run.spec, never as job/container env.

import type { Session, Guru } from "./store/types.ts";

export interface RunSecrets {
  githubToken: string;
  litellmKey: string;
}

export interface SecretsBroker {
  secretsForRun(session: Session, guru: Guru): Promise<RunSecrets>;
}

/** Dev broker: reads fixed values from env so local runs work with no Secret Manager. Defaults to
 * a placeholder (non-empty) githubToken: agentlink.ts's buildRunSpec treats an *empty* token as
 * fatal for a repo session (see GcpSecretsBroker's doc comment), and dev/test repo sessions
 * should work out of the box without OUTFITTER_DEV_GITHUB_TOKEN set — same reasoning as
 * config.ts's devToken default for agentd's own bearer token. */
export class MemorySecretsBroker implements SecretsBroker {
  private readonly githubToken: string;
  private readonly litellmKey: string;

  constructor(
    githubToken = process.env.OUTFITTER_DEV_GITHUB_TOKEN ?? "dev-github-token",
    litellmKey = process.env.OUTFITTER_DEV_LITELLM_KEY ?? "",
  ) {
    this.githubToken = githubToken;
    this.litellmKey = litellmKey;
  }

  async secretsForRun(): Promise<RunSecrets> {
    return { githubToken: this.githubToken, litellmKey: this.litellmKey };
  }
}

/**
 * Production broker: reads Secret Manager over ADC via the Secret Manager REST API (no
 * @google-cloud/secret-manager dependency needed for one call). The shape of the secret names is
 * a placeholder until phase 2's per-session GitHub App tokens land (EPIC.md E2.5); see
 * deploy/README.md for the full naming scheme.
 *
 * A missing secret is not itself an error here: `outfitter-github-token-<sessionId>` legitimately
 * doesn't exist for a repo-less session (and may not exist yet for a fresh repo session either),
 * and `outfitter-litellm-key-<guruId>` falls back to a shared `outfitter-litellm-key-default`
 * before giving up. Callers decide whether an empty value is fatal — agentlink.ts's buildRunSpec
 * does, for githubToken on a session that actually has a repo. accessSecretOrEmpty resolves any
 * other error (auth failure, network, malformed payload) by rethrowing, since those aren't a
 * "the secret doesn't exist" signal.
 */
export class GcpSecretsBroker implements SecretsBroker {
  private readonly project: string;
  private readonly fetchSecret: (secretId: string) => Promise<string>;

  /** `fetchSecret` is injectable so tests can stub Secret Manager access without touching ADC or
   * the network; production code (main.ts) always omits it and gets accessSecretFromGcp. */
  constructor(project: string, fetchSecret?: (secretId: string) => Promise<string>) {
    this.project = project;
    this.fetchSecret = fetchSecret ?? ((secretId) => this.accessSecretFromGcp(secretId));
  }

  async secretsForRun(session: Session, guru: Guru): Promise<RunSecrets> {
    const [githubToken, litellmKey] = await Promise.all([
      this.accessSecretOrEmpty(`outfitter-github-token-${session.id}`),
      this.litellmKeyForGuru(guru.id),
    ]);
    return { githubToken, litellmKey };
  }

  private async litellmKeyForGuru(guruId: string): Promise<string> {
    const key = await this.accessSecretOrEmpty(`outfitter-litellm-key-${guruId}`);
    if (key) return key;
    return this.accessSecretOrEmpty("outfitter-litellm-key-default");
  }

  private async accessSecretOrEmpty(secretId: string): Promise<string> {
    try {
      return await this.fetchSecret(secretId);
    } catch (err) {
      if (!isSecretNotFoundError(err)) throw err;
      console.warn(`[secrets] ${secretId} not found in Secret Manager; resolving to ""`);
      return "";
    }
  }

  private async accessSecretFromGcp(secretId: string): Promise<string> {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const url = `https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets/${secretId}/versions/latest:access`;
    const res = await client.request<{ payload: { data: string } }>({ url });
    const base64 = res.data.payload.data;
    return Buffer.from(base64, "base64").toString("utf8");
  }
}

/** True for a Secret Manager "no such secret/version" failure: a Gaxios HTTP 404, or (in case a
 * client surfaces it as a raw gRPC status instead) code 5 NOT_FOUND. Any other shape of error
 * (network, auth, 403) is treated as real and rethrown by the caller. */
function isSecretNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { response?: { status?: number }; code?: number | string; status?: number };
  const status = e.response?.status ?? e.code ?? e.status;
  return status === 404 || status === "404" || status === 5;
}
