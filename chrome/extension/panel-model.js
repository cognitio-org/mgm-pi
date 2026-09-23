// URL building, poll timing, and the other pure decisions for the side panel.
// No Chrome APIs: panel.js, the service worker, and node:test all import this file.
//
// The Floppy page is not the link API. OUTFITTER_API is the link origin the Dongle calls.
// The page the user pairs is https://app.kernal.one or a localhost origin, and that is the
// host Open Floppy uses.

import { isSessionUrl, linkOrigin, originAllowed } from "./protocol.js";

export const POLL_MS = 2000;
export const STEER_MAX = 32000;
export const TRANSCRIPT_LINES = 6;
export const SHARE_UNAVAILABLE = "Share is not available yet";

export const TOKEN_KEY = "OUTFITTER_TOKEN";
export const LINK_KEY = "OUTFITTER_API";
export const PAGE_ORIGIN_KEY = "pageOrigin";
export const PANEL_SESSION_KEY = "panelSessionId";
export const NOTIFIED_UI_KEY = "panelNotifiedUi";
export const PLACEMENTS_KEY = "placements";

export const DEFAULT_PAGE_ORIGIN = "https://app.kernal.one";

const API_PATH = /^\/api\/[A-Za-z0-9_./-]*$/;

/** True when `sessionId` is safe to interpolate into a Floppy path. */
export function sessionIdOk(sessionId) {
  return isSessionUrl(sessionId, `${DEFAULT_PAGE_ORIGIN}/sessions/${sessionId}`);
}

/** Allowlisted page origin the session page connected from, or the production page.
 * A link API host is not a page origin and is not returned. */
export function pageOriginForFloppy(pairedOrigin) {
  if (typeof pairedOrigin === "string" && originAllowed(pairedOrigin)) return new URL(pairedOrigin).origin;
  return DEFAULT_PAGE_ORIGIN;
}

/** `https://app.kernal.one/sessions/<id>` (or the paired localhost origin). Null when the
 * host is not an allowlisted page origin or the id is not a session id. */
export function floppyUrl(pageOrigin, sessionId) {
  if (typeof pageOrigin !== "string" || !originAllowed(pageOrigin)) return null;
  if (!sessionIdOk(sessionId)) return null;
  const origin = new URL(pageOrigin).origin;
  const href = `${origin}/sessions/${sessionId}`;
  return isSessionUrl(sessionId, href) ? href : null;
}

/** Link-role path. `list` ignores the session id. Null when the id is unsafe. */
export function apiPath(kind, sessionId) {
  if (kind === "list") return "/api/sessions";
  if (!sessionIdOk(sessionId)) return null;
  if (kind === "session") return `/api/sessions/${sessionId}`;
  if (kind === "entries") return `/api/sessions/${sessionId}/entries`;
  if (kind === "messages") return `/api/sessions/${sessionId}/messages`;
  if (kind === "ui-response") return `/api/sessions/${sessionId}/ui-response`;
  if (kind === "abort") return `/api/sessions/${sessionId}/abort`;
  return null;
}

/** Absolute link URL. The Dongle never goes in the URL. A non-http origin is null. */
export function linkUrl(originValue, path) {
  const origin = linkOrigin(originValue);
  if (!origin || typeof path !== "string") return null;
  if (path.includes("..") || path.includes("outf_") || path.includes("?") || path.includes("#") || path.includes("\\")) return null;
  if (!API_PATH.test(path)) return null;
  return `${origin}${path}`;
}

/** Milliseconds until the next poll, or null when the document is not visible. */
export function pollDelay(visibilityState) {
  return visibilityState === "visible" ? POLL_MS : null;
}

function clip(text, max) {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return line.slice(0, max);
}

export function floppyLabel(session) {
  if (!session || typeof session !== "object") return "Untitled";
  const name = typeof session.name === "string" ? session.name.trim() : "";
  return name || "Untitled";
}

export function runStateLabel(session) {
  if (!session || typeof session !== "object") return "no run";
  if (typeof session.runState !== "string" || session.runState.trim() === "") return "no run";
  return session.runState.trim();
}

export function stateLine(session) {
  const base = `${floppyLabel(session)} - ${runStateLabel(session)}`;
  if (
    session &&
    session.runState === "failed" &&
    typeof session.runStateReason === "string" &&
    session.runStateReason.trim() !== ""
  ) {
    return `${base} - ${clip(session.runStateReason, 160)}`;
  }
  return base;
}

export function sessionChoiceLabel(session) {
  return `${floppyLabel(session)} - ${runStateLabel(session)}`;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function firstToolName(content) {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "toolCall" && typeof block.name === "string") return block.name;
  }
  return "";
}

function entryLine(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message;
    if (message.role === "user") {
      const text = clip(contentText(message.content), 180);
      return text ? `You: ${text}` : null;
    }
    if (message.role === "assistant") {
      const text = clip(contentText(message.content), 180);
      if (text) return `Floppy: ${text}`;
      const tool = clip(firstToolName(message.content), 80);
      return tool ? `Tool: ${tool}` : null;
    }
    return null;
  }
  if (entry.type === "custom" && entry.customType === "outfitter.browser.capture") {
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    const title = typeof data.title === "string" ? clip(data.title, 120) : "";
    return title ? `Captured: ${title}` : "Captured a tab";
  }
  return null;
}

/** Last few plain-text lines, oldest first, so the newest sits at the bottom. No jpeg. */
export function transcriptLines(entries, limit = TRANSCRIPT_LINES) {
  if (!Array.isArray(entries)) return [];
  const lines = [];
  for (const entry of entries) {
    const line = entryLine(entry);
    if (line) lines.push(line);
  }
  const count = typeof limit === "number" && limit > 0 ? limit : TRANSCRIPT_LINES;
  return lines.slice(-count);
}

/** `{text, behavior:"followUp"}`, or null when there is nothing to send. */
export function steerBody(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > STEER_MAX) return null;
  return { text: trimmed, behavior: "followUp" };
}

function approvalTitle(request, method) {
  return clip(typeof request.title === "string" && request.title.trim() !== "" ? request.title : method, 500);
}

/** Same answers as the web UiRequestPanel: select, confirm, and input. `editor` is named
 * so the panel can say to open the Floppy. Anything else is not an approval. */
export function approvalView(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const id = request.id;
  const method = request.method;
  if (typeof id !== "string" || id === "" || id.length > 200) return null;
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return null;
  const title = approvalTitle(request, method);
  if (method === "select") {
    const options = Array.isArray(request.options)
      ? request.options.filter((option) => typeof option === "string" && option.trim() !== "").slice(0, 30).map((option) => clip(option, 200))
      : [];
    if (options.length === 0) return { id, method, title, unsupported: true };
    return { id, method, title, options };
  }
  if (method === "confirm") {
    const message = typeof request.message === "string" ? clip(request.message, 2000) : "";
    return { id, method, title, message };
  }
  if (method === "input") {
    const placeholder = typeof request.placeholder === "string" ? clip(request.placeholder, 200) : "";
    return { id, method, title, placeholder };
  }
  return { id, method, title, unsupported: true };
}

/** POST /ui-response body. Confirm is a boolean; select and input are strings. */
export function uiResponseBody(id, value) {
  if (typeof id !== "string" || id === "") return null;
  if (typeof value !== "string" && typeof value !== "boolean") return null;
  return { id, value };
}

/** Notify only when the panel is closed and this request id has not been notified yet. */
export function shouldNotifyApproval(panelOpen, requestId, notifiedId) {
  if (panelOpen) return false;
  if (typeof requestId !== "string" || requestId === "") return false;
  if (requestId === notifiedId) return false;
  return true;
}

export function approvalNotificationId(requestId) {
  if (typeof requestId !== "string" || requestId === "" || requestId.length > 180) return null;
  return `approval:${requestId}`;
}

export function notificationCopy(name, title) {
  const heading = clip(typeof name === "string" ? name : "", 80) || "Floppy";
  const message = clip(typeof title === "string" ? title : "", 180) || "Approval waiting";
  return { title: heading, message };
}

/** Error text safe to put in the panel. A body that echoes a Dongle is dropped. */
export function publicError(status, body) {
  let message = "";
  if (body && typeof body === "object" && typeof body.error === "string") message = body.error.trim();
  if (message.includes("outf_") || message.length > 240) message = "";
  if (status === 401) return "The Dongle was rejected. Check the options page.";
  if (status === 404) return message || "Not found.";
  if (status === 413) return message || "That message is too long.";
  if (message) return message;
  return "The link origin returned an error.";
}

export function shareMessage(action, sessionId) {
  if (!sessionIdOk(sessionId)) return null;
  if (action === "share") return { t: "share-active", sessionId };
  if (action === "revoke") return { t: "revoke-share", sessionId };
  if (action === "status") return { t: "share-status", sessionId };
  return null;
}

/** Status line from a service-worker reply. `action` is share, revoke, or status. */
export function shareStatusText(response, action) {
  if (!response || typeof response !== "object") return SHARE_UNAVAILABLE;
  const status = response.status;
  if (status === "permission-denied" || status === "permission_denied" || response.error === "permission_denied") {
    return "Permission denied";
  }
  if (status === "shared" || (action === "share" && response.ok === true && (status === undefined || status === null))) {
    const title = typeof response.tabTitle === "string" ? clip(response.tabTitle, 120) : "";
    return title ? `Shared: ${title}` : "Shared";
  }
  if (
    status === "not-shared" ||
    status === "not_shared" ||
    (action === "revoke" && response.ok === true) ||
    (action === "status" && response.ok === true && (status === undefined || status === null))
  ) {
    return "Not shared";
  }
  return SHARE_UNAVAILABLE;
}

/** Keep a known status when a status poll gets no answer (the share slice may be absent). */
export function nextShareStatus(previous, response, action) {
  const text = shareStatusText(response, action);
  if (text === SHARE_UNAVAILABLE && action === "status" && typeof previous === "string" && previous !== "" && previous !== SHARE_UNAVAILABLE) {
    return previous;
  }
  return text;
}

/** "Capturing for <email>" only when the worker reports one. Otherwise null. */
export function capturingText(response) {
  if (!response || typeof response !== "object") return null;
  const email = response.capturingEmail ?? response.capturing;
  if (typeof email !== "string") return null;
  const trimmed = clip(email, 320);
  if (trimmed === "" || trimmed.includes(" ")) return null;
  return `Capturing for ${trimmed}`;
}

/** Focus the recorded tab, or open a new one. */
export function openFloppyPlan(record, tabStillThere) {
  if (tabStillThere && record && typeof record === "object" && typeof record.tabId === "number") {
    return {
      action: "focus",
      tabId: record.tabId,
      windowId: typeof record.windowId === "number" ? record.windowId : null,
    };
  }
  return { action: "open" };
}

/** Placement row written after Open Floppy creates a tab. Matches the service worker's record. */
export function placementRecord(sessionId, tab) {
  if (!sessionIdOk(sessionId)) return null;
  if (!tab || typeof tab !== "object" || typeof tab.id !== "number" || typeof tab.windowId !== "number") return null;
  return {
    sessionId,
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
  };
}
