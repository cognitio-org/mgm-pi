/**
 * Atlas Agent Engine tools for an Outfitter Drive (outfitter/docs/specs/atlas-agent-engine-and-a2a.md
 * §3.3, §4): `memory` (memory.ts) and, from E9 PR4, `agent_engine` (agents.ts).
 *
 * Each tool registers only when the tape allows it: agentd pins OUTFITTER_ADMIN_CAPS to the tape's
 * capabilities and opens the admin socket (OUTFITTER_ADMIN_SOCKET) for them. On a laptop the
 * variable is unset, so nothing registers here (the API answers "Drive only" anyway). The API
 * enforces every rule; this side only keeps tools that would fail out of the prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adminTransport, hasAdminCapability, type AdminTransport } from "../outfitter-admin/transport.ts";
import { registerMemoryTool } from "./memory.ts";
// E9 PR4 seam: import { registerAgentEngineTool } from "./agents.ts";

/** Tests pass `deps`; pi calls this with `pi` alone, and the environment decides. */
export default function (pi: ExtensionAPI, deps?: { env?: NodeJS.ProcessEnv; transport?: AdminTransport }) {
  const env = deps?.env ?? process.env;
  // Drive only: the socket agentd opened, never a laptop's Dongle.
  const transport = deps && "transport" in deps ? deps.transport : adminTransport(env);
  if (transport?.kind !== "drive") return;

  // ---- one line per tool, each behind its own tape capability ----
  if (hasAdminCapability("memory", env)) registerMemoryTool(pi, transport);
  // E9 PR4 seam: if (hasAdminCapability("agentEngine", env)) registerAgentEngineTool(pi);
}
