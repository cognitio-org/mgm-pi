// Confirmed click and type on the one shared tab.
// No Chrome APIs: the service worker and node:test both import this file.
// Selectors are CSS. This file does not accept or run JavaScript.

export const SELECTOR_MAX = 500;
export const TEXT_MAX = 8000;

/** Per-share switches. Missing means off. */
export const ALLOW_KEY = "actionAllow";

/** Prompts waiting for Allow or Deny. Keyed by request id. */
export const ACTION_PROMPTS_KEY = "actionPrompts";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function selectorOk(selector) {
  if (typeof selector !== "string") return false;
  if (selector.length === 0 || selector.length > SELECTOR_MAX) return false;
  if (/[\u0000-\u001f\u007f<{}`;]/.test(selector)) return false;
  if (/javascript\s*:/i.test(selector)) return false;
  if (/eval\s*\(/i.test(selector) || /function\s*\(/i.test(selector)) return false;
  if (selector.includes("=>")) return false;
  if (/url\s*\(/i.test(selector) || /expression\s*\(/i.test(selector)) return false;
  return true;
}

/** `{kind:"click", selector}` or `{kind:"type", selector, text}`. Extra keys are refused. */
export function parseActionBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (body.kind !== "click" && body.kind !== "type") return null;
  if (typeof body.selector !== "string") return null;
  const selector = body.selector.trim();
  if (!selectorOk(selector)) return null;
  if (body.kind === "click") {
    if (keys.some((key) => key !== "kind" && key !== "selector")) return null;
    return { kind: "click", selector };
  }
  if (!keys.every((key) => key === "kind" || key === "selector" || key === "text")) return null;
  if (typeof body.text !== "string" || body.text.length > TEXT_MAX || body.text.includes("\u0000")) return null;
  return { kind: "type", selector, text: body.text };
}

/** Page messages that ask for a click or keystrokes. The page channel cannot do either. */
export function pageAsksForAction(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const type = message.t;
  if (
    type === "click" ||
    type === "type" ||
    type === "action" ||
    type === "browser_action" ||
    type === "key" ||
    type === "keydown" ||
    type === "keyup" ||
    type === "keypress"
  ) {
    return true;
  }
  for (const key of ["click", "type", "selector", "keystrokes", "keys", "kind", "action"]) {
    if (Object.hasOwn(message, key)) return true;
  }
  return false;
}

export function readAllowMap(stored) {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out = {};
  for (const [sessionId, flags] of Object.entries(stored)) {
    if (!SESSION_ID.test(sessionId)) continue;
    if (flags === null || typeof flags !== "object" || Array.isArray(flags)) continue;
    out[sessionId] = { click: flags.click === true, type: flags.type === true };
  }
  return out;
}

/** Default is off. Only an explicit true for this share and this kind skips the confirm. */
export function kindAllowed(map, sessionId, kind) {
  if (kind !== "click" && kind !== "type") return false;
  const flags = map && typeof map === "object" ? map[sessionId] : undefined;
  if (!flags || typeof flags !== "object") return false;
  return flags[kind] === true;
}

export function withKindAllowed(map, sessionId, kind, enabled) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (!SESSION_ID.test(sessionId) || (kind !== "click" && kind !== "type")) return readAllowMap(base);
  const prev = readAllowMap(base)[sessionId] ?? { click: false, type: false };
  return readAllowMap({
    ...readAllowMap(base),
    [sessionId]: { ...prev, [kind]: enabled === true },
  });
}

export function withoutSessionAllow(map, sessionId) {
  const next = readAllowMap(map);
  delete next[sessionId];
  return next;
}

/**
 * `run` only when the share's switch for this kind is on, or the user allowed this action.
 * A deny never runs. No answer yet waits.
 */
export function actionMayRun(confirm, allowOn) {
  if (allowOn === true) return "run";
  if (confirm === "allow") return "run";
  if (confirm === "deny") return "deny";
  return "wait";
}

/**
 * Click only a recorded tab, and only after Allow or the kind's switch.
 * `perform` is the click. A deny or an unknown tab does not call it.
 */
export function gateAction({ tabId, recordedTabIds, confirm, allowOn, perform }) {
  const recorded = Array.isArray(recordedTabIds) && recordedTabIds.some((id) => id === tabId);
  if (!Number.isInteger(tabId) || tabId < 0 || !recorded) {
    return { clicked: false, error: "not_shared" };
  }
  const decision = actionMayRun(confirm, allowOn);
  if (decision !== "run") {
    return { clicked: false, error: decision === "deny" ? "denied" : "waiting" };
  }
  if (typeof perform === "function") perform(tabId);
  return { clicked: true };
}

export function actionNotice({ requesterEmail, kind, selector }) {
  const who = typeof requesterEmail === "string" && requesterEmail !== "" ? requesterEmail : "Someone";
  const verb = kind === "type" ? "type into" : "click";
  const target = typeof selector === "string" && selector !== "" ? selector : "the page";
  return {
    title: "Kernal",
    message: `${who} asked to ${verb} “${target}”.`,
    buttons: ["Allow", "Deny"],
  };
}

export function actionNoticeId(requestId) {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 180) return null;
  return `action:${requestId}`;
}

export function requestIdFromNotice(notificationId) {
  if (typeof notificationId !== "string" || !notificationId.startsWith("action:")) return null;
  const id = notificationId.slice("action:".length);
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

/** Host → extension. A tab id this process did not share is not an action. */
export function parseHostAction(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.t !== "action" || !Number.isInteger(message.tabId) || message.tabId < 0) return null;
  const body = parseActionBody(
    message.kind === "type"
      ? { kind: message.kind, selector: message.selector, text: message.text }
      : { kind: message.kind, selector: message.selector },
  );
  if (!body) return null;
  return withNativeRequestId({ t: "action", tabId: message.tabId, ...body }, message.id);
}

export function hostActedMessage(tabId, id) {
  return withNativeRequestId({ t: "acted", tabId }, id);
}

export function hostActionError(tabId, error, id) {
  return withNativeRequestId({ t: "action-error", tabId, error }, id);
}

export function pendingActions(body) {
  if (!Array.isArray(body)) return [];
  const out = [];
  for (const row of body) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.id !== "string" || row.id.length === 0 || row.id.length > 200) continue;
    if (row.status !== "pending") continue;
    const parsed = parseActionBody(
      row.kind === "type"
        ? { kind: row.kind, selector: row.selector, text: row.text }
        : { kind: row.kind, selector: row.selector },
    );
    if (!parsed) continue;
    out.push({
      id: row.id,
      requesterEmail: typeof row.requesterEmail === "string" ? row.requesterEmail : "",
      ...parsed,
    });
  }
  return out;
}

export function actionResultPath(sessionId, requestId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/actions/${encodeURIComponent(requestId)}/result`;
}

export function readPromptMap(stored) {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out = {};
  for (const [requestId, prompt] of Object.entries(stored)) {
    const parsed = promptRecord(requestId, prompt);
    if (parsed) out[requestId] = parsed;
  }
  return out;
}

function promptRecord(requestId, prompt) {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 180) return null;
  if (prompt === null || typeof prompt !== "object" || Array.isArray(prompt)) return null;
  const body = parseActionBody(
    prompt.kind === "type"
      ? { kind: prompt.kind, selector: prompt.selector, text: prompt.text }
      : { kind: prompt.kind, selector: prompt.selector },
  );
  if (!body) return null;
  if (!SESSION_ID.test(prompt.sessionId ?? "") && prompt.source === "cloud") return null;
  if (prompt.source !== "cloud" && prompt.source !== "host") return null;
  if (!Number.isInteger(prompt.tabId) || prompt.tabId < 0) return null;
  const hostId = prompt.source === "host" ? nativeRequestId(prompt.hostId) : null;
  return {
    requestId,
    sessionId: typeof prompt.sessionId === "string" ? prompt.sessionId : "",
    requesterEmail: typeof prompt.requesterEmail === "string" ? prompt.requesterEmail : "",
    source: prompt.source,
    tabId: prompt.tabId,
    ...body,
    ...(hostId != null ? { hostId } : {}),
  };
}

export function actionPanelMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.t === "action-state" && typeof message.sessionId === "string" && SESSION_ID.test(message.sessionId)) {
    return { t: "action-state", sessionId: message.sessionId };
  }
  if (
    message.t === "action-decide" &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 180 &&
    (message.decision === "allow" || message.decision === "deny")
  ) {
    return { t: "action-decide", requestId: message.requestId, decision: message.decision };
  }
  if (
    message.t === "action-allow" &&
    typeof message.sessionId === "string" &&
    SESSION_ID.test(message.sessionId) &&
    (message.kind === "click" || message.kind === "type") &&
    typeof message.on === "boolean"
  ) {
    return { t: "action-allow", sessionId: message.sessionId, kind: message.kind, on: message.on };
  }
  return null;
}

/** What the side panel shows. The typed text is clipped; the worker still types the full string. */
export function actionPromptView(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  const notice = actionNotice(prompt);
  return {
    requestId: prompt.requestId,
    requesterEmail: prompt.requesterEmail,
    kind: prompt.kind,
    selector: prompt.selector,
    message: notice.message,
    ...(prompt.kind === "type" && typeof prompt.text === "string" ? { text: [...prompt.text].slice(0, 200).join("") } : {}),
  };
}

/**
 * Runs in the shared tab via chrome.scripting.executeScript.
 * Self-contained: Chrome serializes this function and does not keep the module scope.
 */
export function clickSelector(selector) {
  let el;
  try {
    el = document.querySelector(selector);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (!el) return { ok: false, error: "not_found" };
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return { ok: true };
}

/** Same constraint as clickSelector. Sets the control's value; it does not eval the text. */
export function typeSelector(selector, text) {
  let el;
  try {
    el = document.querySelector(selector);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (!el) return { ok: false, error: "not_found" };
  const value = typeof text === "string" ? text : "";
  const editable = el.isContentEditable === true;
  const hasValue = "value" in el;
  if (!editable && !hasValue) return { ok: false, error: "not_editable" };
  if (typeof el.focus === "function") el.focus();
  if (hasValue) {
    const proto = Object.getPrototypeOf(el);
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined;
    if (desc && typeof desc.set === "function") desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  el.textContent = value;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  return { ok: true };
}
