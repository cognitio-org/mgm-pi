// Creating a session and posting its first message: the one path POST /api/sessions
// (routes/sessions.ts) and an A2A task (a2a/tasks.ts) both take, so a session made either way
// is the same document with the same mail behind it (E9 §5.3).

import { randomUUID } from "node:crypto";
import type { AgentLink } from "./agentlink.ts";
import type { MailService } from "./mail.ts";
import { pinnableModel } from "./session-model.ts";
import type { Run, Session, Store } from "./store/types.ts";

export interface SessionCreateDeps {
  store: Store;
  mail: MailService;
  agentLink: AgentLink;
}

export interface NewSessionInput {
  /** Who the session runs as (Session.ownerEmail). */
  ownerEmail: string | undefined;
  guruId: string;
  /** Omitted or null: a non-coding session (protocol.md): no clone, no branch. */
  repo?: string | null;
  baseBranch?: string;
  /** Used as given when `repo` is set; otherwise `outfitter/<8 hex>`. The caller decides whether a
   * caller-chosen branch is acceptable (the A2A path never passes one from its client). */
  branch?: string;
  prompt: string;
  name?: string;
  /** The floppy's model. Omitted: the tape's model as it is now, pinned to the floppy, so a later
   * edit of the tape doesn't move it (src/session-model.ts). See src/laptop.ts's E2.8 preflight. */
  model?: string;
  /** E9 §5: an A2A task's session. */
  origin?: "a2a";
  a2aTokenId?: string;
}

export interface CreateSessionOptions {
  /** The first mail's id (MailService.post's `id`), so a turn waiter can be registered on it
   * before it is posted (turns.ts). */
  mailId?: string;
  /** Runs after the session is stored and before its first mail is posted. */
  beforeMail?: (session: Session) => Promise<void>;
  /** Don't wait for the wake (MailService.post's `background`): the A2A path must answer within
   * seconds whatever a sandbox start costs. The mail is stored first either way. */
  backgroundWake?: boolean;
}

export interface PostUserMailOptions {
  id?: string;
  backgroundWake?: boolean;
}

/** The session document POST /api/sessions has always stored. */
export function buildSession(input: NewSessionInput, now = new Date().toISOString()): Session {
  const repo = input.repo ?? null;
  return {
    id: randomUUID(),
    name: input.name,
    // Only archive, restore and format check it -- see Session.ownerEmail's doc comment and
    // EPIC.md's E2.2 note (finding #5, docs/reports/security-review-pr1.md).
    ownerEmail: input.ownerEmail,
    guruId: input.guruId,
    repo,
    baseBranch: repo ? input.baseBranch : undefined,
    branch: repo ? (input.branch ?? `outfitter/${randomUUID().slice(0, 8)}`) : undefined,
    prompt: input.prompt,
    modelOverride: input.model,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.a2aTokenId ? { a2aTokenId: input.a2aTokenId } : {}),
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Stores the session, then posts its prompt as the owner's first mail and tries to deliver it.
 * Validation (the guru exists, the prompt's length) is the caller's. */
export async function createSession(
  deps: SessionCreateDeps,
  input: NewSessionInput,
  opts: CreateSessionOptions = {},
): Promise<{ session: Session; run: Run | null }> {
  // The tape only seeds a new floppy's model. A tape with no model leaves it to the owner's central
  // settings (applied by agentd); the floppy then keeps what its transcript records.
  const model = input.model ?? pinnableModel(await deps.store.gurus.findById(input.guruId));
  const session = buildSession({ ...input, model });
  await deps.store.sessions.insert(session);
  if (opts.beforeMail) await opts.beforeMail(session);
  const run = await postUserMail(deps, session.id, input.ownerEmail, input.prompt, undefined, {
    id: opts.mailId,
    backgroundWake: opts.backgroundWake,
  });
  return { session, run };
}

/** Stores a person's message as mail (so a failed wake or a run that dies before it is ready can't
 * lose it); MailService.post also makes the one inline wake attempt. Returns the session's run, or
 * null when that wake failed -- the message is queued either way and Cloud Tasks / the /tick sweep
 * keep trying, so the caller must not retry (it would enqueue the text twice). */
export async function postUserMail(
  deps: SessionCreateDeps,
  sessionId: string,
  email: string | undefined,
  text: string,
  behavior?: "steer" | "followUp",
  opts: PostUserMailOptions = {},
): Promise<Run | null> {
  await deps.mail.post(
    { sessionId, from: { kind: "user", email }, text, behavior, ...(opts.id ? { id: opts.id } : {}) },
    { background: opts.backgroundWake },
  );
  await deps.agentLink.deliverMailForSession(sessionId);
  return deps.store.runs.findActiveForSession(sessionId);
}
