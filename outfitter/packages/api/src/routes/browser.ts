// Browser companion routes (docs/specs/chrome-companion.md §9.2). Registered on the link role
// and on web/all. Identity is req.identity (bearer token or IAP); an email in the body is ignored.

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import type { BrowserCapture, BrowserCaptureFailure, BrowserRequest, PiEntry } from "../store/types.ts";
import { isBrowserActionKind, parseBrowserAction, parseBrowserActionResult } from "../browser-action.ts";
import { parseBrowserInspectCreate, parseBrowserInspectResult } from "../browser-inspect.ts";
import { ARCHIVED_ERROR, getSessionOr404 } from "./sessions.ts";

/** Decoded jpeg cap. Larger uploads are 413; the extension recompresses to fit. */
export const BROWSER_CAPTURE_MAX_BYTES = 350_000;

/** Terminal Chrome outcomes. A report of anything else does not finish the request. */
const CAPTURE_FAILURES: readonly BrowserCaptureFailure[] = ["permission_denied", "tab_gone", "too_large"];

function captureFailure(value: unknown): BrowserCaptureFailure | undefined {
  return typeof value === "string" && (CAPTURE_FAILURES as readonly string[]).includes(value)
    ? (value as BrowserCaptureFailure)
    : undefined;
}

const CAPTURE_ENTRY_TYPE = "outfitter.browser.capture";

function callerEmail(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const email = req.identity?.email;
  if (!email) {
    reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }
  return email;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** Entry id is the request id, so a second upload of the same request is one transcript entry. */
function captureEntryId(requestId: string): string {
  return `browser-capture:${requestId}`;
}

function requestView(request: BrowserRequest): {
  id: string;
  requesterEmail: string;
  status: BrowserRequest["status"];
  captureId: string | null;
  createdAt: string;
} {
  return {
    id: request.id,
    requesterEmail: request.requesterEmail,
    status: request.status,
    captureId: request.captureId ?? null,
    ...(request.error ? { error: request.error } : {}),
    ...(isBrowserActionKind(request.kind) ? { kind: request.kind, selector: request.selector } : {}),
    ...(request.kind === "type" ? { text: request.text ?? "" } : {}),
    ...(request.kind === "inspect" ? { kind: "inspect" as const } : {}),
    createdAt: request.createdAt,
  };
}

function pendingView(request: BrowserRequest) {
  return {
    id: request.id,
    requesterEmail: request.requesterEmail,
    status: request.status,
    createdAt: request.createdAt,
    ...(isBrowserActionKind(request.kind) ? { kind: request.kind, selector: request.selector } : {}),
    ...(request.kind === "type" ? { text: request.text ?? "" } : {}),
    ...(request.kind === "inspect" ? { kind: "inspect" as const } : {}),
  };
}

async function sendSkippedResult(ctx: RouteContext, sessionId: string, requestId: string): Promise<void> {
  const request = await ctx.store.browserRequests.findById(sessionId, requestId);
  if (request?.kind === "inspect") {
    await ctx.agentLink.sendInspectResult(sessionId, {
      t: "browser.inspect.result",
      requestId,
      error: "skipped",
    });
    return;
  }
  if (isBrowserActionKind(request?.kind)) {
    await ctx.agentLink.sendActionResult(sessionId, {
      t: "browser.action.result",
      requestId,
      error: "skipped",
    });
    return;
  }
  await ctx.agentLink.sendCaptureResult(sessionId, {
    t: "browser.capture.result",
    requestId,
    error: "skipped",
  });
}

function decodeJpeg(input: string): { ok: true; bytes: Buffer } | { ok: false; status: 400 | 413; error: string } {
  const cleaned = input.replace(/\s/g, "");
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return { ok: false, status: 400, error: "jpegBase64 must be base64" };
  }
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) return { ok: false, status: 400, error: "jpegBase64 is empty" };
  if (bytes.length > BROWSER_CAPTURE_MAX_BYTES) {
    return { ok: false, status: 413, error: `jpeg is over ${BROWSER_CAPTURE_MAX_BYTES} bytes` };
  }
  return { ok: true, bytes };
}

async function appendCaptureEntry(ctx: RouteContext, capture: BrowserCapture): Promise<void> {
  const entryId = captureEntryId(capture.requestId);
  // A retried upload must not send another down-frame. agentd would assign a new seq for the
  // same entry, and the transcript must keep one row per requestId.
  if (await ctx.store.entries.findByEntryId(capture.sessionId, entryId)) return;

  const session = await ctx.store.sessions.findById(capture.sessionId);
  const now = new Date().toISOString();
  const entry: PiEntry = {
    id: entryId,
    parentId: session?.leafId ?? null,
    type: "custom",
    customType: CAPTURE_ENTRY_TYPE,
    timestamp: now,
    data: {
      captureId: capture.id,
      title: capture.title,
      url: capture.url,
      requesterEmail: capture.requesterEmail,
    },
  };
  // While agentd is connected or provisioning it owns the seq. Leaf id moves when that
  // up-frame is stored, not here — a live run is about to write the real leaf.
  if (await ctx.agentLink.sendCaptureEntry(capture.sessionId, entry)) return;

  const seq = (await ctx.store.entries.maxSeq(capture.sessionId)) + 1;
  const inserted = await ctx.store.entries.insertIfNew(capture.sessionId, seq, entry);
  if (inserted) await ctx.store.sessions.update(capture.sessionId, { leafId: entry.id, updatedAt: now });
}

export async function registerBrowserRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.put("/api/sessions/:id/browser/share", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (session.archivedAt) return reply.code(409).send({ error: ARCHIVED_ERROR });
    const email = callerEmail(req, reply);
    if (!email) return;
    const body = asRecord(req.body);
    if (typeof body.tabTitle !== "string" || typeof body.tabUrl !== "string") {
      return reply.code(400).send({ error: "tabTitle and tabUrl are required" });
    }
    const now = new Date().toISOString();
    const result = await ctx.store.browserShares.put({
      sessionId: session.id,
      tabTitle: body.tabTitle,
      tabUrl: body.tabUrl,
      ownerEmail: email,
      createdAt: now,
    });
    if (result.conflict) return reply.code(409).send({ error: "browser share is owned by someone else" });
    return result.share;
  });

  app.delete("/api/sessions/:id/browser/share", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const email = callerEmail(req, reply);
    if (!email) return;
    const result = await ctx.store.browserShares.deleteIfOwner(session.id, email, new Date().toISOString());
    if (result.outcome === "missing") return reply.code(404).send({ error: "no browser share" });
    if (result.outcome === "forbidden") return reply.code(403).send({ error: "not the share owner" });
    for (const requestId of result.skippedIds) {
      await sendSkippedResult(ctx, session.id, requestId);
    }
    return { ok: true };
  });

  app.get("/api/sessions/:id/browser/share", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const share = await ctx.store.browserShares.findBySession(session.id);
    if (!share) return reply.code(404).send({ error: "no browser share" });
    return { tabTitle: share.tabTitle, tabUrl: share.tabUrl, ownerEmail: share.ownerEmail, createdAt: share.createdAt };
  });

  app.post("/api/sessions/:id/browser/requests", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (session.archivedAt) return reply.code(409).send({ error: ARCHIVED_ERROR });
    const email = callerEmail(req, reply);
    if (!email) return;
    const now = new Date().toISOString();
    const request: BrowserRequest = {
      id: randomUUID(),
      sessionId: session.id,
      requesterEmail: email,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const saved = await ctx.store.browserRequests.insertPendingIfShared(session.id, request);
    if (saved === "no_share") return reply.code(409).send({ error: "no browser share" });
    return reply.code(201).send({ id: saved.id, requesterEmail: saved.requesterEmail, status: saved.status });
  });

  app.get("/api/sessions/:id/browser/requests", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const email = callerEmail(req, reply);
    if (!email) return;
    const share = await ctx.store.browserShares.findBySession(session.id);
    // 404, not 403, so a non-owner cannot tell a queue from no share at all.
    if (!share || share.ownerEmail !== email) return reply.code(404).send({ error: "not found" });
    const { status } = req.query as { status?: string };
    if (status !== undefined && status !== "pending") return reply.code(400).send({ error: "status must be pending" });
    const pending = await ctx.store.browserRequests.listPending(session.id);
    return pending.map(pendingView);
  });

  app.get("/api/sessions/:id/browser/requests/:requestId", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const email = callerEmail(req, reply);
    if (!email) return;
    const { requestId } = req.params as { requestId: string };
    const request = await ctx.store.browserRequests.findById(session.id, requestId);
    if (!request) return reply.code(404).send({ error: "not found" });
    const share = await ctx.store.browserShares.findBySession(session.id);
    const owner = share?.ownerEmail === email;
    if (request.requesterEmail !== email && !owner) return reply.code(404).send({ error: "not found" });
    return requestView(request);
  });

  app.post("/api/sessions/:id/browser/requests/:requestId/revoke", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const email = callerEmail(req, reply);
    if (!email) return;
    const share = await ctx.store.browserShares.findBySession(session.id);
    if (!share) return reply.code(404).send({ error: "no browser share" });
    if (share.ownerEmail !== email) return reply.code(403).send({ error: "not the share owner" });
    const { requestId } = req.params as { requestId: string };
    const before = await ctx.store.browserRequests.findById(session.id, requestId);
    const request = await ctx.store.browserRequests.markSkipped(session.id, requestId, new Date().toISOString());
    if (!request) return reply.code(404).send({ error: "not found" });
    // Only the pending → skipped transition unblocks a Drive that is waiting. A done capture
    // stays done, and a second revoke does not send another result.
    if (before?.status === "pending" && request.status === "skipped") {
      await sendSkippedResult(ctx, session.id, request.id);
    }
    return requestView(request);
  });

  // The extension reports permission_denied, tab_gone, or too_large after its one retry.
  // Same result frame as a successful upload, and still no transcript seq — browser.capture.entry
  // is the only path that allocates one. A repeat of this requestId does not send it again.
  app.post("/api/sessions/:id/browser/requests/:requestId/fail", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const email = callerEmail(req, reply);
    if (!email) return;
    const share = await ctx.store.browserShares.findBySession(session.id);
    if (!share) return reply.code(404).send({ error: "no browser share" });
    if (share.ownerEmail !== email) return reply.code(403).send({ error: "not the share owner" });
    const failure = captureFailure(asRecord(req.body).error);
    if (!failure) {
      return reply.code(400).send({ error: "error must be permission_denied, tab_gone, or too_large" });
    }
    const { requestId } = req.params as { requestId: string };
    const existing = await ctx.store.browserRequests.findById(session.id, requestId);
    if (existing && isBrowserActionKind(existing.kind)) {
      return reply.code(409).send({ error: "request is not a capture" });
    }
    const marked = await ctx.store.browserRequests.markFailed(session.id, requestId, failure, new Date().toISOString());
    if (!marked) return reply.code(404).send({ error: "not found" });
    if (marked.request.status === "done" || marked.request.status === "skipped") {
      return reply.code(409).send({ error: "request is not pending" });
    }
    if (marked.transitioned && marked.request.error) {
      await ctx.agentLink.sendCaptureResult(session.id, {
        t: "browser.capture.result",
        requestId: marked.request.id,
        error: marked.request.error,
      });
    }
    return requestView(marked.request);
  });

  app.post("/api/sessions/:id/browser/captures", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (session.archivedAt) return reply.code(409).send({ error: ARCHIVED_ERROR });
    const email = callerEmail(req, reply);
    if (!email) return;
    const share = await ctx.store.browserShares.findBySession(session.id);
    if (!share) return reply.code(404).send({ error: "no browser share" });
    if (share.ownerEmail !== email) return reply.code(403).send({ error: "not the share owner" });
    const body = asRecord(req.body);
    if (typeof body.requestId !== "string" || body.requestId.length === 0) {
      return reply.code(400).send({ error: "requestId is required" });
    }
    if (typeof body.title !== "string" || typeof body.url !== "string") {
      return reply.code(400).send({ error: "title and url are required" });
    }
    const request = await ctx.store.browserRequests.findById(session.id, body.requestId);
    if (!request) return reply.code(404).send({ error: "request not found" });
    if (isBrowserActionKind(request.kind)) return reply.code(409).send({ error: "request is not a capture" });

    // A finished request already has its capture. Return that id and do not write another entry,
    // even when this body carries a different title or a second jpeg. Keyed by requestId.
    if (request.status === "done") {
      const existing = request.captureId
        ? await ctx.store.browserCaptures.findById(session.id, request.captureId)
        : await ctx.store.browserCaptures.findByRequestId(session.id, request.id);
      if (!existing) return reply.code(409).send({ error: "request is not pending" });
      await appendCaptureEntry(ctx, existing);
      return { captureId: existing.id };
    }
    if (request.status !== "pending") return reply.code(409).send({ error: "request is not pending" });
    if (typeof body.jpegBase64 !== "string") return reply.code(400).send({ error: "jpegBase64 is required" });
    const decoded = decodeJpeg(body.jpegBase64);
    if (!decoded.ok) return reply.code(decoded.status).send({ error: decoded.error });

    const now = new Date().toISOString();
    const capture: BrowserCapture = {
      id: randomUUID(),
      sessionId: session.id,
      requestId: request.id,
      ownerEmail: email,
      requesterEmail: request.requesterEmail,
      title: body.title,
      url: body.url,
      bytes: decoded.bytes,
      createdAt: now,
    };
    const saved = await ctx.store.browserCaptures.save(capture, now);
    if (!saved.ok) {
      if (saved.reason === "missing") return reply.code(404).send({ error: "request not found" });
      const done = await ctx.store.browserCaptures.findByRequestId(session.id, request.id);
      if (done) {
        await appendCaptureEntry(ctx, done);
        return { captureId: done.id };
      }
      return reply.code(409).send({ error: "request is not pending" });
    }
    await appendCaptureEntry(ctx, saved.capture);
    // The entry frame above owns the transcript seq. This one only unblocks the waiting Drive,
    // and only for the insert that marked the request done — a repeat upload stays quiet.
    if (saved.inserted) {
      await ctx.agentLink.sendCaptureResult(session.id, {
        t: "browser.capture.result",
        requestId: request.id,
        captureId: saved.capture.id,
        title: saved.capture.title,
        url: saved.capture.url,
      });
    }
    return { captureId: saved.capture.id };
  });

  app.get("/api/sessions/:id/browser/captures/:captureId", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const { captureId } = req.params as { captureId: string };
    const capture = await ctx.store.browserCaptures.findById(session.id, captureId);
    if (!capture) return reply.code(404).send({ error: "capture not found" });
    // image/jpeg plus nosniff: the bytes must not be sniffed and rendered as HTML.
    return reply.header("Content-Type", "image/jpeg").header("X-Content-Type-Options", "nosniff").send(capture.bytes);
  });

  // A click or a type. Same request row as a capture, distinguished by `kind`. Any authenticated
  // caller may ask. Only the share owner runs it. 409 when the session has no share.
  app.post("/api/sessions/:id/browser/actions", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (session.archivedAt) return reply.code(409).send({ error: ARCHIVED_ERROR });
    const email = callerEmail(req, reply);
    if (!email) return;
    const action = parseBrowserAction(req.body);
    if (!action) return reply.code(400).send({ error: "kind must be click or type, with a CSS selector" });
    const now = new Date().toISOString();
    const request: BrowserRequest = {
      id: randomUUID(),
      sessionId: session.id,
      requesterEmail: email,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      kind: action.kind,
      selector: action.selector,
      ...(action.kind === "type" ? { text: action.text } : {}),
    };
    const saved = await ctx.store.browserRequests.insertPendingIfShared(session.id, request);
    if (saved === "no_share") return reply.code(409).send({ error: "no browser share" });
    return reply.code(201).send(requestView(saved));
  });

  // The extension reports the outcome after the user allows it, or after a deny. A deny does not
  // mean the page was clicked: the extension has already refused to run. Owner only.
  app.post("/api/sessions/:id/browser/actions/:requestId/result", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const email = callerEmail(req, reply);
    if (!email) return;
    const share = await ctx.store.browserShares.findBySession(session.id);
    if (!share) return reply.code(404).send({ error: "no browser share" });
    if (share.ownerEmail !== email) return reply.code(403).send({ error: "not the share owner" });
    const outcome = parseBrowserActionResult(req.body);
    if (!outcome) return reply.code(400).send({ error: "result must be {ok:true} or a known error" });
    const { requestId } = req.params as { requestId: string };
    const existing = await ctx.store.browserRequests.findById(session.id, requestId);
    if (!existing || !isBrowserActionKind(existing.kind)) return reply.code(404).send({ error: "not found" });
    const marked = await ctx.store.browserRequests.markActionResult(session.id, requestId, outcome, new Date().toISOString());
    if (!marked) return reply.code(404).send({ error: "not found" });
    if (!marked.transitioned) return reply.code(409).send({ error: "request is not pending" });
    await ctx.agentLink.sendActionResult(session.id, {
      t: "browser.action.result",
      requestId: marked.request.id,
      ...(outcome.ok ? {} : { error: outcome.error }),
    });
    return requestView(marked.request);
  });

  // A DevTools read. Same request row, kind "inspect". No tab id and no selector. 409 without a share.
  // The owner confirms before the extension attaches. This route does not attach anything itself.
  app.post("/api/sessions/:id/browser/inspects", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (session.archivedAt) return reply.code(409).send({ error: ARCHIVED_ERROR });
    const email = callerEmail(req, reply);
    if (!email) return;
    if (!parseBrowserInspectCreate(req.body)) return reply.code(400).send({ error: "inspect takes no arguments" });
    const now = new Date().toISOString();
    const request: BrowserRequest = {
      id: randomUUID(),
      sessionId: session.id,
      requesterEmail: email,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      kind: "inspect",
    };
    const saved = await ctx.store.browserRequests.insertPendingIfShared(session.id, request);
    if (saved === "no_share") return reply.code(409).send({ error: "no browser share" });
    return reply.code(201).send(requestView(saved));
  });

  // The extension reports console lines and the selected element, or a deny. Header values are
  // stripped before the row is stored and before browser.inspect.result is sent. No transcript seq.
  app.post("/api/sessions/:id/browser/inspects/:requestId/result", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const email = callerEmail(req, reply);
    if (!email) return;
    const share = await ctx.store.browserShares.findBySession(session.id);
    if (!share) return reply.code(404).send({ error: "no browser share" });
    if (share.ownerEmail !== email) return reply.code(403).send({ error: "not the share owner" });
    const outcome = parseBrowserInspectResult(req.body);
    if (!outcome) return reply.code(400).send({ error: "result must be console lines or a known error" });
    const { requestId } = req.params as { requestId: string };
    const existing = await ctx.store.browserRequests.findById(session.id, requestId);
    if (!existing || existing.kind !== "inspect") return reply.code(404).send({ error: "not found" });
    const marked = await ctx.store.browserRequests.markInspectResult(session.id, requestId, outcome, new Date().toISOString());
    if (!marked) return reply.code(404).send({ error: "not found" });
    if (!marked.transitioned) return reply.code(409).send({ error: "request is not pending" });
    await ctx.agentLink.sendInspectResult(session.id, outcome.ok
      ? {
          t: "browser.inspect.result",
          requestId: marked.request.id,
          messages: outcome.messages,
          element: outcome.element,
        }
      : {
          t: "browser.inspect.result",
          requestId: marked.request.id,
          error: outcome.error,
        });
    return requestView(marked.request);
  });
}
