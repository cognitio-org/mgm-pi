# Chrome companion

The Manifest V3 extension Outfitter's session page talks to. This directory is the pinned id, the page channel (ping, placement, split), and the options page. Capture, the side panel, and the native host are later slices. Nothing here is published to the Chrome Web Store.

## Permissions

The manifest asks for `storage`, `tabs`, and `tabGroups`. `tabs` is the permission Chrome describes as reading browsing history; placing a tab group needs it. There is no `<all_urls>`, no `debugger`, and no `nativeMessaging`. The options page keeps two values in `chrome.storage.local`:

- `OUTFITTER_TOKEN`, a Dongle (`outf_…`)
- `OUTFITTER_API`, the link origin printed on the Tokens page

The Dongle is not logged. It is not written anywhere on the options page except the field the user is typing in. A Dongle already saved is not copied back onto the page.

`externally_connectable` is not a permission. It names the three page origins that may open a connection:

- `https://app.kernal.one/*`
- `http://localhost/*`
- `http://127.0.0.1/*`

The service worker drops any sender whose `sender.origin` is not one of those sites. `sender.url` is not checked and is not a substitute. The page channel accepts `ping`, `place` (`own`, `shared`, `window`), `split`, `poll`, and `openPanel`. A `ping` is answered `{ok:true, version, id}`. `place` opens or focuses a tab this extension already recorded for that Floppy. `split` needs `chrome.tabs.createSplit` (Chrome 155); otherwise the reply is `{ok:false, error:"split_unavailable"}` and no window is opened. `poll` is accepted and does nothing until capture exists. `closeTab`, `capture`, and any message with a `tabId` are rejected. Placements are stored in `chrome.storage.local` and dropped on `tabs.onRemoved`.

## Install

`kernal/scripts/install.sh` (which `kernal update` runs) copies this extension to `~/.kernal/chrome/extension` and the native host to `~/.kernal/chrome/host`. Those paths stay put when the versioned bundle moves. It registers `com.kernal.chrome` only after checking that Node, or the bundle's pi binary, can start the host. If neither can, it says so and does not write a manifest.

Chrome still does not load the extension from the install. The installer prints the steps below and opens `chrome://extensions`. It does not edit Chrome's preferences, and it does not claim the extension is loaded.

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select `~/.kernal/chrome/extension` (or `chrome/extension` in this repo, for a checkout).
4. Open the extension's options. Paste `OUTFITTER_TOKEN` and `OUTFITTER_API` from the Tokens page.

The id does not change between loads. `manifest.json` pins it with a public `key`, and `chrome/extension-id` is that id, one line. After an update, reload the extension at `chrome://extensions`. An unpacked extension keeps running the old files until then.

## Tests

`protocol.js` and `placement.js` have no Chrome APIs. From `chrome/`:

```bash
npm test
```
