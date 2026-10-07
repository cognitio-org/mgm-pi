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
    for (const key of await store.routerKeys.listActiveDeviceKeysWithMcpServer(GCLOUD_MCP_SERVER, limit)) {
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
export const GATED_MCP_SERVERS: readonly string[] = [GCLOUD_MCP_SERVER];
