# Spec: Chrome companion for Outfitter and Kernal

Status: ready to implement (2026-09-23).
Audience: an agent implementing one GitHub sub-issue of the epic. Read this whole document before editing. The issue you were given says which slice is yours. Do not start a sub-issue marked follow-on.

Decisions locked with the product owner on 2026-09-23:

| Topic | Decision |
|---|---|
| First cut | Side panel, notifications, tab placement (per-Floppy group, shared Floppies group, new window, split view), and a read-only shared tab. A share reports the tab's title, URL, and a screenshot to local Kernal and to a cloud Drive. |
| Out of the first cut | Clicks and typing, `chrome.debugger` attach, WebMCP on `app.kernal.one`, a Playwright gate before checkpoint. Filed as follow-on sub-issues. Do not implement them. |
| Who may request a capture | Anyone who can already steer that Floppy. The share owner's Chrome takes the screenshot. |
| What the share authorizes | That one tab's title, URL, and later screenshots of that same tab, until the owner revokes the share. A request cannot name a different tab. |
| Notification | Shown before the screenshot is taken and before the bytes are uploaded. The shot then proceeds. Revoke on the notification cancels an upload that has not finished and ends the share. The owner's own capture from the side panel does not notify. |
| Install | Unpacked, shipped with Kernal. No Chrome Web Store. The native-messaging host is registered by the installer. Updates ride with `kernal update`. |
| Where the code lives | Extension and host in a new top-level `chrome/`. Spec is this file. Issues on `cognitio-org/mgm-pi`. |

Kernal is the local coding agent (`kernal/`).

---

## 1. What this is

A Manifest V3 Chrome extension, plus a small native host, plus a narrow addition to Outfitter's link API. The extension is the only thing that can see the user's Chrome. A Drive (a Cloud Run Job) and a Kernal process never receive a DevTools port.

Two clients use the same extension:

- **Local Kernal**, through the native host's unix socket, while `kernal` is running on the laptop.
- **An Outfitter Drive**, through the link service. The extension holds a Dongle (a personal `outf_` API token) and polls the link origin. The sandbox never holds that token.

The Outfitter page at `https://app.kernal.one` talks to the extension with `chrome.runtime.connect`. That channel is only for pairing, opening the side panel, and placing tabs. It cannot ask for a capture, read a tab the user did not share, or close a tab the extension did not open.

## 2. Non-goals (first cut)

- Clicking, typing, navigating, or evaluating script in the shared tab.
- Attaching the DevTools Protocol (`chrome.debugger` or `chrome-devtools-mcp`).
- WebMCP tools on the Outfitter origin.
- Running Playwright inside a Drive, or any screenshot of a page the Drive itself is serving.
- A preview URL for a Floppy. Split view pairs two Outfitter session tabs, not a session and a dev server.
- Publishing to the Chrome Web Store.
- Silently injecting the extension into an already-installed Chrome. Official Chrome has no supported way to do that. First install has one manual step (§7).
- Storing screenshots in GCS. Blob offload is still a TODO (`packages/api/src/store/types.ts`). Captures live in Mongo, size-capped.

## 3. Chrome constraints the implementation must respect

These are why the shape is what it is. Do not "simplify" past them.

1. **IAP fronts the web service.** `outfitter-api` (`OUTFITTER_ROLE=web`) is behind Identity-Aware Proxy. An extension fetch to `https://app.kernal.one` does not carry the user's IAP cookie in a useful way. The extension and the native host call the **link** origin only, with `Authorization: Bearer outf_...`. The link role today registers teleport routes plus `GET /api/me` (`packages/api/src/routes/index.ts`). This spec adds a browser-client subset there. It does not add guru, operator, or token-management routes.

2. **A Dongle on the link role currently cannot steer.** `POST /api/sessions/:id/messages`, `POST /ui-response`, `POST /abort`, and `GET /entries` exist on the web role only (`routes/sessions.ts`). The side panel needs them. Adding them to the link role means a Dongle can steer any session. That matches the existing org-shared rule: any signed-in user can already steer any Floppy. Document the new routes in `docs/protocol.md` in the same change.

3. **Mail text is capped at 32,000 characters** (`POST /messages`). A screenshot does not go in that field.

4. **`captureVisibleTab` captures the visible tab of a window**, and only for an origin the extension has host permission for. There is no `<all_urls>` permission at install. On the Share click (a user gesture), call `chrome.permissions.request({ origins: [that origin] })`. Later captures of that origin work without a new gesture. If the user denies, the share still records title and URL, and a capture returns `permission_denied`.

5. **To screenshot a shared tab that is not in front**, activate it, capture, then restore the previously active tab in that window. The user sees a brief switch. If the shared tab is gone or discarded, fail with `tab_gone`. Never capture a different tab instead.

6. **Split view creation needs Chrome 155.** `chrome.tabs.createSplit` and `tabs.create({ splitWithTabId })` shipped the week of 2026-09-16. Two tabs can be split only when they are adjacent, in the same window, not pinned, and in the same tab group (or both ungrouped). Detect the method. When it is missing, hide the Split control. Do not approximate a split with two OS windows.

7. **The Manifest V3 service worker is killed when idle.** Do not keep the Outfitter socket, the poll loop, or share state only in worker memory. Persist shares and the Dongle in `chrome.storage.local`. Poll from the side panel every 2 seconds while it is open. While a share is active and the panel is closed, use `chrome.alarms` at the minimum period Chrome allows on this version (confirm the minimum; do not assume 1 minute or 30 seconds without checking). The session page, when it is open, may send `{t:"poll"}` so a request raised while the user is looking at the Floppy is picked up immediately.

8. **`chrome.tabs` permission** shows Chrome's "Read your browsing history" warning. It is required to place tab groups and to read the URL of a tab that is not active. Do not request any broader permission to avoid that warning.

## 4. Repository layout

```
chrome/
  extension/          Manifest V3 extension (unpacked)
    manifest.json     includes the pinned "key"
    background.js     service worker
    panel.html / panel.js
    options.html / options.js
    protocol.js       message parsing and origin checks (unit-tested, no Chrome APIs)
  extension-id        the 32-character id, one line, generated with the key
  host/
    kernal-chrome-host.mjs
    protocol.js       socket framing (unit-tested)
  README.md           install, permissions, and the manual Load unpacked step
```

Kernal changes stay in `kernal/` (installer, a `kernal-chrome` pi extension, tests). Outfitter changes stay in `outfitter/` (link routes, agentd frame, pi tool, transcript rendering, `SessionPage` controls).

The extension id is stable because `manifest.json` contains a `"key"`. Generate the keypair once in the scaffold issue, commit the public key and `chrome/extension-id`, and hardcode that id in the web app. Do not read the id from the Chrome Web Store.

`externally_connectable.matches`:

- `https://app.kernal.one/*`
- `http://localhost/*`
- `http://127.0.0.1/*`

Every `onConnectExternal` / `onMessageExternal` handler drops the connection unless `sender.origin` is one of those origins. `sender.url` is not a substitute for `origin`.

## 5. Page-to-extension messages

The session page (`packages/web/src/pages/SessionPage.tsx`) opens `chrome.runtime.connect(EXTENSION_ID, { name: "floppy:"+sessionId })` when `chrome.runtime` exists. If the call throws or the port disconnects immediately, the page renders no Chrome controls. Outfitter works as it does today.

Accepted messages, and only these:

| Message | Effect |
|---|---|
| `{t:"ping"}` | Reply `{ok:true, version, id}`. |
| `{t:"place", sessionId, url, title, mode}` | `mode` is `own`, `shared`, or `window`. See §6. |
| `{t:"split", sessionId, otherSessionId}` | See §6. Reply `{ok:false, error:"split_unavailable"}` when `createSplit` is missing. |
| `{t:"poll"}` | Wake an immediate capture-request poll for this session. |
| `{t:"openPanel"}` | Open the side panel. |

Reject anything else, including `closeTab`, `capture`, and any message that carries a tab id from the page. The extension remembers the tab ids it opened and will only close or move those.

## 6. Tab placement and split

All three placement modes are offered from `SessionPage` when the extension answers a ping. The page passes the Floppy's own URL (`https://app.kernal.one/sessions/<id>` or the local dev origin) and its title.

- **`own`** — open the session URL in a tab group whose title is the Floppy's name (truncated to Chrome's group-title limit) and whose color is stable per session id. If the extension already has a tab for that session, focus it instead of opening another.
- **`shared`** — open or focus the session tab inside one group titled `Floppies` in the current window. Create the group if it is gone.
- **`window`** — `chrome.windows.create` with the session URL, then group that tab as in `own`.

The extension stores `{sessionId, tabId, windowId, groupId}` in `chrome.storage.local`. On `tabs.onRemoved`, drop the record.

**Split** pairs two session tabs the extension already owns. Put them in the `Floppies` group, move them so they are adjacent, then `chrome.tabs.createSplit([idA, idB])`. If either tab is missing, open it first. If Chrome reports the tabs cannot be split, leave them grouped and surface the error in the panel. Closing one tab of a split is Chrome's business: the other tab remains, and the extension updates its records from `tabs.onUpdated`.

## 7. Install and update

Files the user loads are copied to stable paths, not into the versioned bundle directory (`~/.kernal/kernal-<version>-<platform>` moves on every upgrade):

- Extension: `~/.kernal/chrome/extension`
- Host: `~/.kernal/chrome/host/kernal-chrome-host.mjs`

`kernal/scripts/install.sh` and the update path in `kernal/bin/kernal` do three things:

1. Copy `chrome/extension` and `chrome/host` into those stable paths. A later `kernal update` overwrites them in place.
2. Write the native-messaging manifest.
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kernal.chrome.json`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/com.kernal.chrome.json`
   - `allowed_origins` is `chrome-extension://<id>/` using `chrome/extension-id`.
   - `path` is the stable host path. The host is started with `node` if that is how the bundle runs it; a release bundle has no promise of a system Node. Ship the host as a script the extension's documented launcher runs with the `node` that is already required for a source checkout, and for a release bundle run it with the same Bun/node note the implementer verifies against `kernal/scripts/package.sh`. If a release bundle cannot run the host, say so in the installer output rather than writing a manifest that points at a missing runtime. This is a real check, not a footnote.
3. On first install, print the Load unpacked steps and open `chrome://extensions`. Do not edit Chrome's `Preferences` to force the load.

An already-loaded unpacked extension keeps running old files until it is reloaded. After an update, the installer prints "Reload the Kernal extension at chrome://extensions". The options page shows `chrome.runtime.getVersion()` so the user can see which copy is live.

`install.test.ts` gains a case that the host manifest is written with the pinned extension id and the stable host path, and that a second run overwrites the path rather than duplicating the file.

## 8. Native host protocol

Chrome starts `com.kernal.chrome` on `runtime.connectNative`. The host speaks Chrome's native-messaging framing on stdin/stdout (4-byte little-endian length, then JSON). It also listens on `~/.kernal/chrome.sock` (mode `0600`). Kernal is the unix-socket client. Chrome is the native-messaging client. The host bridges them. If Kernal is not connected, local tool calls fail and the cloud path still works.

Socket messages are one JSON object per line.

Kernal → host:

| Message | Response |
|---|---|
| `{t:"list"}` | `{t:"shares", shares:[{tabId, title, url, sessionId}]}` |
| `{t:"capture", tabId}` | `{t:"captured", tabId, title, url, path}` or `{t:"error", error}` |

`path` is a jpeg the host wrote under `~/.kernal/chrome/captures/`, mode `0600`, overwritten per tab so the directory does not grow without bound. The Kernal tool copies it into the session workspace if it needs the file to outlive the next capture.

Host → Kernal, unsolicited: `{t:"share", ...}` and `{t:"unshare", tabId}` when the user shares or revokes.

The host refuses `capture` for a tab id that is not in the current share list.

## 9. Link API

Authenticated the same way as teleport: `Authorization: Bearer outf_...` on the link role, and IAP or the same bearer on the web role. Identity is the token owner's email, already resolved by `identityFromApiToken`.

### 9.1 Routes moved onto the link role

Register these existing handlers for `OUTFITTER_ROLE=link` as well as web. Do not register the rest of `registerSessionRoutes`.

- `GET /api/sessions/:id/entries`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/ui-response`
- `POST /api/sessions/:id/abort`

`GET /api/sessions` and `GET /api/sessions/:id` are already on the link role. Extend the detail payload with `pendingUiRequest` from the active run (`Run.pendingUiRequest` in `store/types.ts`) so the panel can show an approval without scraping entries. `null` when there is none.

### 9.2 Share and capture

One share per session. Creating a share replaces the previous one for that session only if the caller is the same email. A different email gets `409`.

| Route | Who | Body / result |
|---|---|---|
| `PUT /api/sessions/:id/browser/share` | Share owner | `{tabTitle, tabUrl}`. Stored with `ownerEmail`, `createdAt`. |
| `DELETE /api/sessions/:id/browser/share` | Share owner | Revoke. Pending requests become `skipped`. |
| `GET /api/sessions/:id/browser/share` | Any authenticated caller | `{tabTitle, tabUrl, ownerEmail, createdAt}` or `404`. No image. |
| `POST /api/sessions/:id/browser/requests` | Any authenticated caller | Creates `{id, requesterEmail, status:"pending"}`. `409` when the session has no share. |
| `GET /api/sessions/:id/browser/requests?status=pending` | Share owner | Pending requests for the extension to act on. Other callers get `404` (do not reveal the queue). |
| `GET /api/sessions/:id/browser/requests/:requestId` | The requester or the share owner | Status, so a waiting tool can poll. |
| `POST /api/sessions/:id/browser/requests/:requestId/revoke` | Share owner | If not yet `done`, mark `skipped` and drop an in-progress upload. |
| `POST /api/sessions/:id/browser/requests/:requestId/fail` | Share owner | `{error}` is `permission_denied`, `tab_gone`, or `too_large`. A pending request becomes `failed` and the API sends `{t:"browser.capture.result", requestId, error}`. A repeat does not insert a row or send the frame again. |
| `POST /api/sessions/:id/browser/captures` | Share owner | `{requestId, title, url, jpegBase64}`. |
| `GET /api/sessions/:id/browser/captures/:captureId` | Any authenticated caller | `image/jpeg` bytes. |

Capture rules:

- Decoded jpeg at most 350,000 bytes. Larger is `413`. The extension resizes and recompresses to fit before uploading. Viewport capture, not a full-page stitch.
- `title` and `url` are stored for display. They are not fetched server-side.
- The jpeg bytes live in a new store collection `browserCaptures` (`{sessionId, requestId, ownerEmail, requesterEmail, title, url, bytes, createdAt}`). Mongo documents must stay under 16 MB; the byte cap keeps them small. Keep the last 20 captures per session and delete older ones in the same write.
- On success, mark the request `done` and store `captureId`.
- Also append a pi custom entry `outfitter.browser.capture` with `{captureId, title, url, requesterEmail}` through the same entry path agentd already uses for custom entries, so a reconnect cannot duplicate it. If the implementer finds that path is only writable from agentd, write the entry from the API once, keyed by `requestId`, and test that a retried upload does not insert a second entry.
- `requesterEmail` is taken from the authenticated identity. Ignore any email in the body.

`docs/protocol.md` gains a "Browser companion" section that lists these routes and states the link-role expansion.

Tests live next to the existing API tests and cover: owner-only upload, other-email `409` on share replace, `413` over the byte cap, request `409` with no share, pending list hidden from non-owners, revoke skips a pending request, duplicate upload of the same `requestId` returns the original `captureId`.

## 10. Extension behavior for a share

**Share** is a user gesture in the side panel or the context-menu item "Share this tab with the Floppy". It applies to the active tab. The panel asks which open Floppy (from `GET /api/sessions` on the link origin) is the target. Flow:

1. `permissions.request` for that tab's origin.
2. Record the share locally (`tabId`, `sessionId`, `windowId`).
3. `PUT` the share.
4. `connectNative` if the host is not already connected, so local Kernal hears `{t:"share"}`.

**Revoke** from the panel, from the notification's Revoke action, or when the tab closes. `DELETE` the share and tell the host `{t:"unshare"}`.

**A capture request** noticed by polling or by `{t:"poll"}`:

1. If `requesterEmail` is the share owner and the request was created by the panel's own button, skip the notification. (The panel sets this by calling the request route itself and remembering the id.)
2. Otherwise create a Chrome notification first: which email asked, the Floppy name, the tab title. Actions: Revoke. The notification id is the request id.
3. Activate the shared tab, `captureVisibleTab` on its window, restore the previous active tab.
4. Recompress under the byte cap.
5. If Revoke arrived before the upload returned, do not upload. Call the revoke route if the local revoke has not already.
6. `POST` the capture.
7. On `permission_denied`, `tab_gone`, or `too_large`, retry once, then `POST` the fail route so the Drive hears the error, and surface it in the panel. Other failures leave the request pending. Do not retry forever.

The context menu and the panel button are the only ways to create a share. The session page cannot.

## 11. Side panel

`side_panel` default path is the panel page. `setPanelBehavior({ openPanelOnActionClick: true })` so the toolbar icon opens it.

The panel is an extension page. It uses the Dongle from `chrome.storage.local` against the link origin. It does not iframe `app.kernal.one`.

While open it shows:

- The linked Floppy's name and run state (`GET /api/sessions/:id`).
- The last few transcript lines (`GET /entries`), plain text, newest at the bottom. This is a strip, not the full transcript. A "Open Floppy" control focuses the session tab.
- A one-line steer box (`POST /messages`, `behavior` `followUp`).
- The pending approval, when `pendingUiRequest` is set, with the same answers the web `UiRequestPanel` offers (`POST /ui-response`). Break calls `POST /abort`.
- Share status for the active tab: not shared, shared, or permission denied. Share and Revoke buttons.
- A line when a capture is in progress: "Capturing for <email>".

The options page holds the Dongle and the link origin. The Tokens page in the web app already prints the link origin and the `OUTFITTER_API` / `OUTFITTER_TOKEN` lines (`docs/protocol.md`, personal API tokens). The options page repeats those two field names so the user pastes the same values. The Dongle is stored in `chrome.storage.local` only. It is not written into the native host, the socket, or a Floppy transcript.

Poll every 2 seconds while the panel document is visible. Stop the timer when it is hidden.

**Approval notification.** When a share or a pinned Floppy is set and the panel is not open (`runtime.getContexts` has no `SIDE_PANEL` for this extension), the alarm poll checks `pendingUiRequest`. Notify once per request id. Clicking the notification focuses the panel. Do not also notify when the panel is open.

An idle-stop countdown is not part of this cut.

## 12. Local Kernal tool

New pi extension `kernal/.pi/extensions/kernal-chrome/`. It registers two tools. They speak to `~/.kernal/chrome.sock` and do nothing on the network.

- `browser_tabs` — the share list (title, url, tab id).
- `browser_capture` — `{tabId}`. Returns text: title, url, and the workspace-relative path of the copied jpeg. Verify whether pi 0.86 tool results can carry an image content block (see `outfitter-mail.ts`, which only returns `{type:"text"}`). If a supported image block exists, attach the jpeg as well. If it does not, do not invent a content type. The text path is the contract.

Missing socket: the tool result says the Chrome companion is not running. Unknown tab id: the tool result says that tab is not shared. No throw out of the tool.

## 13. Cloud tool

Loaded the same way as `outfitter-mail.ts`: agentd adds the extension only inside a Drive. The sandbox must not receive `OUTFITTER_TOKEN`.

`browser_capture` takes no tab id. The session has at most one share.

Blocking path:

1. The tool `fetch`es `http://127.0.0.1:<port>/browser/capture` on a listener agentd binds to loopback only while this extension is loaded.
2. agentd sends an up-frame `{t:"browser.capture.request", requestId}` on its existing API socket.
3. The API creates the request row (§9.2) or immediately answers `{t:"browser.capture.result", error:"no_share"}`.
4. agentd waits up to 90 seconds for `{t:"browser.capture.result", requestId, captureId, title, url}` or `{error}`.
5. On success, agentd `GET`s the jpeg and writes `/workspace/.outfitter/captures/<captureId>.jpg` (directory mode `0700`, file mode `0600`).
6. The tool returns title, url, and that path, with the same image-block rule as §12.

Errors the model can read, as text, not exceptions: `no_share`, `skipped` (owner revoked before upload), `timeout`, `permission_denied`, `tab_gone`, `too_large`. The extension reports those last three on the fail route after one retry; the API forwards the error immediately instead of leaving the request pending until the 90s wait.

A retried tool call with the same in-flight request must not create a second request row. agentd generates `requestId` once per tool call and the API treats a repeat of that id as the same row.

Update `docs/protocol.md`'s agentd frame list with the two new frames.

## 14. Transcript

`packages/web` renders a custom entry `outfitter.browser.capture` as the jpeg from `GET /api/sessions/:id/browser/captures/:captureId`, with the title and URL as text under it. The image request uses the page's existing credentials. A failed image load shows the title and URL and the retro error already used for a failed API call, not a broken-image icon with no text.

The side panel does not render the jpeg. It only says a capture happened.

## 15. Security checks for every slice

- Drop external messages whose `sender.origin` is not allowlisted.
- The page channel's vocabulary is the table in §5 and nothing else.
- Capture only a tab id the extension recorded when the user shared it.
- Upload and revoke routes accept only the share owner's identity.
- `requesterEmail` comes from the server-side identity, never from the client body.
- The Dongle is not logged, not put in a tool result, and not sent to the sandbox.
- Jpeg responses are `Content-Type: image/jpeg` and are not sniffed as HTML.
- The unix socket is `0600` and the host rejects capture requests for unshared tabs.

## 16. How to tell the first cut is done

On a laptop with the extension loaded and a Dongle pasted:

1. Open a Floppy on `app.kernal.one`. The page shows placement controls only because the extension answered `ping`.
2. "This Floppy's group", "Floppies group", and "New window" each open or focus the session tab in the place they name. A second click focuses the existing tab.
3. With two Floppies placed, Split puts their tabs side by side on Chrome 155 or newer, and the control is absent on older Chrome.
4. The side panel steers, shows an approval, and Breaks, with the Outfitter tab in the background.
5. Share the active tab. A local `kernal` session's `browser_capture` tool returns the title, URL, and a jpeg path. The previously active tab is in front again.
6. A Drive on that Floppy calls `browser_capture`. The owner's notification appears before the shot. The tool result includes the path. The transcript shows the image. Revoke during the shot yields `skipped` and no new image.
7. A second Outfitter user, steering the same Floppy, can request the capture. They cannot `PUT` a share or `POST` a capture for the owner's share.
8. With the extension not installed, the session page has no Chrome controls and the tools return a clear not-connected or no-share result.

## 17. Follow-on work

Filed as sub-issues and not part of the first cut:

- **Clicks and typing** on the shared tab, each action confirmed in the panel or a notification before it runs.
- **DevTools attach** via `chrome.debugger` on the shared tab only, for the console and the selected element. One debugger client on that tab.
- **WebMCP** on the Outfitter web app: list, play, steer, break, stop, eject, read the transcript, running as the signed-in user.
- **Playwright gate** inside the Drive: a Tape option that runs a Playwright spec against a fresh headless browser before checkpoint and attaches the report. This does not attach to the user's Chrome.

## 18. Issue map

The epic's sub-issues are the slices. Dependencies:

| Slice | Depends on |
|---|---|
| Extension scaffold | none |
| Link API | none |
| Installer and native host | scaffold (needs `chrome/extension-id`) |
| Share, capture, notifications | scaffold, link API |
| Side panel | scaffold, link API |
| Tab placement and split | scaffold |
| Local Kernal tool | installer and native host, share/capture |
| Cloud tool | link API, share/capture |
| Transcript image | link API |

Follow-on sub-issues depend on the first cut being done. Do not start them.
