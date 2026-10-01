// Agent Engine agent ops (E9 §4, docs/specs/atlas-agent-engine-and-a2a.md): what Kernal's
// `agent_engine` tool calls from a Drive whose tape has `agentEngine`. Registered into the admin op
// registry (ops.ts) when this module is imported (server.ts).
//
// - ae.list (read): the allowlist's enabled agents (aeAgents, set by a sysop in Settings). Nothing
//   is discovered from Agent Engine, so there is no remote list to trust.
// - ae.invoke (write, audited as `<agent>/<execution>`): streams the agent's reply (agents.ts) and
//   records the Agent Engine session it used (aeSessions), so the session-close sweep can stop it
//   and ae.get/ae.resume reach only executions this Outfitter session started.
// - ae.get (read): one of those executions.
// - ae.resume (approve): answers a review pause. Always raises the owner's approval card (E8.2),
//   which shows the agent, the pause's context (clipped, escaped and labelled as the remote agent's
//   words) and the decision. An agent never approves another agent's pause on its own.
//
// Everything Agent Engine sends back is untrusted text: results are clipped to 8 KB and the remote
// part is fenced as `[from Agent Engine agent <id>]` … `[end of Agent Engine agent <id>]`.
//
// E9.10 (#354, spec §7.1): a laptop playing a tape whose `agentEngine` is on reaches the same ops
// with its Dongle (`laptop: "tape"`). routes/admin.ts reads the tape the call names on every call,
// so turning Agent Engine off on the tape cuts the laptop off at once. Every laptop invoke and resume
// waits for the owner's yes in the Outfitter web app (`laptop: "web"`; never a `confirmed` the
// laptop's own agent could send), a resume bound to the pause the card showed. The Agent Engine
// session a laptop opens is keyed `laptop:<owner hash>:<pi session id>` (aeSessionKey), so another
// Dongle holder who learns the pi session id reaches none of its executions, and the X-Session-ID
// keeps the Drives' `outf-<session8>-<agent>` shape. `ae.close` stops them when the laptop session
// ends; the tick sweep stops what an idle laptop left open.

import {
  AgentEngineError,
  allowedDecisions,
  invokeStatus,
  MAX_DECISION_CHARS,
  pauseFingerprint,
  type AgentsService,
  type Execution,
  type InvokeResult,
} from "../agentengine/index.ts";
import type { AeAgent, AeSession } from "../store/types.ts";
import { registerAdminOp, type AdminCaller, type AdminContext, type AdminResult } from "./ops.ts";
import type { LaptopCard } from "./laptop-approvals.ts";
import { clip, shortId } from "./render.ts";
import { stripHidden } from "../untrusted.ts";
import { createHash } from "node:crypto";
import { memoryUserHash } from "../agentengine/identity.ts";
import { redact } from "../search/redact.ts";

/** Cap on one ae.* result, in UTF-8 bytes. */
export const AE_RESULT_CAP = 8 * 1024;
const MAX_MESSAGE_CHARS = 32_000;
/** A laptop's invoke message: what its approval card shows in full (laptop-approvals MAX_SUMMARY). */
const LAPTOP_MESSAGE_CHARS = 5_000;
/** Reviewer notes the card shows in full (under CARD_CONTEXT_CHARS). */
const MAX_NOTES_CHARS = 500;
/** How much of a review pause's context the approval card shows. */
const CARD_CONTEXT_CHARS = 600;

type Args = Record<string, unknown>;

const OFF = "Agent Engine agents are not set up on this Outfitter";

/** The short session id Agent Engine sees: a UUID's random tail (shortId), else the id's last 8
 * safe characters. Never an email. A laptop's key (`laptop:<owner hash>:<pi id>`, E9.10) is
 * digested whole instead: its tail is the client's pi id, which another Dongle holder could choose
 * to match someone else's session (security review). `L` + 7 base64url characters of sha256: never
 * a Drive's (hex, lowercase) and bound to the owner hash. */
export function session8(sessionId: string): string {
  if (sessionId.startsWith("laptop:")) return `L${createHash("sha256").update(sessionId).digest("base64url").slice(0, 7)}`;
  const short = shortId(sessionId);
  const safe = (short.length === 8 ? short : sessionId).replace(/[^A-Za-z0-9_-]/g, "");
  return safe.slice(-8) || "session";
}

/** X-Session-ID for this Outfitter session and agent: one Agent Engine session (and sandbox pair)
 * per pair, reused across invokes. */
export function aeSessionId(sessionId: string, agentId: string): string {
  return `outf-${session8(sessionId)}-${agentId}`;
}

/** The key this caller's Agent Engine sessions are recorded under (aeSessions.outfitterSessionId):
 * a Drive's Outfitter session; for a laptop playing a tape, `laptop:<owner hash>:<pi session id>`,
 * bound to the Dongle's owner (the pi id is the client's word). Undefined: no session to act in. */
export function aeSessionKey(caller: AdminCaller): string | undefined {
  if (caller.via === "drive") return caller.sessionId;
  const pi = caller.laptop?.sessionId?.startsWith("laptop:") ? caller.laptop.sessionId.slice("laptop:".length) : undefined;
  return pi && caller.laptop?.tape ? `laptop:${memoryUserHash(caller.email)}:${pi}` : undefined;
}

const NO_SESSION = "ae ops work only in a Drive, or on a laptop playing a tape with Agent Engine";

/** Remote text for the model: no control characters but newlines and tabs, and none of our own
 * fence markers, so the agent's words can't close the fence and speak as Outfitter. */
export function cleanRemote(text: string): string {
  // Fullwidth and other compatibility forms become their ASCII selves, so they can't pass for our
  // markers after the model reads them; line and paragraph separators become spaces (words stay
  // apart), then the other hidden characters go (untrusted.ts).
  return (
    stripHidden(text.normalize("NFKC").replace(/[\u2028\u2029]/g, " "))
      .replace(/[^\S\n\t ]/gu, " ")
      .replace(/\[\s*(from|end\s+of)\s+agent\s+engine\s+agent/giu, "($1 Agent Engine agent")
  );
}

/** Cuts `text` to at most `bytes` UTF-8 bytes, on a character boundary. */
function clipBytes(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  return buf.subarray(0, bytes).toString("utf8").replace(/�+$/, "");
}

/**
 * One ae.* result: our own lines first, then the remote part fenced and marked, the whole clipped to
 * AE_RESULT_CAP. `remote` lines are the agent's words.
 */
export function aeResult(agentId: string, ours: string[], remote: string[]): string {
  const head = ours.filter(Boolean).join("\n");
  const body = remote.filter(Boolean).map(cleanRemote).join("\n");
  if (!body) return clipBytes(head, AE_RESULT_CAP);
  const open = `[from Agent Engine agent ${agentId}]`;
  const close = `[end of Agent Engine agent ${agentId}]`;
  const cut = "\n… cut at 8 KB";
  const fixed = Buffer.byteLength(`${head}\n${open}\n\n${close}`, "utf8");
  const room = AE_RESULT_CAP - fixed;
  const fits = Buffer.byteLength(body, "utf8") <= room;
  const shown = fits ? body : `${clipBytes(body, Math.max(0, room - Buffer.byteLength(cut, "utf8")))}${cut}`;
  return `${head}\n${open}\n${shown}\n${close}`;
}

/** A value from Agent Engine as text: strings as they are, anything else as JSON. */
function asText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function agentsOf(ctx: AdminContext): AgentsService | undefined {
  return ctx.agentEngine?.agents;
}

/** An enabled allowlist entry by exact id; the error names the enabled ones. */
async function enabledAgent(ctx: AdminContext, ref: unknown): Promise<{ ok: true; agent: AeAgent } | { ok: false; error: string }> {
  const id = typeof ref === "string" ? ref.trim() : "";
  const all = await ctx.store.aeAgents.list();
  const agent = id ? all.find((a) => a.id === id && a.enabled) : undefined;
  if (agent) return { ok: true, agent };
  const enabled = all.filter((a) => a.enabled).map((a) => a.id);
  const known = enabled.length ? `; agents: ${enabled.slice(0, 20).join(", ")}` : "; none are enabled (a sysop adds them in Settings)";
  return { ok: false, error: id ? `no enabled Agent Engine agent "${clip(id, 60)}"${known}` : `agent is required${known}` };
}

/** The execution this caller's session started, with its agent still listed and enabled. */
async function ownExecution(
  ctx: AdminContext,
  caller: AdminCaller,
  ref: unknown,
): Promise<{ ok: true; row: AeSession; agent: AeAgent; executionId: string } | { ok: false; error: string }> {
  const key = aeSessionKey(caller);
  if (!key) return { ok: false, error: NO_SESSION };
  const executionId = typeof ref === "string" ? ref.trim() : "";
  if (!executionId) return { ok: false, error: "executionId is required" };
  const row = await ctx.store.aeSessions.findByExecution(key, executionId);
  // E9.10: a laptop's get or resume counts as use, so the idle sweep doesn't stop a session whose
  // execution is still being polled or answered (review). A Drive's sweep goes by its run instead.
  if (row && key.startsWith("laptop:")) await ctx.store.aeSessions.touch(row.id, new Date(ctx.now?.() ?? Date.now()).toISOString());
  if (!row) return { ok: false, error: `no execution "${clip(executionId, 80)}" started from this session` };
  const agent = await enabledAgent(ctx, row.agentId);
  if (!agent.ok) return { ok: false, error: `Agent Engine agent ${row.agentId} is no longer enabled` };
  return { ok: true, row, agent: agent.agent, executionId };
}

/** An Agent Engine error for the model. One that carries the gateway's reply (an HTTP status, or a
 * reply we couldn't read) has remote words in it, so it comes fenced like a result. */
function errorText(err: unknown, agentId: string): string {
  if (err instanceof AgentEngineError) {
    if (err.kind === "off") return OFF;
    if (err.status === undefined && err.kind !== "server") return err.message;
    return aeResult(agentId, [`Agent Engine refused the call (${err.kind}${err.status ? ` ${err.status}` : ""})`], [err.message]);
  }
  throw err;
}

/** Our lines and the remote lines for an execution as Agent Engine reports it. */
function executionLines(execution: Execution | undefined): string[] {
  if (!execution) return [];
  const out: string[] = [];
  const reason = asText(execution.suspend_reason);
  const context = asText(execution.suspend_context);
  const decisions = allowedDecisions(execution);
  const response = asText(execution.response ?? execution.result ?? execution.output);
  const error = asText(execution.error);
  if (reason) out.push(`suspend reason: ${reason}`);
  if (context) out.push(`suspend context: ${context}`);
  if (decisions.length) out.push(`allowed decisions: ${decisions.join(", ")}`);
  if (error) out.push(`error: ${error}`);
  if (response) out.push(`response:\n${response}`);
  return out;
}

function statusHint(status: InvokeResult["status"]): string | undefined {
  if (status === "running") return "still running on Agent Engine; check later with get";
  if (status === "suspended") return "paused for human review: ask the user what to decide, then resume (the owner approves it on a card)";
  return undefined;
}

function invokeText(agentId: string, result: InvokeResult): string {
  const ours = [`status: ${result.status}`, result.executionId ? `execution: ${result.executionId}` : "execution: (Agent Engine sent no id)", statusHint(result.status), result.truncated ? "note: the reply was longer than Outfitter keeps" : undefined];
  const remote = [...executionLines(result.execution)];
  // The stream's text, unless the execution already carried its response.
  if (result.response && !remote.some((l) => l.startsWith("response:"))) remote.push(result.status === "failed" ? `error: ${result.response}` : `response:\n${result.response}`);
  return aeResult(agentId, ours.filter((l): l is string => !!l), remote);
}

/** The card's view of a review pause: the agent's own words, escaped (JSON-quoted, so its quotes
 * and line breaks can't pass for the card's) and clipped. */
function cardQuote(value: unknown): string {
  const text = asText(value).replace(/\s+/g, " ").trim();
  if (!text) return "(none)";
  const cleaned = stripHidden(text, false);
  return JSON.stringify(cleaned.length > CARD_CONTEXT_CHARS ? `${cleaned.slice(0, CARD_CONTEXT_CHARS - 1)}…` : cleaned);
}

/** Decision and notes short enough for the card to show in full: the owner approves every word. */
function resumeArgsError(decision: string, notes: unknown): string | undefined {
  if (!decision) return "decision is required";
  if (decision.length > MAX_DECISION_CHARS) return `decision is over ${MAX_DECISION_CHARS} characters`;
  if (notes !== undefined && (typeof notes !== "string" || notes.length > MAX_NOTES_CHARS)) return `notes must be text, up to ${MAX_NOTES_CHARS} characters`;
  return undefined;
}

function decisionOf(args: Args): string {
  return typeof args.decision === "string" ? args.decision.trim() : "";
}

/** The web widget's card for a laptop invoke: the agent and the message as sent (secrets masked
 * for the card, which is stored; the agent gets the message as written). A call the op would refuse
 * anyway is refused before anyone is asked. */
function invokeLaptopCard(args: Args): LaptopCard | { error: string } {
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  const message = typeof args.message === "string" ? args.message : "";
  if (!agent) return { error: "agent is required" };
  if (!message.trim()) return { error: "message is required" };
  // The card must show all of it (review): a laptop's message is capped at what the card holds.
  if (message.length > LAPTOP_MESSAGE_CHARS) return { error: `a message to an Agent Engine agent from a laptop is limited to ${LAPTOP_MESSAGE_CHARS} characters, so the approval card can show all of it` };
  return {
    title: `Send a message to Agent Engine agent ${clip(agent, 60)} from your laptop?`,
    facts: [
      { label: "Agent", value: clip(agent, 60) },
      ...(typeof args.wait === "number" ? [{ label: "Waits up to", value: `${Math.round(args.wait)} s` }] : []),
    ],
    summary: `Your laptop's agent wants to send this to the agent, which may act on it:\n\n${redact(message)}`,
  };
}

/** A resume's approval card: the decision, the pause it answers (`target`, the remote agent's words
 * quoted) and the reviewer notes, as asked by `who` (a Drive's agent, or a laptop's). */
function resumeCard(args: Args, target: string | undefined, who: string): { title: string; message: string } {
  const decision = decisionOf(args);
  const notes = typeof args.notes === "string" && args.notes.trim() ? ` Reviewer notes the agent wrote, sent with it: ${cardQuote(args.notes)}.` : "";
  return {
    title: `Answer an Agent Engine review with ${cardQuote(decision)}?`,
    message: `${who} asked to answer a paused review on your behalf with the decision ${cardQuote(decision)}. ${target ?? ""}${notes} Nothing is answered unless you approve.`,
  };
}

/** The widget's card for a laptop resume: a Drive's card words (resumeCard), with the exact
 * execution the yes answers. */
function resumeLaptopCard(args: Args, target?: string): LaptopCard | { error: string } {
  const decision = decisionOf(args);
  const invalid = resumeArgsError(decision, args.notes);
  if (invalid) return { error: invalid };
  const [execution] = typeof args.id === "string" ? args.id.split("#", 1) : [""];
  if (!execution || !target) return { error: "ae.resume: the execution could not be resolved" };
  const c = resumeCard(args, target, "Your laptop's agent");
  return {
    title: c.title,
    facts: [
      { label: "Execution", value: clip(execution, 120) },
      { label: "Decision", value: clip(decision, MAX_DECISION_CHARS) },
    ],
    summary: c.message,
  };
}

export const AE_OPS = {
  "ae.list": {
    kind: "read",
    capability: "agentEngine",
    laptop: "tape",
    async run(ctx: AdminContext): Promise<AdminResult> {
      if (!agentsOf(ctx)) return { ok: false, error: OFF };
      const agents = (await ctx.store.aeAgents.list()).filter((a) => a.enabled);
      if (!agents.length) return { ok: true, text: "no Agent Engine agents are enabled; a sysop adds them in Settings → Agent Engine agents" };
      return { ok: true, text: agents.map((a) => `${a.id}  ${clip(a.name, 60)}${a.description ? ` — ${clip(a.description, 240)}` : ""}`).join("\n") };
    },
  },

  "ae.invoke": {
    kind: "write",
    capability: "agentEngine",
    laptop: "web-always",
    laptopCard: invokeLaptopCard,
    /** A laptop isn't asked to approve a call to an agent that isn't there (a Drive's call fails in
     * run, as before). */
    async refused(ctx: AdminContext, args: Args, caller: AdminCaller) {
      if (caller.via !== "token") return undefined;
      if (!agentsOf(ctx)) return OFF;
      const found = await enabledAgent(ctx, args.agent);
      return found.ok ? undefined : found.error;
    },
    async run(ctx: AdminContext, caller: AdminCaller, args: Args) {
      const agents = agentsOf(ctx);
      if (!agents) return { ok: false, error: OFF };
      const sessionKey = aeSessionKey(caller);
      if (!sessionKey) return { ok: false, error: NO_SESSION };
      const found = await enabledAgent(ctx, args.agent);
      if (!found.ok) return found;
      const agent = found.agent;
      const message = typeof args.message === "string" ? args.message : "";
      if (!message.trim()) return { ok: false, error: "message is required", target: agent.id };
      if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: `message is over ${MAX_MESSAGE_CHARS} characters`, target: agent.id };
      if (args.wait !== undefined && (typeof args.wait !== "number" || !Number.isFinite(args.wait))) return { ok: false, error: "wait must be a number of seconds", target: agent.id };
      const key = { outfitterSessionId: sessionKey, agentId: agent.id, workspaceId: agent.workspaceId, aeSessionId: aeSessionId(sessionKey, agent.id) };
      const iso = () => new Date(ctx.now?.() ?? Date.now()).toISOString();
      // Recorded before the call, so a stream that breaks still leaves the session to stop.
      await ctx.store.aeSessions.recordInvoke(key, undefined, iso());
      let result: InvokeResult;
      try {
        result = await agents.invoke({
          workspaceId: agent.workspaceId,
          message,
          sessionId: key.aeSessionId,
          outfitterSession: session8(sessionKey),
          ...(typeof args.wait === "number" ? { waitSeconds: args.wait } : {}),
        });
      } catch (err) {
        return { ok: false, error: errorText(err, agent.id), target: `${agent.id}/-` };
      }
      if (result.executionId) await ctx.store.aeSessions.recordInvoke(key, result.executionId, iso());
      return { ok: true, text: invokeText(agent.id, result), target: `${agent.id}/${result.executionId ?? "-"}` };
    },
  },

  "ae.get": {
    kind: "read",
    capability: "agentEngine",
    laptop: "tape",
    async run(ctx: AdminContext, caller: AdminCaller, args: Args) {
      const agents = agentsOf(ctx);
      if (!agents) return { ok: false, error: OFF };
      const own = await ownExecution(ctx, caller, args.executionId);
      if (!own.ok) return own;
      let execution: Execution;
      try {
        execution = await agents.getExecution(own.row.workspaceId, own.executionId);
      } catch (err) {
        return { ok: false, error: errorText(err, own.agent.id) };
      }
      const status = invokeStatus(execution.status);
      const text = aeResult(own.agent.id, [`status: ${status}`, `execution: ${own.executionId}`, statusHint(status) ?? ""], executionLines(execution));
      return { ok: true, text };
    },
  },

  "ae.resume": {
    kind: "approve",
    capability: "agentEngine",
    laptop: "web",
    laptopCard: resumeLaptopCard,
    /** Read before the card: the execution must be this session's, paused, and allow the decision,
     * or the owner isn't asked at all. The label carries what the card shows; the id carries the
     * pause's fingerprint, so the yes answers only the pause the card showed. */
    async target(ctx: AdminContext, args: Args, caller: AdminCaller) {
      const agents = agentsOf(ctx);
      if (!agents) return { error: OFF };
      const own = await ownExecution(ctx, caller, args.executionId);
      if (!own.ok) return { error: own.error };
      const decision = decisionOf(args);
      const invalid = resumeArgsError(decision, args.notes);
      if (invalid) return { error: invalid };
      let execution: Execution;
      try {
        execution = await agents.getExecution(own.row.workspaceId, own.executionId);
      } catch (err) {
        return { error: errorText(err, own.agent.id) };
      }
      if (invokeStatus(execution.status) !== "suspended") return { error: `execution ${own.executionId} is not paused for review (check it with get)` };
      const allowed = allowedDecisions(execution);
      if (allowed.length && !allowed.some((d) => d.toLowerCase() === decision.toLowerCase())) {
        return { error: "decision is not one of the pause's allowed decisions (they are listed by get)" };
      }
      return {
        id: `${own.executionId}#${pauseFingerprint(execution)}`,
        label:
          `Agent Engine agent "${clip(own.agent.name, 60)}" (${own.agent.id}), execution ${own.executionId}. ` +
          `What the remote agent says it is pausing for (its own words, unverified): reason ${cardQuote(execution.suspend_reason)}; context ${cardQuote(execution.suspend_context)}; ` +
          (allowed.length ? `allowed decisions ${cardQuote(allowed.join(", "))}.` : "it declared no allowed decisions, so any decision is accepted."),
      };
    },
    card(args: Args, target?: string) {
      return resumeCard(args, target, "The agent in this session");
    },
    async run(ctx: AdminContext, caller: AdminCaller, args: Args) {
      const agents = agentsOf(ctx);
      if (!agents) return { ok: false, error: OFF };
      // The Drive puts the card's `<executionId>#<fingerprint>` in id after the owner's yes.
      const [ref, fingerprint] = typeof args.id === "string" && args.id.includes("#") ? args.id.split("#", 2) : [args.executionId, undefined];
      if (!fingerprint) return { ok: false, error: "ae.resume runs only after the owner approves its card" };
      const own = await ownExecution(ctx, caller, ref);
      if (!own.ok) return own;
      const target = `${own.agent.id}/${own.executionId}`;
      const decision = decisionOf(args);
      const invalid = resumeArgsError(decision, args.notes);
      if (invalid) return { ok: false, error: invalid, target };
      const notes = typeof args.notes === "string" && args.notes.trim() ? args.notes : undefined;
      let reply: Execution;
      try {
        reply = await agents.resume({
          workspaceId: own.row.workspaceId,
          executionId: own.executionId,
          decision,
          ...(notes ? { notes } : {}),
          outfitterSession: session8(own.row.outfitterSessionId),
          fingerprint,
        });
      } catch (err) {
        return { ok: false, error: errorText(err, own.agent.id), target };
      }
      const status = invokeStatus(reply.status);
      const text = aeResult(own.agent.id, [`resumed execution ${own.executionId} with "${clip(decision, 60)}"`, `status: ${status}`, "check the outcome with get"], executionLines(reply));
      return { ok: true, text, target };
    },
  },

  "ae.close": {
    kind: "write",
    capability: "agentEngine",
    laptop: "tape",
    /** E9.10: a laptop session ending (`/tape off`, exit) stops the Agent Engine sessions it opened,
     * best effort. A Drive's stop when its Outfitter session closes (ae-sessions.ts). */
    async run(ctx: AdminContext, caller: AdminCaller) {
      if (caller.via !== "token") return { ok: false, error: "a Drive's Agent Engine sessions stop when its Outfitter session closes" };
      const key = aeSessionKey(caller);
      if (!key) return { ok: false, error: NO_SESSION };
      const open = await ctx.store.aeSessions.listOpenForSession(key);
      if (!agentsOf(ctx) || !open.length) return { ok: true, text: "no Agent Engine sessions to stop" };
      if (!ctx.aeSessions) return { ok: false, error: "Agent Engine sessions can't be stopped from here" };
      await ctx.aeSessions.closeSession(key);
      const left = (await ctx.store.aeSessions.listOpenForSession(key)).length;
      return { ok: true, text: `stopped ${open.length - left} of ${open.length} Agent Engine session${open.length === 1 ? "" : "s"}`, target: key };
    },
  },
} as const;

let registered = false;

/** Adds the ae.* ops to the registry once per process. */
export function registerAeOps(): void {
  if (registered) return;
  registered = true;
  for (const [name, op] of Object.entries(AE_OPS)) registerAdminOp(name, op as Parameters<typeof registerAdminOp>[1]);
}

registerAeOps();
