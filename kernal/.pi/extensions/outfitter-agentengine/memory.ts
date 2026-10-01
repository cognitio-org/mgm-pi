/**
 * The `memory` tool (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §3.3): long-term memory
 * kept by Atlas Agent Engine, shared across a person's Drives, over Outfitter's op registry
 * (`memory.search`, a read; `memory.save`, an audited write).
 *
 * One tool with an `action`, one-line descriptions: its definition is paid for on every turn. The
 * API decides who the memory belongs to and which repo it is about, from the session; nothing here
 * names a user or a repo. Results are the API's compact text, passed through unchanged; recalled
 * text comes back already labelled as notes that may be wrong.
 *
 * On a laptop (E9.9, laptop.ts) the same tool goes over the Dongle's HTTP transport with a `laptop`
 * context, and a shared or taxonomic save asks the person in the TUI first (the API takes
 * `confirmed` as their yes); with nobody at the terminal it is refused here.
 */
import { redact } from "../_shared/redact.ts";
import type { AdminReply, AdminTransport, LaptopContext } from "../outfitter-admin/transport.ts";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; details?: unknown };
export type Confirm = (title: string, message: string, signal?: AbortSignal) => Promise<boolean>;

/** A laptop call's extras: its context, and the person's confirm when one is at the terminal. */
export interface LaptopCall {
  laptop?: LaptopContext;
  confirm?: Confirm;
}

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

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true, details: undefined });

/** Model text as the person sees it in a confirm: no control characters (an escape sequence could
 * hide or redraw what they are agreeing to), clipped. */
export function shown(text: string, max: number): string {
  const flat = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A laptop's args with the free text redacted before it leaves the machine (the API does it too). */
function redacted(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const key of ["query", "text", "label"]) if (typeof out[key] === "string") out[key] = redact(out[key] as string);
  return out;
}

export async function runMemory(params: Record<string, any>, transport: AdminTransport, signal?: AbortSignal, laptop: LaptopCall = {}): Promise<ToolResult> {
  const mapped = memoryOp(params ?? {});
  if ("error" in mapped) return fail(mapped.error);
  if (transport.kind !== "laptop") return result(await transport.call(mapped.op, mapped.args, { signal }));
  if (!laptop.laptop) return fail("memory: this session has no id yet; try again after the first prompt");
  const args = redacted(mapped.args);
  const shared = mapped.op === "memory.save" && (args.shared === true || args.type === "taxonomic");
  if (!shared) return result(await transport.call(mapped.op, args, { signal, laptop: laptop.laptop }));
  // Shared memory is recalled into the other users' prompts: the person says yes first.
  if (!laptop.confirm) return fail("memory: a shared memory needs your yes at the terminal; save it privately, or run Kernal in the TUI");
  const label = typeof args.label === "string" && args.label.trim() ? `, label "${shown(args.label, 120)}"` : "";
  const yes = await laptop.confirm(
    "Save a shared memory?",
    `Everyone on your Outfitter will have this recalled into their prompts (${shown(String(args.type), 20)}${label}):\n\n${shown(String(args.text), 600)}`,
    signal,
  );
  if (!yes) return fail("memory: not saved (you said no)");
  return result(await transport.call(mapped.op, args, { signal, laptop: laptop.laptop, confirmed: true }));
}

/** On a laptop: how to get each call's context and confirm (laptop.ts). */
export interface LaptopTool {
  laptop: (ctx: any) => Promise<LaptopContext | undefined>;
  confirm: (ctx: any) => Confirm | undefined;
}

/** Registers the tool on `pi` over `transport` (index.ts and laptop.ts decide whether to). */
export function registerMemoryTool(pi: { registerTool(tool: any): void }, transport: AdminTransport, laptop?: LaptopTool): void {
  pi.registerTool({
    ...MEMORY_TOOL,
    execute: async (_id: string, params: any, signal: AbortSignal | undefined, _update?: unknown, ctx?: any) => {
      try {
        const call: LaptopCall = laptop ? { laptop: await laptop.laptop(ctx), confirm: laptop.confirm(ctx) } : {};
        return await runMemory(params, transport, signal, call);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `memory: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details: undefined };
      }
    },
  });
}
