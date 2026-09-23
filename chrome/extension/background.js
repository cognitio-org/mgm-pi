// Service worker for the companion shell. Pairing only: a ping from an allowlisted page.
// sender.url is never read. A sender with no origin, or any other origin, is dropped.

import { originAllowed, pageReply } from "./protocol.js";

function reply(message) {
  const manifest = chrome.runtime.getManifest();
  return pageReply(message, manifest.version, chrome.runtime.id);
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (!originAllowed(port.sender?.origin)) {
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
  if (!originAllowed(sender?.origin)) return;
  sendResponse(reply(message));
});
