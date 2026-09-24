// Side panel. An extension page, not an iframe of the Floppy.
// The Dongle is read from chrome.storage.local and sent only as a Bearer header to the link
// origin. It is never written into this page and never logged.
// Share and revoke are messages to the service worker. This file does not capture.

import { isDongle } from "./protocol.js";
import {
  LINK_KEY,
  NOTIFIED_UI_KEY,
  PAGE_ORIGIN_KEY,
  PANEL_SESSION_KEY,
  PLACEMENTS_KEY,
  SHARE_UNAVAILABLE,
  TOKEN_KEY,
  actionSession,
  apiPath,
  approvalNotificationId,
  approvalView,
  capturingText,
  committedSession,
  floppyUrl,
  linkUrl,
  nextShareStatus,
  openFloppyPlan,
  pageOriginForFloppy,
  placementRecord,
  placementRememberMessage,
  pollDelay,
  publicError,
  sessionChoiceLabel,
  sessionIdOk,
  shareMessage,
  stateLine,
  steerBody,
  transcriptLines,
  uiResponseBody,
} from "./panel-model.js";

const setup = document.querySelector("#setup");
const allowButton = document.querySelector("#allow");
const floppySelect = document.querySelector("#floppy");
const state = document.querySelector("#state");
const transcript = document.querySelector("#transcript");
const steerForm = document.querySelector("#steer");
const steerInput = document.querySelector("#steer-text");
const approval = document.querySelector("#approval");
const approvalTitle = document.querySelector("#approval-title");
const approvalMessage = document.querySelector("#approval-message");
const approvalActions = document.querySelector("#approval-actions");
const shareStatus = document.querySelector("#share-status");
const actionCopy = document.querySelector("#action-copy");
const actionText = document.querySelector("#action-text");
const actionButtons = document.querySelector("#action-buttons");
const allowClick = document.querySelector("#allow-click");
const allowType = document.querySelector("#allow-type");
let shownActionId = "";
const capturing = document.querySelector("#capturing");
const status = document.querySelector("#status");

let linkForPermission = "";
let shareLine = SHARE_UNAVAILABLE;
let timer = null;
let running = false;
let refreshAgain = false;
let selectionEpoch = 0;
let paintedSession = "";

function holdPanelPort() {
  try {
    const port = chrome.runtime.connect({ name: "kernal-panel" });
    port.onDisconnect.addListener(() => {
      if (document.visibilityState !== "visible") return;
      setTimeout(holdPanelPort, 500);
    });
  } catch {
    // The panel still steers. Closed-panel notices wait for the next worker wake.
  }
}

function askWorker(message, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timerId = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timerId);
        if (chrome.runtime.lastError) finish(null);
        else finish(response ?? null);
      });
    } catch {
      clearTimeout(timerId);
      finish(null);
    }
  });
}

async function linkCall(method, path, body) {
  const stored = await chrome.storage.local.get([TOKEN_KEY, LINK_KEY]);
  const token = stored[TOKEN_KEY];
  const origin = stored[LINK_KEY];
  const href = linkUrl(origin, path);
  linkForPermission = href ? new URL(href).origin : "";
  if (!isDongle(token) || !href) {
    return { ok: false, code: "need-settings", error: "Set OUTFITTER_TOKEN and OUTFITTER_API on the options page." };
  }
  let allowed = false;
  try {
    allowed = await chrome.permissions.contains({ origins: [`${linkForPermission}/*`] });
  } catch {
    allowed = false;
  }
  if (!allowed) return { ok: false, code: "need-permission" };
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers, credentials: "omit", cache: "no-store", redirect: "error" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(href, init);
    let parsed = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) return { ok: false, code: "http", error: publicError(res.status, parsed) };
    return { ok: true, status: res.status, body: parsed };
  } catch {
    return { ok: false, code: "network", error: "Could not reach the link origin." };
  }
}

function note(result) {
  if (result.ok) {
    allowButton.hidden = true;
    if (setup.textContent !== "") setup.textContent = "";
    return true;
  }
  if (result.code === "need-permission") {
    allowButton.hidden = false;
    setup.textContent = "Allow this extension to call the link origin.";
    return false;
  }
  allowButton.hidden = true;
  setup.textContent = result.error || "Could not reach the link origin.";
  return false;
}

function selectedId() {
  return sessionIdOk(floppySelect.value) ? floppySelect.value : "";
}

function renderSessions(sessions, preferredId) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const key = rows.map((session) => `${session.id}\t${session.name || ""}\t${session.runState || ""}`).join("\n");
  const want = sessionIdOk(preferredId) ? preferredId : selectedId();
  if (floppySelect.dataset.key === key && floppySelect.value === want) return want;
  floppySelect.dataset.key = key;
  floppySelect.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose a Floppy";
  floppySelect.append(blank);
  const seen = new Set();
  for (const session of rows) {
    if (!session || !sessionIdOk(session.id) || seen.has(session.id)) continue;
    seen.add(session.id);
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = sessionChoiceLabel(session);
    floppySelect.append(option);
  }
  if (want && !seen.has(want)) {
    const pinned = document.createElement("option");
    pinned.value = want;
    pinned.textContent = "Pinned Floppy";
    floppySelect.append(pinned);
  }
  if (want && [...floppySelect.options].some((option) => option.value === want)) floppySelect.value = want;
  return selectedId();
}

function renderTranscript(entries) {
  const lines = transcriptLines(entries);
  transcript.textContent = lines.length > 0 ? lines.join("\n") : "No transcript yet.";
}

function answerButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function screenSession() {
  return actionSession(paintedSession, selectedId());
}

async function sendAnswer(sessionId, id, value) {
  if (screenSession() !== sessionId) {
    status.textContent = "Choose a Floppy.";
    return;
  }
  const body = uiResponseBody(id, value);
  const path = apiPath("ui-response", sessionId);
  if (!body || !path) return;
  const result = await linkCall("POST", path, body);
  if (!note(result)) return;
  status.textContent = "Answered.";
  renderApproval(null, "");
  await refresh();
}

function renderApproval(view, sessionId) {
  if (!view || !sessionIdOk(sessionId)) {
    approval.hidden = true;
    approval.dataset.id = "";
    approval.dataset.method = "";
    approval.dataset.session = "";
    approvalTitle.textContent = "";
    approvalMessage.textContent = "";
    approvalActions.replaceChildren();
    return;
  }
  approval.hidden = false;
  approvalTitle.textContent = view.title;
  approvalMessage.textContent = view.message || "";
  approvalMessage.hidden = !view.message;
  const nid = approvalNotificationId(view.id);
  if (nid) chrome.notifications.clear(nid).catch(() => {});
  if (
    approval.dataset.id === view.id &&
    approval.dataset.method === view.method &&
    approval.dataset.session === sessionId
  ) {
    return;
  }
  approval.dataset.id = view.id;
  approval.dataset.method = view.method;
  approval.dataset.session = sessionId;
  approvalActions.replaceChildren();
  if (view.unsupported) {
    const noteText = document.createElement("p");
    noteText.className = "hint";
    noteText.textContent = "Open the Floppy to answer this prompt.";
    approvalActions.append(noteText);
    return;
  }
  if (view.method === "confirm") {
    approvalActions.append(
      answerButton("Confirm", () => sendAnswer(sessionId, view.id, true)),
      answerButton("Cancel", () => sendAnswer(sessionId, view.id, false)),
    );
    return;
  }
  if (view.method === "select") {
    for (const option of view.options) approvalActions.append(answerButton(option, () => sendAnswer(sessionId, view.id, option)));
    return;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (view.placeholder) input.placeholder = view.placeholder;
  approvalActions.append(input, answerButton("Submit", () => sendAnswer(sessionId, view.id, input.value)));
}

function renderAction(response) {
  const prompt = response && response.prompt && typeof response.prompt === "object" ? response.prompt : null;
  if (!prompt || typeof prompt.requestId !== "string") {
    shownActionId = "";
    actionCopy.hidden = true;
    actionCopy.textContent = "";
    actionText.hidden = true;
    actionText.textContent = "";
    actionButtons.hidden = true;
  } else {
    shownActionId = prompt.requestId;
    actionCopy.hidden = false;
    actionCopy.textContent = typeof prompt.message === "string" ? prompt.message : "";
    if (prompt.kind === "type" && typeof prompt.text === "string" && prompt.text !== "") {
      actionText.hidden = false;
      actionText.textContent = prompt.text;
    } else {
      actionText.hidden = true;
      actionText.textContent = "";
    }
    actionButtons.hidden = false;
  }
  if (response && typeof response.click === "boolean" && document.activeElement !== allowClick) allowClick.checked = response.click;
  if (response && typeof response.type === "boolean" && document.activeElement !== allowType) allowType.checked = response.type;
}

async function refreshAction(sessionId, epoch) {
  let response = null;
  try {
    response = await askWorker({ t: "action-state", sessionId });
  } catch {
    response = null;
  }
  if (epoch !== undefined && epoch !== selectionEpoch) return;
  renderAction(response);
}

function renderCapturing(response) {
  const line = capturingText(response);
  capturing.hidden = line === null;
  capturing.textContent = line || "";
}

function clearStrip() {
  paintedSession = "";
  state.textContent = "";
  transcript.textContent = "";
  renderApproval(null, "");
  shareLine = SHARE_UNAVAILABLE;
  shareStatus.textContent = shareLine;
  renderCapturing(null);
  renderAction(null);
}

function bumpSelection() {
  selectionEpoch += 1;
  steerInput.value = "";
  clearStrip();
}

async function refreshShare(sessionId, action, epoch) {
  const message = shareMessage(action, sessionId);
  if (!message) {
    if (epoch !== undefined && epoch !== selectionEpoch) return;
    shareLine = SHARE_UNAVAILABLE;
    shareStatus.textContent = shareLine;
    renderCapturing(null);
    return;
  }
  let response = null;
  try {
    response = await askWorker(message);
  } catch {
    response = null;
  }
  if (epoch !== undefined && epoch !== selectionEpoch) return;
  shareLine = nextShareStatus(shareLine, response, action);
  shareStatus.textContent = shareLine;
  renderCapturing(response && typeof response === "object" ? response : null);
}

async function tick(epoch) {
  const stored = await chrome.storage.local.get(PANEL_SESSION_KEY);
  if (epoch !== selectionEpoch) return;
  const preferred = sessionIdOk(stored[PANEL_SESSION_KEY]) ? stored[PANEL_SESSION_KEY] : selectedId();
  const list = await linkCall("GET", apiPath("list"));
  if (epoch !== selectionEpoch) return;
  if (!note(list)) {
    clearStrip();
    return;
  }
  const sessionId = renderSessions(list.body, preferred);
  const show = committedSession(sessionId, selectedId(), epoch, selectionEpoch);
  if (!show) {
    if (epoch !== selectionEpoch) return;
    state.textContent = "Choose a Floppy.";
    transcript.textContent = "";
    renderApproval(null, "");
    shareStatus.textContent = SHARE_UNAVAILABLE;
    renderCapturing(null);
    paintedSession = "";
    return;
  }
  if (stored[PANEL_SESSION_KEY] !== show) {
    chrome.storage.local.set({ [PANEL_SESSION_KEY]: show }).catch(() => {});
  }
  const sessionPath = apiPath("session", show);
  const entriesPath = apiPath("entries", show);
  const [detail, entries] = await Promise.all([
    linkCall("GET", sessionPath),
    linkCall("GET", entriesPath),
    refreshShare(show, "status", epoch),
    refreshAction(show, epoch),
  ]);
  if (committedSession(show, selectedId(), epoch, selectionEpoch) !== show) return;
  if (!note(detail)) {
    if (paintedSession !== show) clearStrip();
    return;
  }
  paintedSession = show;
  state.textContent = stateLine(detail.body);
  if (entries.ok) renderTranscript(entries.body);
  else transcript.textContent = entries.error || "Could not read the transcript.";
  const view = approvalView(detail.body && detail.body.pendingUiRequest);
  renderApproval(view, show);
  // Remember the id while it is on screen so closing the panel does not notify for it.
  // An id the panel never showed still notifies once, from the service worker.
  if (view && document.visibilityState === "visible") {
    chrome.storage.local.set({ [NOTIFIED_UI_KEY]: view.id }).catch(() => {});
  }
}

function refresh() {
  if (running) {
    refreshAgain = true;
    return Promise.resolve();
  }
  running = true;
  const epoch = selectionEpoch;
  return tick(epoch)
    .catch(() => {
      if (epoch === selectionEpoch) status.textContent = "Could not refresh.";
    })
    .finally(async () => {
      running = false;
      if (refreshAgain) {
        refreshAgain = false;
        await refresh();
      }
    });
}

function stop() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function start() {
  stop();
  const delay = pollDelay(document.visibilityState);
  if (delay === null) return;
  timer = setTimeout(() => {
    timer = null;
    refresh().finally(start);
  }, delay);
}

async function openFloppy() {
  const sessionId = selectedId();
  if (!sessionId) {
    status.textContent = "Choose a Floppy.";
    return;
  }
  const stored = await chrome.storage.local.get([PLACEMENTS_KEY, PAGE_ORIGIN_KEY]);
  const map = stored[PLACEMENTS_KEY];
  const record = map && typeof map === "object" && !Array.isArray(map) ? map[sessionId] : null;
  let tabStillThere = false;
  if (record && typeof record.tabId === "number") {
    try {
      await chrome.tabs.get(record.tabId);
      tabStillThere = true;
    } catch {
      tabStillThere = false;
    }
  }
  const plan = openFloppyPlan(record, tabStillThere);
  if (plan.action === "focus") {
    try {
      await chrome.tabs.update(plan.tabId, { active: true });
      if (typeof plan.windowId === "number") await chrome.windows.update(plan.windowId, { focused: true });
      status.textContent = "";
      return;
    } catch {
      // The recorded tab vanished. Open the Floppy page.
    }
  }
  const href = floppyUrl(pageOriginForFloppy(stored[PAGE_ORIGIN_KEY]), sessionId);
  if (!href) {
    status.textContent = "Could not build the Floppy URL.";
    return;
  }
  const tab = await chrome.tabs.create({ url: href, active: true });
  const rec = placementRecord(sessionId, tab);
  const message = rec ? placementRememberMessage(rec.sessionId, rec.tabId) : null;
  // The worker queue owns the placements map. A panel write would replace it with a stale copy.
  const saved = message ? await askWorker(message, 4000) : null;
  if (!saved || saved.ok !== true) {
    status.textContent = "Could not remember the Floppy.";
    return;
  }
  status.textContent = "";
}

floppySelect.addEventListener("change", () => {
  bumpSelection();
  const sessionId = selectedId();
  const write = sessionId
    ? chrome.storage.local.set({ [PANEL_SESSION_KEY]: sessionId })
    : chrome.storage.local.remove(PANEL_SESSION_KEY);
  write.then(() => refresh()).catch(() => {
    status.textContent = "Could not remember the Floppy.";
  });
});

document.querySelector("#open").addEventListener("click", () => {
  openFloppy().catch(() => {
    status.textContent = "Could not open the Floppy.";
  });
});

steerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const path = apiPath("messages", screenSession());
  const body = steerBody(steerInput.value);
  if (!path) {
    status.textContent = "Choose a Floppy.";
    return;
  }
  if (!body) {
    status.textContent = "Write a follow-up first.";
    return;
  }
  linkCall("POST", path, body).then((result) => {
    if (!note(result)) return;
    steerInput.value = "";
    status.textContent = result.status === 202 ? "Queued." : "Sent.";
    refresh();
  }).catch(() => {
    status.textContent = "Could not send.";
  });
});

document.querySelector("#break").addEventListener("click", () => {
  const path = apiPath("abort", screenSession());
  if (!path) {
    status.textContent = "Choose a Floppy.";
    return;
  }
  linkCall("POST", path).then((result) => {
    if (!note(result)) return;
    status.textContent = "Break sent.";
    refresh();
  }).catch(() => {
    status.textContent = "Could not break.";
  });
});

document.querySelector("#share").addEventListener("click", () => {
  const sessionId = screenSession();
  if (!sessionId) {
    status.textContent = "Choose a Floppy.";
    return;
  }
  refreshShare(sessionId, "share").catch(() => {
    shareStatus.textContent = SHARE_UNAVAILABLE;
  });
});

document.querySelector("#action-allow").addEventListener("click", () => {
  if (!shownActionId) return;
  askWorker({ t: "action-decide", requestId: shownActionId, decision: "allow" })
    .then(() => refresh())
    .catch(() => {
      status.textContent = "Could not allow that action.";
    });
});

document.querySelector("#action-deny").addEventListener("click", () => {
  if (!shownActionId) return;
  askWorker({ t: "action-decide", requestId: shownActionId, decision: "deny" })
    .then(() => refresh())
    .catch(() => {
      status.textContent = "Could not deny that action.";
    });
});

function setAllowKind(kind, input) {
  const sessionId = screenSession();
  if (!sessionId) {
    input.checked = false;
    status.textContent = "Choose a Floppy.";
    return;
  }
  askWorker({ t: "action-allow", sessionId, kind, on: input.checked === true }).catch(() => {
    status.textContent = "Could not save that switch.";
  });
}

allowClick.addEventListener("change", () => setAllowKind("click", allowClick));
allowType.addEventListener("change", () => setAllowKind("type", allowType));

document.querySelector("#revoke").addEventListener("click", () => {
  const sessionId = screenSession();
  if (!sessionId) {
    status.textContent = "Choose a Floppy.";
    return;
  }
  refreshShare(sessionId, "revoke").catch(() => {
    shareStatus.textContent = SHARE_UNAVAILABLE;
  });
});

allowButton.addEventListener("click", () => {
  if (!linkForPermission) return;
  // Called in the click, before any await, so Chrome still counts the gesture.
  chrome.permissions.request({ origins: [`${linkForPermission}/*`] }).then((ok) => {
    if (ok) refresh();
    else status.textContent = "The link origin is not allowed yet.";
  }).catch(() => {
    status.textContent = "Could not allow the link origin.";
  });
});

document.querySelector("#options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.addEventListener("visibilitychange", () => {
  stop();
  if (pollDelay(document.visibilityState) === null) return;
  refresh().finally(start);
});

holdPanelPort();
if (pollDelay(document.visibilityState) !== null) refresh().finally(start);
