// DevTools attach on the one shared tab.
// No Chrome APIs: the service worker and node:test both import this file.
// Console text is kept. Cookie and Authorization header values are not.
// The selected element is a short description, never the DOM and never network headers.

export const CONSOLE_LIMIT = 40;
export const CONSOLE_TEXT_MAX = 500;
export const INSPECT_PROMPTS_KEY = "inspectPrompts";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TAG = /^[a-z][a-z0-9-]*$/;
const TOKEN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const ELEMENT_DESCRIPTION = /^[a-z][a-z0-9-]*(?:#[A-Za-z_][A-Za-z0-9_-]{0,63})?(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,8}$/;

const LEVELS = new Set([
  "log",
  "info",
  "warn",
  "warning",
  "error",
  "debug",
  "trace",
  "dir",
  "table",
  "count",
  "timeEnd",
  "assert",
  "clear",
  "exception",
]);

/** Runs in the page through Runtime.evaluate. Returns tag, id, and classes, or null. Not the DOM. */
export const SELECTED_ELEMENT_EXPRESSION = `(function () {
  var el = typeof $0 === "undefined" ? null : $0;
  if (!el || el.nodeType !== 1 || typeof el.tagName !== "string") return null;
  var raw = typeof el.className === "string" ? el.className : "";
  var classes = raw.split(/\\s+/).filter(Boolean).slice(0, 8);
  return { tag: el.tagName, id: typeof el.id === "string" ? el.id : "", classes: classes };
})()`;

/** Header values are replaced. The header name can stay so a reader can see that it was removed. */
export function redactHeaderText(text) {
  if (typeof text !== "string") return "";
  return text.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
    "$1: [redacted]",
  );
}

const HEADER_KEY = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;

/** Walk a CDP payload. A header object loses its value. Network headers are not copied out. */
export function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactHeaderText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  const name = typeof value.name === "string" ? value.name : typeof value.header === "string" ? value.header : "";
  const headerPair = HEADER_KEY.test(name);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (HEADER_KEY.test(key) || (headerPair && (key === "value" || key === "headerValue"))) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactSecrets(item, seen);
  }
  return out;
}

function preview(value) {
  const clean = redactSecrets(value);
  if (typeof clean === "string") return clean;
  if (clean === undefined || clean === null) return "";
  try {
    return JSON.stringify(clean);
  } catch {
    return "";
  }
}

export function consoleLine(level, text) {
  const raw = typeof level === "string" ? level : "log";
  const kind = raw === "warning" ? "warn" : LEVELS.has(raw) ? raw : "log";
  const body = redactHeaderText(typeof text === "string" ? text : "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
  if (!body) return null;
  const room = CONSOLE_TEXT_MAX - kind.length - 2;
  return `${kind}: ${body.slice(0, Math.max(room, 0))}`;
}

/** Runtime.consoleAPICalled. Arguments are redacted. Stacks and object graphs are not returned. */
export function lineFromRuntimeEvent(params) {
  if (!params || typeof params !== "object") return null;
  const args = Array.isArray(params.args) ? params.args : [];
  const parts = [];
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    if (Object.hasOwn(arg, "value")) parts.push(preview(arg.value));
    else if (typeof arg.description === "string") parts.push(arg.description);
    else if (typeof arg.unserializableValue === "string") parts.push(arg.unserializableValue);
  }
  return consoleLine(params.type || "log", parts.join(" "));
}

/** Console.messageAdded. The text only: no URL, no line, no headers. */
export function lineFromConsoleEvent(params) {
  const message = params && typeof params === "object" && params.message && typeof params.message === "object"
    ? params.message
    : params;
  if (!message || typeof message !== "object") return null;
  const level = message.level || message.source || "log";
  return consoleLine(level, typeof message.text === "string" ? message.text : "");
}

/** Runtime.exceptionThrown, as one console line. The stack is omitted. */
export function lineFromExceptionEvent(params) {
  const details = params && typeof params === "object" ? params.exceptionDetails : null;
  if (!details || typeof details !== "object") return null;
  const fromException = details.exception && typeof details.exception === "object" ? details.exception.description : "";
  const text = typeof details.text === "string" && details.text !== "" ? details.text : fromException;
  return consoleLine("error", typeof text === "string" ? text : "");
}

export function describeElement(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const rawTag = typeof node.tag === "string" ? node.tag : typeof node.nodeName === "string" ? node.nodeName : "";
  const tag = rawTag.trim().toLowerCase();
  if (!TAG.test(tag)) return null;
  const idRaw = typeof node.id === "string" ? node.id.trim() : "";
  const id = TOKEN.test(idRaw) ? idRaw : "";
  let classes = [];
  if (Array.isArray(node.classes)) classes = node.classes;
  else if (typeof node.classes === "string") classes = node.classes.split(/\s+/);
  else if (typeof node.className === "string") classes = node.className.split(/\s+/);
  const clean = [];
  for (const item of classes) {
    if (typeof item !== "string") continue;
    const token = item.trim();
    if (!TOKEN.test(token) || clean.includes(token)) continue;
    clean.push(token);
    if (clean.length >= 8) break;
  }
  let desc = id ? `${tag}#${id}` : tag;
  if (desc.length > 200) return null;
  for (const cls of clean) {
    if (desc.length + 1 + cls.length > 200) break;
    desc += `.${cls}`;
  }
  return ELEMENT_DESCRIPTION.test(desc) ? desc : null;
}

/** DOM.describeNode at depth 0. Children and other attributes are ignored. */
export function elementFromDescribedNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  if (node.nodeType !== undefined && node.nodeType !== 1) return null;
  const attrs = {};
  const list = node.attributes;
  if (Array.isArray(list)) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      if (list[i] === "id" || list[i] === "class") attrs[list[i]] = list[i + 1];
    }
  }
  return describeElement({ tag: node.nodeName || node.localName, id: attrs.id, classes: attrs.class });
}

export function elementDescription(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return ELEMENT_DESCRIPTION.test(trimmed) ? trimmed : null;
  }
  return describeElement(value);
}

/**
 * What a tool may see. Messages are strings. There is no headers field and no DOM.
 * An Authorization or Cookie value does not survive.
 */
export function redactInspectResult(result) {
  const messages = [];
  const raw = result && Array.isArray(result.messages) ? result.messages : [];
  for (const line of raw) {
    const text = redactHeaderText(typeof line === "string" ? line : preview(line)).replace(/\u0000/g, "").trim();
    if (!text) continue;
    messages.push(text.slice(0, CONSOLE_TEXT_MAX));
    if (messages.length >= CONSOLE_LIMIT) break;
  }
  return { messages, element: elementDescription(result ? result.element : null) };
}

/** Page messages that ask for a debugger attach. The page channel cannot do that. */
export function pageAsksForDebugger(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const type = message.t;
  if (
    type === "inspect" ||
    type === "browser_inspect" ||
    type === "debugger" ||
    type === "devtools" ||
    type === "attach" ||
    type === "detach"
  ) {
    return true;
  }
  for (const key of ["debugger", "devtools", "inspect", "browser_inspect", "attachDebugger"]) {
    if (Object.hasOwn(message, key)) return true;
  }
  return false;
}

/**
 * Attach only a recorded tab, and only after Allow, unless the debugger is already attached.
 * A deny never attaches. An unknown tab never attaches. `perform` is the attach.
 */
export function gateInspect({ tabId, recordedTabIds, confirm, attached, perform }) {
  const recorded = Array.isArray(recordedTabIds) && recordedTabIds.some((id) => id === tabId);
  if (!Number.isInteger(tabId) || tabId < 0 || !recorded) {
    return { attach: false, read: false, error: "not_shared" };
  }
  if (confirm === "deny") return { attach: false, read: false, error: "denied" };
  const live = attached === true;
  if (!live && confirm !== "allow") return { attach: false, read: false, error: "waiting" };
  if (!live && typeof perform === "function") perform(tabId);
  return { attach: !live, read: true };
}

export function inspectNotice({ requesterEmail }) {
  const who = typeof requesterEmail === "string" && requesterEmail !== "" ? requesterEmail : "Someone";
  return {
    title: "Kernal",
    message: `${who} asked to attach DevTools to the shared tab.`,
    buttons: ["Allow", "Deny"],
  };
}

export function inspectNoticeId(requestId) {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 180) return null;
  return `inspect:${requestId}`;
}

export function inspectRequestIdFromNotice(notificationId) {
  if (typeof notificationId !== "string" || !notificationId.startsWith("inspect:")) return null;
  const id = notificationId.slice("inspect:".length);
  return id.length > 0 && id.length <= 180 ? id : null;
}

function nativeRequestId(id) {
  return Number.isInteger(id) && id > 0 ? id : null;
}

function withNativeRequestId(message, id) {
  const carried = nativeRequestId(id);
  if (carried == null) return message;
  return { ...message, id: carried };
}

/** Host → extension. A tab id this process did not share is not an inspect. No other fields. */
export function parseHostInspect(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.t !== "inspect" || !Number.isInteger(message.tabId) || message.tabId < 0) return null;
  for (const key of Object.keys(message)) {
    if (key !== "t" && key !== "tabId" && key !== "id") return null;
  }
  return withNativeRequestId({ t: "inspect", tabId: message.tabId }, message.id);
}

export function hostInspectedMessage(tabId, result, id) {
  const clean = redactInspectResult(result);
  return withNativeRequestId({ t: "inspected", tabId, messages: clean.messages, element: clean.element }, id);
}

export function hostInspectError(tabId, error, id) {
  return withNativeRequestId({ t: "inspect-error", tabId, error }, id);
}

export function pendingInspects(body) {
  if (!Array.isArray(body)) return [];
  const out = [];
  for (const row of body) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.id !== "string" || row.id.length === 0 || row.id.length > 200) continue;
    if (row.status !== "pending" || row.kind !== "inspect") continue;
    out.push({
      id: row.id,
      requesterEmail: typeof row.requesterEmail === "string" ? row.requesterEmail : "",
    });
  }
  return out;
}

export function inspectResultPath(sessionId, requestId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/inspects/${encodeURIComponent(requestId)}/result`;
}

export function readInspectPromptMap(stored) {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out = {};
  for (const [requestId, prompt] of Object.entries(stored)) {
    const parsed = inspectPromptRecord(requestId, prompt);
    if (parsed) out[requestId] = parsed;
  }
  return out;
}

function inspectPromptRecord(requestId, prompt) {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 180) return null;
  if (prompt === null || typeof prompt !== "object" || Array.isArray(prompt)) return null;
  if (prompt.source !== "cloud" && prompt.source !== "host") return null;
  if (!Number.isInteger(prompt.tabId) || prompt.tabId < 0) return null;
  if (prompt.source === "cloud" && !SESSION_ID.test(prompt.sessionId ?? "")) return null;
  const hostId = prompt.source === "host" ? nativeRequestId(prompt.hostId) : null;
  return {
    requestId,
    sessionId: typeof prompt.sessionId === "string" ? prompt.sessionId : "",
    requesterEmail: typeof prompt.requesterEmail === "string" ? prompt.requesterEmail : "",
    source: prompt.source,
    tabId: prompt.tabId,
    ...(hostId != null ? { hostId } : {}),
  };
}

export function inspectPanelMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.t === "inspect-state" && typeof message.sessionId === "string" && SESSION_ID.test(message.sessionId)) {
    return { t: "inspect-state", sessionId: message.sessionId };
  }
  if (
    message.t === "inspect-decide" &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 180 &&
    (message.decision === "allow" || message.decision === "deny")
  ) {
    return { t: "inspect-decide", requestId: message.requestId, decision: message.decision };
  }
  return null;
}

export function inspectPromptView(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  const notice = inspectNotice(prompt);
  return {
    requestId: prompt.requestId,
    requesterEmail: prompt.requesterEmail,
    message: notice.message,
  };
}
