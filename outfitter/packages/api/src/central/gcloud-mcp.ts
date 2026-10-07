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
import type { Guru } from "../store/types.ts";

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
