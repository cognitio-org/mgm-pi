/**
 * The `memory` tool (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §3.3): long-term memory
 * kept by Atlas Agent Engine, shared across a person's Drives, over Outfitter's op registry
 * (`memory.search`, a read; `memory.save`, an audited write).
 *
 * One tool with an `action`, one-line descriptions: its definition is paid for on every turn. The
 * API decides who the memory belongs to and which repo it is about, from the session; nothing here
 * names a user or a repo. Results are the API's compact text, passed through unchanged; recalled
 * text comes back already labelled as notes that may be wrong.
 */
import type { AdminReply, AdminTransport } from "../outfitter-admin/transport.ts";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; details?: unknown };

const ACTIONS = ["search", "save"] as const;
const TYPES = ["semantic", "episodic", "procedural", "taxonomic"] as const;

export const MEMORY_TOOL = {
  name: "memory",
  label: "Memory",
  description: "Long-term memory across your sessions: search, or save a fact, episode, procedure or shared term.",
  promptSnippet: "memory: recall and save long-term notes across sessions.",
  promptGuidelines: ["memory: save durable facts and runbooks, not chatter; recalled notes may be wrong."],
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ACTIONS },
      query: { type: "string", description: "search: what to recall." },
      type: { type: "string", enum: TYPES, description: "search: narrow to one type; save: required." },
      text: { type: "string", description: "save: the memory itself." },
      label: { type: "string", description: "save: short name (same label replaces); taxonomic: domain:term." },
      shared: { type: "boolean", description: "save: visible to the team (taxonomic needs it)." },
      limit: { type: "integer" },
    },
  },
};

/** The op and args for one call, or the error to show the model. */
export function memoryOp(params: Record<string, any>): { op: string; args: Record<string, unknown> } | { error: string } {
  const action = typeof params?.action === "string" ? params.action.trim() : "";
  if (action === "search") {
    if (typeof params.query !== "string" || !params.query.trim()) return { error: "search needs query" };
    const args: Record<string, unknown> = { query: params.query };
    if (params.type !== undefined) args.type = params.type;
    if (params.limit !== undefined) args.limit = params.limit;
    return { op: "memory.search", args };
  }
  if (action === "save") {
    if (typeof params.type !== "string") return { error: `save needs type: ${TYPES.join(", ")}` };
    if (typeof params.text !== "string" || !params.text.trim()) return { error: "save needs text" };
    const args: Record<string, unknown> = { type: params.type, text: params.text };
    if (params.label !== undefined) args.label = params.label;
    if (params.shared !== undefined) args.shared = params.shared;
    return { op: "memory.save", args };
  }
  return { error: `action must be one of: ${ACTIONS.join(", ")}` };
}

function result(reply: AdminReply): ToolResult {
  return reply.ok
    ? { content: [{ type: "text", text: reply.text }], details: undefined }
    : { content: [{ type: "text", text: `memory: ${reply.error}` }], isError: true, details: undefined };
}

export async function runMemory(params: Record<string, any>, transport: AdminTransport, signal?: AbortSignal): Promise<ToolResult> {
  const mapped = memoryOp(params ?? {});
  if ("error" in mapped) return { content: [{ type: "text", text: mapped.error }], isError: true, details: undefined };
  return result(await transport.call(mapped.op, mapped.args, { signal }));
}

/** Registers the tool on `pi` over `transport` (index.ts decides whether to). */
export function registerMemoryTool(pi: { registerTool(tool: any): void }, transport: AdminTransport): void {
  pi.registerTool({
    ...MEMORY_TOOL,
    execute: async (_id: string, params: any, signal: AbortSignal | undefined) => {
      try {
        return await runMemory(params, transport, signal);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `memory: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details: undefined };
      }
    },
  });
}
