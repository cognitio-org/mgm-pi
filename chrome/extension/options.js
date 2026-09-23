// Options for the companion shell. The Dongle (OUTFITTER_TOKEN) and the link origin
// (OUTFITTER_API) live in chrome.storage.local. The token is never logged and is never written
// into the page: the password field holds only what the user is typing. A saved Dongle is reported
// as "saved", not echoed back.

import { isDongle, linkOrigin } from "./protocol.js";

const TOKEN_KEY = "OUTFITTER_TOKEN";
const ORIGIN_KEY = "OUTFITTER_API";

const tokenInput = document.querySelector("#token");
const originInput = document.querySelector("#origin");
const tokenState = document.querySelector("#token-state");
const status = document.querySelector("#status");
const form = document.querySelector("#settings");
const removeButton = document.querySelector("#remove");

let dongleSaved = false;

function saySaved() {
  tokenState.textContent = dongleSaved ? "A Dongle is saved." : "";
}

const manifest = chrome.runtime.getManifest();
document.querySelector("#build").textContent = `${manifest.version} · ${chrome.runtime.id}`;

try {
  const stored = await chrome.storage.local.get([TOKEN_KEY, ORIGIN_KEY]);
  dongleSaved = typeof stored[TOKEN_KEY] === "string" && isDongle(stored[TOKEN_KEY]);
  saySaved();
  if (typeof stored[ORIGIN_KEY] === "string") originInput.value = stored[ORIGIN_KEY];
} catch {
  status.textContent = "Could not read saved settings.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  const typed = tokenInput.value.trim();
  const originText = originInput.value.trim();
  if (typed !== "" && !isDongle(typed)) {
    status.textContent = "Dongle must be outf_ followed by 43 base64url characters.";
    return;
  }
  const origin = originText === "" ? "" : linkOrigin(originText);
  if (originText !== "" && origin === null) {
    status.textContent = "Link origin must be an http(s) URL.";
    return;
  }
  try {
    const writes = {};
    if (typed !== "") writes[TOKEN_KEY] = typed;
    if (originText !== "") writes[ORIGIN_KEY] = origin;
    if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
    if (originText === "") await chrome.storage.local.remove(ORIGIN_KEY);
    // Clear the password field only after every storage call has succeeded.
    if (typed !== "") {
      dongleSaved = true;
      tokenInput.value = "";
    }
    originInput.value = origin;
    saySaved();
    status.textContent = "Saved.";
  } catch {
    status.textContent = "Could not save.";
  }
});

removeButton.addEventListener("click", async () => {
  status.textContent = "";
  tokenInput.value = "";
  try {
    await chrome.storage.local.remove(TOKEN_KEY);
    dongleSaved = false;
    saySaved();
    status.textContent = "Dongle removed.";
  } catch {
    status.textContent = "Could not remove the Dongle.";
  }
});
