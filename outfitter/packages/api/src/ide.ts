// Browser IDE (#242/#273, docs/specs/browser-ide.md §3-§4): asking a Drive to open its IDE, the
// same way whoever asks. The session page's "Open in VS Code" (routes/ide.ts, after its own owner
// check) and the model's `vscode` tool (agentlink's `ide.request`, after its own limit) both land
// here, so both get the same checks and the same owner-and-sysops endpoint. Asking never widens who
// can get in: that's fixed at ngrok's edge by PreviewService.openIde.
import { randomUUID } from "node:crypto";
import type { PreviewService } from "./previews.ts";
import { IDE_PREVIEW_PORT } from "./previews.ts";
import type { DownMessage, Run, Session, Store } from "./store/types.ts";

/** An IDE can be opened only on a Drive that's up for good (as for share links). */
export const IDE_OPENABLE = new Set(["running", "idle"]);
const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
const PENDING = new Set(["requested", "installing", "starting"]);
/** A pending request older than this probably lost a frame; a new ask replaces it. */
export const IDE_PENDING_FRESH_MS = 90_000;

/** GET /api/sessions/:id/ide's body. */
export function ideView(run: Run | null) {
  const available = run?.browserIde === true && LIVE.has(run.state);
  if (!available || !run?.ide) return { available, state: "none" as const };
  return {
    available,
    state: run.ide.state,
    ...(run.ide.state === "ready" && run.ide.url?.startsWith("https://") ? { url: run.ide.url } : {}),
    ...(run.ide.detail ? { detail: run.ide.detail } : {}),
    updatedAt: run.ide.updatedAt,
  };
}

export type IdeAsk =
  | { status: 200 | 202; body: ReturnType<typeof ideView>; asked: boolean }
  | { status: 409 | 503; error: string };

/**
 * Starts (or reuses) the Drive's IDE. 200: it's open and its endpoint is still there. 202: it's on
 * its way, either just asked (`asked`) or already pending and recent. `send` delivers `ide.open`
 * (agentLink.send from the web role, the socket itself from the link role).
 */
export async function askForIde(
  deps: { store: Store; previews: PreviewService; now?: () => number },
  session: Session,
  run: Run | null,
  send: (message: DownMessage) => Promise<void> | void,
): Promise<IdeAsk> {
  const now = deps.now ?? Date.now;
  if (!session.ownerEmail) return { status: 409, error: "this floppy has no owner on record, so its IDE has no one to let in" };
  if (!deps.previews.enabled) return { status: 503, error: "previews aren't enabled, and the IDE is served through them" };
  if (!run || !IDE_OPENABLE.has(run.state)) return { status: 409, error: "the Drive isn't running" };
  if (run.browserIde !== true) return { status: 409, error: "this Drive has no IDE: turn on \"VS Code in the browser\" on its Tape, then start a new Drive" };
  // Already open: answer with it, if its endpoint really is still there.
  if (run.ide?.state === "ready" && run.ide.url) {
    const open = await deps.store.previews.findOpen(run.id, IDE_PREVIEW_PORT, false);
    if (open?.kind === "ide" && open.url === run.ide.url) return { status: 200, body: ideView(run), asked: false };
  }
  // Already on its way: don't start a second request (a double click, the model and a click together).
  if (run.ide && PENDING.has(run.ide.state) && now() - Date.parse(run.ide.updatedAt) < IDE_PENDING_FRESH_MS) {
    return { status: 202, body: ideView(run), asked: false };
  }
  const reqId = randomUUID();
  const updated = await deps.store.runs.update(run.id, { ide: { reqId, state: "requested", updatedAt: new Date(now()).toISOString() } });
  await send({ t: "ide.open", reqId });
  return { status: 202, body: ideView(updated ?? run), asked: true };
}
