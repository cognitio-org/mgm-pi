// Agent Engine (E9): the clients for the parts that are configured. A part is undefined while its
// project id or credentials are unset (config.ts AgentEngineConfig), and callers treat that as
// "off" (`memory.*` and `ae.*` ops answer so).

import type { AgentEngineConfig } from "../config.ts";
import { AgentEngineClient, type FetchFn } from "./client.ts";
import { createAgentsService, type AgentsService } from "./agents.ts";
import { createMemoryService, type MemoryService } from "./memory.ts";

export interface AgentEngine {
  memory?: MemoryService;
  agents?: AgentsService;
}

export function createAgentEngine(config: AgentEngineConfig, opts: { fetch?: FetchFn; now?: () => number; log?: (message: string) => void } = {}): AgentEngine {
  const client = (part: "memory" | "agents") => {
    const project = config[part];
    return project ? new AgentEngineClient({ part, baseUrl: config.baseUrl, project, ...opts }) : undefined;
  };
  const memory = client("memory");
  const agents = client("agents");
  return {
    ...(memory ? { memory: createMemoryService(memory) } : {}),
    ...(agents ? { agents: createAgentsService(agents) } : {}),
  };
}

export { AgentEngineClient, AgentEngineError, type AgentEngineErrorKind, type FetchFn } from "./client.ts";
export type { AgentsService, Execution, InvokeArgs, InvokeResult, RuntimeSession } from "./agents.ts";
export { toAgentEngineError, type ContextSource, type MemoryFacade, type MemoryService, type MemoryType } from "./memory.ts";
