// Owner-scoped approvals for a laptop's ops (E9.9, docs/protocol.md "Laptop approvals").
//
// On a laptop the agent's shell runs as the person: it can read the Dongle and send `confirmed:
// true` itself, so a TUI confirm is not a boundary for anything that reaches other people (a shared
// memory, and in #354 an Agent Engine agent). In a Drive the boundary is the web approval card
// (approvals.ts); a laptop has no Outfitter session or run to hang that card on, so its asks wait
// here, keyed by owner, and the owner answers them in the web app's approval widget (a person under
// IAP, never a Dongle: decideLaptopApproval).
//
// The flow, for any op registered with `webApproval: true` (ops.ts runAdminOp):
//   1. The Dongle calls the op. It needs a yes, so the api stores a pending approval bound to the
//      owner, the op, a digest of the exact args, and the laptop session (and repo) it came from,
//      and answers {ok:false, needsApproval:true, approvalId}. The same ask again reuses it.
//   2. Kernal polls `approvals.get {id}` -> {state: pending|approved|denied|expired|used}.
//   3. Kernal reruns the same op and args with `approvalId` in the body. consumeLaptopApproval
//      marks it used in one conditional write (approved, same owner, digest and origin, unexpired),
//      and only then does the op run, once.
// `confirmed` from a Dongle never counts for these ops.

import { createHash, randomUUID } from "node:crypto";
import type { LaptopApproval, LaptopApprovalMatch, Store } from "../store/types.ts";
import type { LaptopContext } from "../agentengine/identity.ts";
import { HIDDEN } from "../untrusted.ts";
import { UUID as APPROVAL_ID } from "./render.ts";
import { isPerson } from "./approvals.ts";

export const LAPTOP_APPROVAL_TTL_MS = 10 * 60_000;
/** Pending asks an owner may have at once: a runaway agent can't bury the widget. */
export const MAX_PENDING_PER_OWNER = 10;
const MAX_TITLE = 120;
export const MAX_SUMMARY = 6_000;

export type LaptopApprovalState = "pending" | "approved" | "denied" | "expired" | "used";

/** JSON with object keys sorted at every level (undefined dropped), so equal args digest equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** sha256 hex of the canonical {op, args}: what an approval says yes to. */
export function argsDigest(op: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ op, args })).digest("hex");
}

/** The state a laptop sees: an unanswered or unused approval past its time reads `expired`. */
export function laptopApprovalState(a: Pick<LaptopApproval, "state" | "expiresAt">, nowIso: string): LaptopApprovalState {
  if ((a.state === "pending" || a.state === "approved") && a.expiresAt <= nowIso) return "expired";
  return a.state;
}

const iso = (now: number) => new Date(now).toISOString();
const lower = (email: string) => email.trim().toLowerCase();

function matchOf(ownerEmail: string, op: string, args: Record<string, unknown>, laptop: LaptopContext): LaptopApprovalMatch {
  return { ownerEmail: lower(ownerEmail), op, argsDigest: argsDigest(op, args), laptopSessionId: laptop.sessionId, ...(laptop.repo ? { repo: laptop.repo } : {}) };
}

/** One of `ownerEmail`'s approvals, or null: another owner's id reads as not found. */
async function ownApproval(store: Pick<Store, "laptopApprovals">, id: string, ownerEmail: string): Promise<LaptopApproval | null> {
  const held = await store.laptopApprovals.get(id);
  return held && held.ownerEmail === lower(ownerEmail) ? held : null;
}

/** The card's text: hidden characters (untrusted.ts) shown as a visible `�`, so nothing can hide
 * there (an op should refuse such text before it asks; memory.save does), capped by code point
 * (never half a pair). */
function cardText(text: string, max: number): string {
  const flat = text.replace(/\r\n?/g, "\n").replace(HIDDEN, (c) => (c === "\n" || c === "\t" ? c : "�"));
  const points = [...flat];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : flat;
}

/** What the widget shows for an op (its `laptopCard`). `facts` are the api's words; `summary` is the
 * content the agent sent, shown in a box labelled as the agent's. */
export interface LaptopCard {
  title: string;
  facts?: Array<{ label: string; value: string }>;
  summary: string;
}

export interface CreateLaptopApproval extends LaptopCard {
  ownerEmail: string;
  op: string;
  args: Record<string, unknown>;
  laptop: LaptopContext;
  now?: number;
}

const MAX_FACTS = 6;
const MAX_FACT = 200;

/** After a yes, the laptop has at least this long to rerun (its poll is every 3 s). */
export const APPROVED_USE_MS = 2 * 60_000;

/** Stores a pending approval for this ask, or returns the one already pending for the same ask. */
export async function createLaptopApproval(store: Pick<Store, "laptopApprovals">, ask: CreateLaptopApproval): Promise<{ ok: true; approval: LaptopApproval } | { ok: false; error: string }> {
  const now = ask.now ?? Date.now();
  const match = matchOf(ask.ownerEmail, ask.op, ask.args, ask.laptop);
  const held = await store.laptopApprovals.findPending(match, iso(now));
  if (held) return { ok: true, approval: held };
  const pending = await store.laptopApprovals.listPending(match.ownerEmail, iso(now), MAX_PENDING_PER_OWNER);
  if (pending.length >= MAX_PENDING_PER_OWNER) {
    return { ok: false, error: `${MAX_PENDING_PER_OWNER} approvals are already waiting; answer them in the Outfitter web app first` };
  }
  const approval: LaptopApproval = {
    id: randomUUID(),
    ownerEmail: match.ownerEmail,
    op: ask.op,
    argsDigest: match.argsDigest,
    title: cardText(ask.title, MAX_TITLE),
    ...(ask.facts?.length
      ? { facts: ask.facts.slice(0, MAX_FACTS).map((f) => ({ label: cardText(f.label, 40), value: cardText(f.value, MAX_FACT) })) }
      : {}),
    summary: cardText(ask.summary, MAX_SUMMARY),
    origin: { laptopSessionId: ask.laptop.sessionId, ...(ask.laptop.repo ? { repo: ask.laptop.repo } : {}) },
    state: "pending",
    createdAt: iso(now),
    expiresAt: iso(now + LAPTOP_APPROVAL_TTL_MS),
  };
  await store.laptopApprovals.insert(approval);
  return { ok: true, approval };
}

export interface ConsumeLaptopApproval {
  ownerEmail: string;
  op: string;
  args: Record<string, unknown>;
  approvalId: unknown;
  /** The rerun's laptop context: it must be the session (and repo) the ask came from. */
  laptop: LaptopContext;
  now?: number;
}

/**
 * The one check before a laptop op runs on a web yes (memory.save here, `ae.*` in #354): approved,
 * the same owner, op, args digest and laptop origin, unexpired, and unused. Marks it used in the same
 * conditional write, so it runs once. The error never says whether another owner's id exists.
 */
export async function consumeLaptopApproval(
  store: Pick<Store, "laptopApprovals">,
  use: ConsumeLaptopApproval,
): Promise<{ ok: true; approvalId: string } | { ok: false; error: string; state?: LaptopApprovalState }> {
  const now = use.now ?? Date.now();
  if (typeof use.approvalId !== "string" || !APPROVAL_ID.test(use.approvalId)) return { ok: false, error: "approvalId is not an approval id" };
  const match = matchOf(use.ownerEmail, use.op, use.args, use.laptop);
  if (await store.laptopApprovals.consume(use.approvalId, match, iso(now))) return { ok: true, approvalId: use.approvalId };
  // Why not, for the person: read after the failed write, so nothing here decides anything.
  const held = await ownApproval(store, use.approvalId, match.ownerEmail);
  if (!held) return { ok: false, error: "no such approval" };
  const state = laptopApprovalState(held, iso(now));
  if (state !== "approved") {
    const why: Record<Exclude<LaptopApprovalState, "approved">, string> = {
      pending: "not approved yet; approve it in the Outfitter web app",
      denied: "denied in the Outfitter web app",
      expired: "that approval expired; ask again",
      used: "that approval was already used; ask again",
    };
    return { ok: false, error: why[state], state };
  }
  return { ok: false, error: "that approval was for a different request (op, arguments or laptop session); ask again", state };
}

/** What the widget shows for one ask. Every string is the api's or clipped; the page escapes it. */
export interface LaptopApprovalView {
  id: string;
  op: string;
  title: string;
  facts?: Array<{ label: string; value: string }>;
  summary: string;
  origin: { laptopSessionId: string; repo?: string };
  createdAt: string;
  expiresAt: string;
}

/** Only the fields above: never the owner, the digest or the decision. */
export function laptopApprovalView({ id, op, title, facts, summary, origin, createdAt, expiresAt }: LaptopApproval): LaptopApprovalView {
  return { id, op, title, ...(facts?.length ? { facts: facts.map((f) => ({ ...f })) } : {}), summary, origin: { ...origin }, createdAt, expiresAt };
}

/** The signed-in person's pending asks, for the widget; never a Dongle's (it is the agent's). */
export async function pendingLaptopApprovals(store: Pick<Store, "laptopApprovals">, viewer: { email?: string; viaToken?: boolean } | undefined, now = Date.now()): Promise<LaptopApprovalView[] | undefined> {
  if (!isPerson(viewer)) return undefined;
  return (await store.laptopApprovals.listPending(lower(viewer.email), iso(now), MAX_PENDING_PER_OWNER)).map(laptopApprovalView);
}

/**
 * Records the owner's answer from the web widget: a person (IAP or dev), never a Dongle, and only
 * the ask's owner. Audited by the route. Another owner's id reads as not found.
 */
export async function decideLaptopApproval(
  store: Pick<Store, "laptopApprovals">,
  id: string,
  decider: { email?: string; viaToken?: boolean } | undefined,
  approved: boolean,
  now = Date.now(),
): Promise<{ ok: true; approval: LaptopApproval } | { ok: false; status: number; error: string }> {
  if (!isPerson(decider)) {
    return decider?.email
      ? { ok: false, status: 403, error: "approve laptop requests in the Outfitter web app, not with a token" }
      : { ok: false, status: 401, error: "sign in to answer approvals" };
  }
  if (!APPROVAL_ID.test(id)) return { ok: false, status: 404, error: "no such approval" };
  const email = lower(decider.email);
  const held = await ownApproval(store, id, email);
  if (!held) return { ok: false, status: 404, error: "no such approval" };
  // A yes in the last seconds still leaves the laptop time to poll and rerun (review: near expiry).
  const soon = iso(now + APPROVED_USE_MS);
  const useBy = approved && soon > held.expiresAt ? soon : held.expiresAt;
  if (!(await store.laptopApprovals.decide(id, email, approved ? "approved" : "denied", iso(now), useBy))) {
    return { ok: false, status: 409, error: "that approval is no longer pending" };
  }
  return { ok: true, approval: { ...held, state: approved ? "approved" : "denied", decidedBy: email, decidedAt: iso(now), expiresAt: useBy } };
}

/** `approvals.get` for a laptop: the state of one of the caller's own asks. */
export async function laptopApprovalStatus(store: Pick<Store, "laptopApprovals">, ownerEmail: string, id: unknown, now = Date.now()): Promise<{ ok: true; state: LaptopApprovalState } | { ok: false; error: string }> {
  if (typeof id !== "string" || !APPROVAL_ID.test(id)) return { ok: false, error: "id is required (an approval id)" };
  const held = await ownApproval(store, id, ownerEmail);
  if (!held) return { ok: false, error: "no such approval" };
  return { ok: true, state: laptopApprovalState(held, iso(now)) };
}
