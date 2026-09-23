// Options for the companion shell. The Dongle (OUTFITTER_TOKEN) and the link origin
// (OUTFITTER_API) live in chrome.storage.local. The token is never logged and is never written
// into the page: the password field holds only what the user is typing. A saved Dongle is reported
// as "saved", not echoed back.

const TOKEN_KEY = "OUTFITTER_TOKEN";
const ORIGIN_KEY = "OUTFITTER_API";

// outf_ + 32 random bytes, base64url, no padding. Same shape as packages/api generateToken.
const DONGLE = /^outf_[A-Za-z0-9_-]{43}$/;

const tokenInput = document.querySelector("#token");
const originInput = document.querySelector("#origin");
const tokenState = document.querySelector("#token-state");
const status = document.querySelector("#status");
const form = document.querySelector("#settings");
const removeButton = document.querySelector("#remove");

let dongleSaved = false;

function isDongle(value) {
  return DONGLE.test(value);
}

function linkOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

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
    status.textContent = "Dongle must start with outf_.";
    return;
  }
  const origin = originText === "" ? "" : linkOrigin(originText);
  if (originText !== "" && origin === null) {
    status.textContent = "Link origin must be an http(s) URL.";
    return;
  }
  try {
    if (typed !== "") {
      await chrome.storage.local.set({ [TOKEN_KEY]: typed });
      dongleSaved = true;
      tokenInput.value = "";
    }
    if (originText === "") {
      await chrome.storage.local.remove(ORIGIN_KEY);
      originInput.value = "";
    } else {
      await chrome.storage.local.set({ [ORIGIN_KEY]: origin });
      originInput.value = origin;
    }
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
