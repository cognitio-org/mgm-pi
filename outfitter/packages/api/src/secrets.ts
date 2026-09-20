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

/** Dev broker: reads fixed values from env so local runs work with no Secret Manager. */
export class MemorySecretsBroker implements SecretsBroker {
  private readonly githubToken: string;
  private readonly litellmKey: string;

  constructor(
    githubToken = process.env.OUTFITTER_DEV_GITHUB_TOKEN ?? "",
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
 * @google-cloud/secret-manager dependency needed for one call). Not exercised in tests; the
 * shape of the secret names is a placeholder until phase 2's per-session GitHub App tokens land
 * (EPIC.md E2.5).
 */
export class GcpSecretsBroker implements SecretsBroker {
  private readonly project: string;

  constructor(project: string) {
    this.project = project;
  }

  async secretsForRun(session: Session, guru: Guru): Promise<RunSecrets> {
    const [githubToken, litellmKey] = await Promise.all([
      this.accessSecret(`outfitter-github-token-${session.id}`),
      this.accessSecret(`outfitter-litellm-key-${guru.id}`),
    ]);
    return { githubToken, litellmKey };
  }

  private async accessSecret(secretId: string): Promise<string> {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const url = `https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets/${secretId}/versions/latest:access`;
    const res = await client.request<{ payload: { data: string } }>({ url });
    const base64 = res.data.payload.data;
    return Buffer.from(base64, "base64").toString("utf8");
  }
}
