// GA-2/GA-3 (#492, #493, epic #497): the router's `gcloud` MCP server (Google's remote gcloud, per-user
// OAuth vault) is for Sysop operators only. The router admits an MCP server to a key through the key's
// `object_permission.mcp_servers` (names or ids; LiteLLM's /key/generate takes it, so this needs no new
// admin route). A key with no list sees only the servers the router opens to every key, so a
// non-operator key is minted exactly as before and never gets `gcloud`.
//
// An operator key carries an explicit list. Setting one makes the key "scoped", so the list names the
// servers every key already uses (the laptop mcp.json: ce_knowledge_base and headroom through
// `x-mcp-servers`, and sentry) as well as gcloud; otherwise an operator would lose them if the router
// ever restricts open servers to a key's scope (`mcp_allow_all_keys_respects_mcp_scope`).
//
// Existing keys keep what they were minted with: a device key changes at its next login or re-mint,
// a run key at the next run. Adding or removing an operator takes effect then, not at once.

import { isOperator } from "../auth.ts";
import type { LitellmKeys } from "./litellm-keys.ts";
import type { Guru, Store } from "../store/types.ts";

/** The router's MCP server name for Google's remote gcloud server. */
export const GCLOUD_MCP_SERVER = "gcloud";

/** Kernal's mcp.json entry for the router's `google_cloud` toolset (GB-4, epic #544). Not a router
 * server name: the router admits a key to the toolset by id (`object_permission.mcp_toolsets`), and the
 * toolset's own members (gcloud, cloudrun, cloudlogging, cloudmonitoring, firestore) replace the key's
 * mcp_servers inside toolset scope, so none of them need listing beyond `gcloud` (kept for the legacy
 * per-server path). The name rides in the delivered `routerKey.mcpServers` so Kernal's gate can switch
 * the entry on, and in run.spec.mcp.enable for a Drive. */
export const GOOGLE_CLOUD_ENTRY = "google_cloud";

/** The servers every router key already uses; kept in an operator key's explicit list. */
export const BASE_MCP_SERVERS: readonly string[] = ["ce_knowledge_base", "headroom", "sentry"];

/** A device key belongs to an operator: the person, not the machine, so a laptop of any tape. */
export function deviceKeyMcpServers(ownerEmail: string, operators: readonly string[] | undefined): string[] | undefined {
  return operators && isOperator(ownerEmail, operators) ? [...BASE_MCP_SERVERS, GCLOUD_MCP_SERVER] : undefined;
}

/** Whether a run gets gcloud: the tape opted in (`adminTools: operator`) AND its owner is an operator,
 * the same test as the admin socket's `operator` flag (admin/drive.ts). Never for an A2A session. */
export function gcloudRun(
  guru: Pick<Guru, "adminTools"> | null | undefined,
  ownerEmail: string | undefined,
  operators: readonly string[] | undefined,
  a2a: boolean,
): boolean {
  return !a2a && guru?.adminTools === "operator" && !!ownerEmail && !!operators && isOperator(ownerEmail, operators);
}

function toolsetIds(id: string | undefined): string[] | undefined {
  const trimmed = id?.trim();
  return trimmed ? [trimmed] : undefined;
}

/** The toolsets a device key is admitted to: `google_cloud` for an operator once its id is configured. */
export function deviceKeyMcpToolsets(ownerEmail: string, operators: readonly string[] | undefined, toolsetId: string | undefined): string[] | undefined {
  return operators && isOperator(ownerEmail, operators) ? toolsetIds(toolsetId) : undefined;
}

export function runKeyMcpToolsets(gcloud: boolean, toolsetId: string | undefined): string[] | undefined {
  return gcloud ? toolsetIds(toolsetId) : undefined;
}

/** What Kernal is told: the router servers plus `google_cloud` (the client-side entry) when a toolset is granted. */
export function deliveredMcpServers(servers: readonly string[], toolsets: readonly string[] | undefined): string[] {
  return toolsets?.length ? [...servers, GOOGLE_CLOUD_ENTRY] : [...servers];
}

/** The Drive entries run.spec.mcp.enable switches on: `google_cloud` when the toolset is granted, else the legacy `gcloud`. */
export function mcpEnableList(toolsets: readonly string[] | undefined): string[] {
  return toolsets?.length ? [GOOGLE_CLOUD_ENTRY] : [GCLOUD_MCP_SERVER];
}

export function runKeyMcpServers(gcloud: boolean): string[] | undefined {
  return gcloud ? [...BASE_MCP_SERVERS, GCLOUD_MCP_SERVER] : undefined;
}

/** Device keys last 90 days, so removing an operator would leave their gcloud access that long. The
 * tick (routes/hooks.ts, next to sweepRouterKeys) revokes every live device key minted with gcloud
 * whose owner is no longer an operator. The device then holds a dead key until it re-mints (`/config`
 * reload or `kernal login`); with no operator list configured at all, nothing is revoked, so a
 * misconfigured deploy can't wipe every operator's key. Never throws. */
export async function reconcileOperatorKeys(
  keys: LitellmKeys | undefined,
  store: Pick<Store, "routerKeys">,
  operators: readonly string[],
  limit = 50,
): Promise<{ revoked: number; failed: number } | undefined> {
  if (!keys || operators.length === 0) return undefined;
  const result = { revoked: 0, failed: 0 };
  try {
    // Each query is capped at `limit`, so one tick looks at up to twice that; the rest wait for the next tick.
    const live = [
      ...(await store.routerKeys.listActiveDeviceKeysWithMcpServer(GCLOUD_MCP_SERVER, limit)),
      ...(await store.routerKeys.listActiveDeviceKeysWithMcpToolsets(limit)),
    ];
    const seen = new Set<string>();
    for (const key of live) {
      if (seen.has(key.alias)) continue;
      seen.add(key.alias);
      if (key.ownerEmail && isOperator(key.ownerEmail, operators)) continue;
      try {
        await keys.deleteKey({ alias: key.alias });
        result.revoked++;
      } catch {
        result.failed++;
      }
    }
  } catch {
    return undefined;
  }
  return result;
}

/** Whether run.spec switches the Drive's gcloud entry on: an operator run whose spec carries the run's
 * own, non-empty key. A mint failure that fell back to the shared key (run-keys.ts) has no grant, so
 * the server stays off rather than showing a tool that can't work. */
export function mcpEnableFor(gcloud: boolean, choice: { key: string; source: "run" | "shared" } | undefined): boolean {
  return gcloud && choice?.source === "run" && choice.key !== "";
}

/** The servers only operators may use. Kept in step with agentd/src/mcp-gate.ts, kernal's
 * _shared/mcp-gate.ts and image/render-mcp.sh (test/gcloud-mcp.test.ts compares them). */
export const GATED_MCP_SERVERS: readonly string[] = [GCLOUD_MCP_SERVER, GOOGLE_CLOUD_ENTRY];
