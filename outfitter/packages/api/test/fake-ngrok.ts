/** An in-memory ngrok API for Drive previews tests (#217): records every credential and endpoint
 * made and deleted, and can be told to fail endpoint creation. */
import { NgrokApiError, type NgrokApi, type NgrokCredential, type NgrokEndpoint } from "../src/ngrok-api.ts";

export class FakeNgrok implements NgrokApi {
  credentials = new Map<string, NgrokCredential>();
  endpoints = new Map<string, NgrokEndpoint & { trafficPolicy: string }>();
  deletedCredentials: string[] = [];
  deletedEndpoints: string[] = [];
  failCreateEndpoint = false;
  private seq = 0;
  async createCredential(input: { description: string; metadata: string; acl: string[] }) {
    const id = `cr_${++this.seq}`;
    const cred = { id, token: `tok_${id}`, ...input };
    this.credentials.set(id, { ...cred, token: undefined });
    return cred;
  }
  async deleteCredential(id: string) { this.deletedCredentials.push(id); this.credentials.delete(id); }
  async listCredentials() { return [...this.credentials.values()]; }
  async createCloudEndpoint(input: { url: string; trafficPolicy: string; description: string; metadata: string }) {
    if (this.failCreateEndpoint) throw new NgrokApiError(400, "ERR_NGROK_18002", "bad policy");
    const id = `ep_${++this.seq}`;
    const ep = { id, type: "cloud", url: input.url, description: input.description, metadata: input.metadata, trafficPolicy: input.trafficPolicy };
    this.endpoints.set(id, ep);
    return ep;
  }
  async deleteEndpoint(id: string) { this.deletedEndpoints.push(id); this.endpoints.delete(id); }
  async listCloudEndpoints() { return [...this.endpoints.values()]; }
}

