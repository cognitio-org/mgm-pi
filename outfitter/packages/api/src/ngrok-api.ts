/**
 * The slice of the ngrok API (https://api.ngrok.com, `Ngrok-Version: 2`) that Drive previews use
 * (#217, docs/specs/drive-previews.md): per-run agent credentials, and the public cloud endpoints
 * whose Traffic Policy only the api writes. The API key (NGROK_API_KEY, Secret Manager
 * outfitter-ngrok-api-key) never leaves the api.
 */

export interface NgrokCredential {
  id: string;
  /** Only present in the create response: ngrok never returns it again. */
  token?: string;
  description?: string;
  metadata?: string;
  acl?: string[];
}

export interface NgrokEndpoint {
  id: string;
  url: string;
  type?: string;
  description?: string;
  metadata?: string;
}

export interface NgrokApi {
  /** `timeoutMs` shortens the call's deadline (a run's wake waits on this one). */
  createCredential(input: { description: string; metadata: string; acl: string[] }, opts?: { timeoutMs?: number }): Promise<NgrokCredential>;
  /** Idempotent: a credential that's already gone is not an error. */
  deleteCredential(id: string): Promise<void>;
  listCredentials(): Promise<NgrokCredential[]>;
  createCloudEndpoint(input: { url: string; trafficPolicy: string; description: string; metadata: string }): Promise<NgrokEndpoint>;
  /** Idempotent, like deleteCredential. */
  deleteEndpoint(id: string): Promise<void>;
  /** Cloud endpoints only. */
  listCloudEndpoints(): Promise<NgrokEndpoint[]>;
}

export class NgrokApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const BASE = "https://api.ngrok.com";
const TIMEOUT_MS = 15_000;
/** Pages followed when listing, at 100 items each: plenty for an account that holds one Drive's
 * worth of previews per active run. */
const MAX_PAGES = 20;

export function createNgrokApi(apiKey: string, fetchImpl: typeof fetch = fetch): NgrokApi {
  const call = async (method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<any> => {
    const url = path.startsWith("https://") ? path : `${BASE}${path}`;
    // The API key goes to ngrok's API and nowhere else, whatever a response's next_page_uri says.
    if (!url.startsWith(`${BASE}/`)) throw new NgrokApiError(0, "BAD_URL", `refusing to call ${url.slice(0, 80)}`);
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Ngrok-Version": "2",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (method === "DELETE" && res.status === 404) return undefined;
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!res.ok) {
      throw new NgrokApiError(res.status, String(json?.error_code ?? `HTTP_${res.status}`), String(json?.msg ?? text ?? `HTTP ${res.status}`).slice(0, 500));
    }
    return json;
  };

  const listAll = async <T>(path: string, key: string): Promise<T[]> => {
    const out: T[] = [];
    let next: string | undefined = `${path}${path.includes("?") ? "&" : "?"}limit=100`;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const json = await call("GET", next);
      out.push(...((json?.[key] as T[] | undefined) ?? []));
      next = typeof json?.next_page_uri === "string" && json.next_page_uri ? json.next_page_uri : undefined;
    }
    return out;
  };

  return {
    async createCredential(input, opts) {
      const json = await call("POST", "/credentials", input, opts?.timeoutMs);
      return { id: String(json.id), token: typeof json.token === "string" ? json.token : undefined, description: json.description, metadata: json.metadata, acl: json.acl };
    },
    async deleteCredential(id) {
      await call("DELETE", `/credentials/${encodeURIComponent(id)}`);
    },
    async listCredentials() {
      return listAll<NgrokCredential>("/credentials", "credentials");
    },
    async createCloudEndpoint(input) {
      const json = await call("POST", "/endpoints", {
        type: "cloud",
        url: input.url,
        traffic_policy: input.trafficPolicy,
        description: input.description,
        metadata: input.metadata,
      });
      return { id: String(json.id), url: String(json.url ?? input.url), type: json.type, description: json.description, metadata: json.metadata };
    },
    async deleteEndpoint(id) {
      await call("DELETE", `/endpoints/${encodeURIComponent(id)}`);
    },
    async listCloudEndpoints() {
      const all = await listAll<NgrokEndpoint>("/endpoints", "endpoints");
      return all.filter((e) => e.type === "cloud");
    },
  };
}
