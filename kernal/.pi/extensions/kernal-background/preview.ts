/**
 * Previews (#217): open a server a job started from the person's browser.
 *
 * On the desktop the server is already reachable: the URL is http://localhost:<port>. In a Drive,
 * agentd owns the way out (drive-previews.md): it binds a loopback listener, passes its port and a
 * token in OUTFITTER_PREVIEW_PORT / OUTFITTER_PREVIEW_TOKEN, and on request runs a local proxy and
 * an ngrok agent for that port, then asks the api for the public https://<id>.kernal.run URL. This
 * file is the client side of that listener, plus the checks both modes share.
 */
import { connect } from "node:net";

export const PREVIEW_TOKEN_HEADER = "x-outfitter-preview-token";

export interface PreviewResult {
  url: string;
  port: number;
  expiresAt?: string;
}

export class PreviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A Drive's preview listener, from the environment agentd pinned for pi. */
export interface DriveEndpoint {
  port: number;
  token: string;
}

export function driveEndpoint(env: NodeJS.ProcessEnv = process.env): DriveEndpoint | undefined {
  const port = Number(env.OUTFITTER_PREVIEW_PORT);
  const token = env.OUTFITTER_PREVIEW_TOKEN ?? "";
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || token === "") return undefined;
  return { port, token };
}

/** True inside a Drive (Outfitter), where the desktop's localhost answer would be wrong. */
export function inDrive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OUTFITTER_RUN_ID || env.OUTFITTER_SESSION_ID || env.OUTFITTER_PREVIEW_PORT);
}

export function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Whether something accepts TCP connections on 127.0.0.1:<port>. */
export function probePort(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Desktop: the server is on this machine. */
export async function desktopPreview(port: number): Promise<PreviewResult> {
  if (!(await probePort(port))) throw new PreviewError("nothing-listening", `nothing is listening on port ${port} yet`);
  return { url: `http://localhost:${port}`, port };
}

async function call(ep: DriveEndpoint, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${ep.port}${path}`, {
    method,
    headers: { [PREVIEW_TOKEN_HEADER]: ep.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: any) => {
    throw new PreviewError("unavailable", `the Drive's preview service didn't answer (${err?.name === "TimeoutError" ? "timed out" : err?.message ?? err})`);
  });
  let data: any;
  try { data = await res.json(); } catch { data = undefined; }
  if (!res.ok) {
    throw new PreviewError(String(data?.error ?? `http-${res.status}`), String(data?.detail ?? data?.error ?? `HTTP ${res.status}`));
  }
  return data;
}

/** Drive: agentd opens the tunnel and returns the public URL. */
export async function drivePreview(ep: DriveEndpoint, port: number, opts: { jobId?: string; share?: boolean } = {}): Promise<PreviewResult> {
  const data = await call(ep, "POST", "/previews", { port, ...(opts.jobId ? { jobId: opts.jobId } : {}), ...(opts.share ? { share: true } : {}) });
  if (typeof data?.url !== "string") throw new PreviewError("failed", "the Drive's preview service returned no URL");
  return { url: data.url, port, ...(typeof data.expiresAt === "string" ? { expiresAt: data.expiresAt } : {}) };
}

export async function closeDrivePreview(ep: DriveEndpoint, port: number): Promise<void> {
  await call(ep, "DELETE", `/previews/${port}`, undefined, 15_000);
}

/** What the model should do about each failure, in one line. */
export function explainPreviewError(err: PreviewError): string {
  switch (err.code) {
    case "nothing-listening": return `${err.message}. Check the job's log (background logs) to see whether the server started, and on which port.`;
    case "port-not-allowed": return `${err.message}. Use the port the server itself listens on (1024-65535).`;
    case "not-configured": return `Previews aren't enabled for this Drive (${err.message}).`;
    case "timeout": return `The preview tunnel didn't come up in time (${err.message}). Try again once.`;
    case "share-not-allowed": return "Public share links are made by the person, from the session page. Give them the private link instead; they can share it from there.";
    case "too-many": return `Too many previews for this Drive right now (${err.message}). Close ones you no longer need (preview close: true).`;
    default: return err.message;
  }
}
