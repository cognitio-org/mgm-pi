// Service worker for the companion shell. Pairing only: a ping from an allowlisted page.
// sender.url is never read. A sender with no origin, or any other origin, is dropped.

import { originAllowed, pageReply } from "./protocol.js";

function senderOrigin(sender) {
  if (!sender || typeof sender.origin !== "string") return undefined;
  return sender.origin;
}

function reply(message) {
  const manifest = chrome.runtime.getManifest();
  return pageReply(message, manifest.version, chrome.runtime.id);
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (!originAllowed(senderOrigin(port.sender))) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener((message) => {
    try {
      port.postMessage(reply(message));
    } catch {
      // The page closed the port. Do not log: the payload may not be a ping.
    }
  });
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!originAllowed(senderOrigin(sender))) return;
  sendResponse(reply(message));
});
