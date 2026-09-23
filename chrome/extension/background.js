// Service worker. Page channel: ping, place, split, poll, and openPanel, and nothing else.
// sender.url is never read. A sender with no origin, or any other origin, is dropped.
// Only tabs this extension opened are moved. The page cannot name a tab id.

import { originAllowed, parsePageMessage, pageReply } from "./protocol.js";
import {
  adjacencyMove,
  groupColor,
  groupTitle,
  placeAction,
  splitAvailability,
  splitPlan,
  SHARED_GROUP_COLOR,
  SHARED_GROUP_TITLE,
} from "./placement.js";

const PLACEMENTS_KEY = "placements";

let tail = Promise.resolve();

function enqueue(fn) {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The page closed the port. Do not log: the payload is not a secret, but the port is gone.
  }
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.sessionId === "string" &&
    typeof value.tabId === "number" &&
    typeof value.windowId === "number" &&
    typeof value.groupId === "number"
  );
}

async function readPlacements() {
  const stored = await chrome.storage.local.get(PLACEMENTS_KEY);
  const value = stored[PLACEMENTS_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const map = {};
  for (const [sessionId, rec] of Object.entries(value)) {
    if (isRecord(rec) && rec.sessionId === sessionId) map[sessionId] = rec;
  }
  return map;
}

async function writePlacements(map) {
  await chrome.storage.local.set({ [PLACEMENTS_KEY]: map });
}

async function remember(sessionId, tabId) {
  const tab = await chrome.tabs.get(tabId);
  const map = await readPlacements();
  map[sessionId] = {
    sessionId,
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
  };
  await writePlacements(map);
  return tab;
}

async function liveRecord(sessionId) {
  const map = await readPlacements();
  const rec = map[sessionId];
  if (!rec) return null;
  try {
    await chrome.tabs.get(rec.tabId);
    return rec;
  } catch {
    delete map[sessionId];
    await writePlacements(map);
    return null;
  }
}

async function dropTab(tabId) {
  const map = await readPlacements();
  let changed = false;
  for (const [sessionId, rec] of Object.entries(map)) {
    if (rec.tabId === tabId) {
      delete map[sessionId];
      changed = true;
    }
  }
  if (changed) await writePlacements(map);
}

async function syncOwnedTab(tabId, tab) {
  if (!tab || typeof tab.id !== "number") return;
  const map = await readPlacements();
  let changed = false;
  for (const rec of Object.values(map)) {
    if (rec.tabId !== tabId) continue;
    const windowId = typeof tab.windowId === "number" ? tab.windowId : rec.windowId;
    const groupId = typeof tab.groupId === "number" ? tab.groupId : rec.groupId;
    if (rec.windowId !== windowId || rec.groupId !== groupId) {
      rec.windowId = windowId;
      rec.groupId = groupId;
      changed = true;
    }
  }
  if (changed) await writePlacements(map);
}

async function currentWindowId() {
  const win = await chrome.windows.getCurrent();
  if (!win || typeof win.id !== "number") throw new Error("place_failed");
  return win.id;
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
}

async function uncollapse(groupId) {
  if (typeof groupId !== "number" || groupId < 0) return;
  try {
    await chrome.tabGroups.update(groupId, { collapsed: false });
  } catch {
    // The group went away between the group call and the update.
  }
}

async function ensureSharedGroup(windowId, tabIds) {
  const existing = await chrome.tabGroups.query({ windowId, title: SHARED_GROUP_TITLE });
  if (existing.length > 0) {
    const groupId = existing[0].id;
    await chrome.tabs.group({ groupId, tabIds });
    await uncollapse(groupId);
    return groupId;
  }
  const groupId = await chrome.tabs.group({ createProperties: { windowId }, tabIds });
  await chrome.tabGroups.update(groupId, { title: groupTitle("shared"), color: SHARED_GROUP_COLOR, collapsed: false });
  return groupId;
}

async function ensureSessionTab(sessionId, origin, windowId) {
  const record = await liveRecord(sessionId);
  if (record) return record.tabId;
  if (!originAllowed(origin)) throw new Error("place_failed");
  const href = `${origin}/sessions/${sessionId}`;
  const tab = await chrome.tabs.create({ url: href, active: false, windowId });
  if (!tab || typeof tab.id !== "number") throw new Error("place_failed");
  await remember(sessionId, tab.id);
  return tab.id;
}

async function makeAdjacent(idA, idB) {
  const tabA = await chrome.tabs.get(idA);
  const tabB = await chrome.tabs.get(idB);
  if (tabA.windowId !== tabB.windowId) throw new Error("split_failed");
  const move = adjacencyMove(tabA.index, tabB.index);
  if (!move) return;
  const tabId = move.tab === "a" ? idA : idB;
  await chrome.tabs.move(tabId, { index: move.index });
}

async function performPlace(parsed) {
  const record = await liveRecord(parsed.sessionId);
  const decision = placeAction(parsed.mode, record, record !== null);
  if (decision.action === "focus") {
    if (decision.moveToShared) {
      const windowId = await currentWindowId();
      await ensureSharedGroup(windowId, [record.tabId]);
    }
    const tab = await remember(parsed.sessionId, record.tabId);
    await uncollapse(tab.groupId);
    await focusTab(tab);
    return { ok: true };
  }
  if (decision.mode === "window") {
    const created = await chrome.windows.create({ url: parsed.href, focused: true, type: "normal" });
    let tab = created && created.tabs && created.tabs[0];
    if ((!tab || typeof tab.id !== "number") && created && typeof created.id === "number") {
      const tabs = await chrome.tabs.query({ windowId: created.id });
      tab = tabs[0];
    }
    if (!created || typeof created.id !== "number" || !tab || typeof tab.id !== "number") throw new Error("place_failed");
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: created.id } });
    await chrome.tabGroups.update(groupId, {
      title: groupTitle("window", parsed.title),
      color: groupColor(parsed.sessionId),
      collapsed: false,
    });
    const stored = await remember(parsed.sessionId, tab.id);
    await focusTab(stored);
    return { ok: true };
  }
  const windowId = await currentWindowId();
  const tab = await chrome.tabs.create({ url: parsed.href, active: true, windowId });
  if (!tab || typeof tab.id !== "number") throw new Error("place_failed");
  if (decision.mode === "shared") {
    await ensureSharedGroup(windowId, [tab.id]);
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, {
      title: groupTitle("own", parsed.title),
      color: groupColor(parsed.sessionId),
      collapsed: false,
    });
  }
  const stored = await remember(parsed.sessionId, tab.id);
  await focusTab(stored);
  return { ok: true };
}

async function performSplit(parsed, origin) {
  // createSplit is required. When it is missing, do not open a tab and do not open a window.
  const plan = splitPlan(typeof chrome.tabs?.createSplit === "function");
  if (!plan.ok) return { ok: false, error: plan.error };
  const windowId = await currentWindowId();
  const idA = await ensureSessionTab(parsed.sessionId, origin, windowId);
  const idB = await ensureSessionTab(parsed.otherSessionId, origin, windowId);
  if (idA === idB) return { ok: false, error: "split_failed" };
  await ensureSharedGroup(windowId, [idA, idB]);
  await makeAdjacent(idA, idB);
  try {
    await chrome.tabs.createSplit([idA, idB]);
  } catch {
    // Leave the tabs in the Floppies group. The page surfaces split_failed; the panel is later.
    await remember(parsed.sessionId, idA);
    await remember(parsed.otherSessionId, idB);
    return { ok: false, error: "split_failed" };
  }
  await remember(parsed.sessionId, idA);
  await remember(parsed.otherSessionId, idB);
  return { ok: true };
}

async function performOpenPanel() {
  if (!chrome.sidePanel || typeof chrome.sidePanel.open !== "function") return { ok: true };
  try {
    const windowId = await currentWindowId();
    await chrome.sidePanel.open({ windowId });
  } catch {
    // No panel page yet, or no user gesture. Accepting the message is enough.
  }
  return { ok: true };
}

async function onPageMessage(port, origin, message) {
  const parsed = parsePageMessage(message);
  if (!parsed.ok) {
    post(port, { ok: false, error: "rejected" });
    return;
  }
  if (parsed.t === "ping") {
    const manifest = chrome.runtime.getManifest();
    post(port, pageReply(message, manifest.version, chrome.runtime.id));
    post(port, splitAvailability(typeof chrome.tabs?.createSplit === "function"));
    return;
  }
  if (parsed.t === "poll") {
    post(port, { ok: true });
    return;
  }
  try {
    if (parsed.t === "openPanel") post(port, await performOpenPanel());
    else if (parsed.t === "place") post(port, await performPlace(parsed));
    else if (parsed.t === "split") post(port, await performSplit(parsed, origin));
  } catch {
    const error = parsed.t === "split" ? "split_failed" : "place_failed";
    post(port, { ok: false, error });
  }
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (!originAllowed(port.sender?.origin)) {
    port.disconnect();
    return;
  }
  const origin = port.sender.origin;
  port.onMessage.addListener((message) => {
    enqueue(() => onPageMessage(port, origin, message)).catch(() => {
      post(port, { ok: false, error: "rejected" });
    });
  });
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!originAllowed(sender?.origin)) return;
  const origin = sender.origin;
  enqueue(() => onPageMessage({ postMessage: sendResponse }, origin, message)).catch(() => {
    sendResponse({ ok: false, error: "rejected" });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => dropTab(tabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  enqueue(() => syncOwnedTab(tabId, tab)).catch(() => {});
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  if (typeof info.newWindowId !== "number") return;
  enqueue(async () => {
    const map = await readPlacements();
    let changed = false;
    for (const rec of Object.values(map)) {
      if (rec.tabId !== tabId || rec.windowId === info.newWindowId) continue;
      rec.windowId = info.newWindowId;
      changed = true;
    }
    if (changed) await writePlacements(map);
  }).catch(() => {});
});
