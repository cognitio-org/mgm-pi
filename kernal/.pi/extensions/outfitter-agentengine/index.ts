/**
 * Atlas Agent Engine tools for Outfitter (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §3.3,
 * §3.5, §4): `memory` (memory.ts) and `agent_engine` (agents.ts).
 *
 * - In a Drive each tool registers only when the tape allows it: agentd pins OUTFITTER_ADMIN_CAPS to
 *   the tape's capabilities and opens the admin socket (OUTFITTER_ADMIN_SOCKET) for them. A
 *   `memory: auto` tape also gets recall before each prompt (recall.ts; OUTFITTER_MEMORY_RECALL=1).
 * - On a laptop with a Dongle (OUTFITTER_API and OUTFITTER_TOKEN), E9.9: memory only, shared with
 *   the person's Drives, as their own `kernal.memory` setting says (laptop.ts): the tool, recall
 *   before each prompt, opt-in recording, pi-memory off, and `/memory`. `agent_engine` stays Drive
 *   only (the API says so too).
 *
 * The API enforces every rule; this side only keeps tools that would fail out of the prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adminTransport, hasAdminCapability, type AdminTransport } from "../outfitter-admin/transport.ts";
import { registerMemoryTool } from "./memory.ts";
import { registerRecall } from "./recall.ts";
import { registerAgentEngineTool } from "./agents.ts";
import { registerLaptopMemory, type LaptopDeps } from "./laptop.ts";

/** Tests pass `deps`; pi calls this with `pi` alone, and the environment decides. */
export default function (pi: ExtensionAPI, deps?: { env?: NodeJS.ProcessEnv; transport?: AdminTransport } & Omit<LaptopDeps, "env">) {
  const env = deps?.env ?? process.env;
  // No env from the caller: the process's own, read once and with the Dongle scrubbed from
  // process.env (_shared/outfitter-env.ts), whichever extension asked first.
  const transport = deps && "transport" in deps ? deps.transport : adminTransport(deps?.env);
  if (transport?.kind === "laptop") {
    registerLaptopMemory(pi, transport, { ...deps, env });
    return;
  }
  if (transport?.kind !== "drive") return;

  // ---- one line per tool, each behind its own tape capability ----
  if (hasAdminCapability("memory", env)) registerMemoryTool(pi, transport);
  // Recall for a `memory: auto` tape (agentd sets OUTFITTER_MEMORY_RECALL), over the admin socket.
  if (hasAdminCapability("memory", env) && env.OUTFITTER_MEMORY_RECALL === "1") registerRecall(pi as any, transport);
  if (hasAdminCapability("agentEngine", env)) registerAgentEngineTool(pi, transport);
}
