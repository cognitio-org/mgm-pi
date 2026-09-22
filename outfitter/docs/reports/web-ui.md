# Web UI (E3.1, E3.2, E3.4)

A new npm workspace `outfitter/packages/web` (Vite + React 19 + TypeScript strict, react-router)
implementing the fleet list, session view, and new-session dialog. Built to `packages/web/dist`,
which `packages/api/src/routes/static.ts` already served at `/` — that route now also adds an SPA
fallback so client-side routes (`/sessions/:id`, `/providers`) work on a hard reload.

## What was built

**Shell / routing** (`src/App.tsx`, `src/main.tsx`): a header with nav links (Fleet, Providers) and
a `ProviderStrip` placeholder, `react-router-dom` routes for `/`, `/sessions/:id`, `/providers`.

**API client** (`src/api/client.ts`): a thin `fetch` wrapper over every route named in the task —
`/api/me`, `/api/gurus`, `/api/sessions` (list/get/entries/create), `/messages`, `/abort`, `/stop`,
`/wake`, `/ui-response`, `/diff`, and the SSE stream URL. Every request goes out with
`credentials: "same-origin"` (IAP cookies in prod); a bearer header is attached only when
`localStorage.outfitterDevToken` is set (dev only — `OUTFITTER_DEV=1` disables the IAP check
server-side regardless, so the token is optional even then, but the task asked for the header
behavior explicitly). `api.providers()` swallows a 404 into `[]` rather than throwing, per the E3.6
placeholder contract.

**Fleet page** (`src/pages/FleetPage.tsx`): table of sessions (name, run-state pill, guru name,
`repo @ branch`, cost as `$X.XXXX`, relative last-activity), status/guru filters (native `<select>`s
against `GET /api/sessions?status=&guru=`), and a "New session" button opening
`NewSessionDialog`. `GET /api/sessions` already returns `runState`/`cost`/`guru`/`repo`/`branch`/
`updatedAt` per `packages/api/src/routes/sessions.ts`'s `summarize()` — **no API changes were
needed** for E3.1's status/cost/last-activity columns, so no new API tests were added either.

**Providers** (`src/hooks/useProviders.ts`, `src/components/ProviderStrip.tsx`,
`src/pages/ProvidersPage.tsx`): both the header strip and the `/providers` page call
`GET /api/providers` and render nothing / an empty-state message on a 404, matching the documented
future shape `{ providers: [{ id, kind, name, status, detail?, checkedAt }] }` from another
in-flight workstream (E2.10/E3.6). Nothing here assumes that endpoint exists yet.

**Session view** (`src/pages/SessionPage.tsx`): loads `GET /api/sessions/:id` for header metadata
(name, guru, repo/branch, cost) and entries + live updates via `useSessionStream`
(`src/hooks/useSessionStream.ts`), which does an initial `GET .../entries` then opens an
`EventSource` on `GET .../stream` and applies `entry`/`status`/`event`/`spend` frames (deduping
entries by id, since a reconnect can replay). `event` frames of type `extension_ui_request` become
`pendingUiRequest`, rendered by `UiRequestPanel` with `select`/`confirm`/`input` methods (the
interactive subset of `RpcExtensionUIRequest` from `@earendil-works/pi-coding-agent`'s
`modes/rpc/rpc-types.d.ts` — `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` are
display-only and never populate `Run.pendingUiRequest` per protocol.md, so they're not handled).
Answers post to `/ui-response {id, value}`. `Composer` sends plain/steer/follow-up messages;
Abort/Stop/Wake buttons call their routes and are enabled/disabled off the live run state. "Open in
terminal" copies `mgm --teleport <id>` to the clipboard (E4.4).

**Entry rendering** (`src/lib/entry-view.ts`, `src/components/EntryItem.tsx`): `entryToViews` maps a
raw `PiEntry` (as defined by `@earendil-works/pi-coding-agent`'s `SessionEntry` union — `message`
with `AgentMessage` roles user/system/assistant/toolResult, `model_change`, `compaction`, `custom`,
`custom_message`, `label`, `session_info`) into small view records; an assistant message's content
array (text/thinking/toolCall blocks) becomes one view item per block. `EntryItem` renders each kind
with minimal styling (no markdown, no syntax highlighting).

**New session dialog** (`src/components/NewSessionDialog.tsx`): guru select, optional repo text
field (empty = no repository, matching `repo: body.repo ?? null` in `sessions.ts`), base
branch/branch fields shown only when a repo is entered, prompt textarea, optional model override.
Posts to `POST /api/sessions` and navigates to the new session on success.

**Styling** (`src/style.css`): one plain stylesheet, dark-friendly via
`@media (prefers-color-scheme: light)` override (default is dark), no UI framework, a single
`@media (max-width: 600px)` rule to keep the fleet table usable at phone width.

## API changes

One, unrelated to the "extend the list endpoint" contingency the task flagged: `static.ts` gained an
SPA fallback (`app.setNotFoundHandler`, gated to non-`/api/`, non-`/agent/` GET requests, registered
only when `packages/web/dist` exists) so `/sessions/:id` and `/providers` don't 404 on a direct
navigation or reload. `packages/api/Dockerfile` now has a builder step that runs
`npm run build --workspace=@outfitter/web` and the final stage copies only
`packages/web/dist` — the web workspace's own `node_modules` (React, Vite, etc.) never reach the
runtime image, per the "ship dist, keep the image small" constraint. Verified locally: image builds,
boots with the same deploy-shaped env as the CI `images` job, `GET /`, `GET /sessions/x` (SPA
fallback), `GET /api/sessions` (real route) and `GET /assets/*.js` all return 200 as expected, and
`GET /api/nope` still returns the API's own JSON 404 rather than falling through to `index.html`.

No route, type, or store change was needed beyond that — `GET /api/sessions`'s existing
`SessionSummary` shape already carries everything E3.1 needed.

## What was left out and why

- **`@earendil-works/pi-web-ui` was not used.** It ships mini-lit web components built directly
  against `@earendil-works/pi-ai`'s `Message` type, not pi's persisted `SessionEntry` tree (parentId
  links, plus `model_change`/`compaction`/`custom`/`label`/`session_info` entries it doesn't need to
  know about) or the outfitter-api's own SSE framing. Adapting its message components and bridging
  its custom elements into a React tree — versus the ~150-line hand-written `entry-view.ts` +
  `EntryItem.tsx` this story shipped instead — was more integration surface than this story's budget
  covers; noted here per the task's explicit fallback instruction.
- **E3.3 (diff/files tabs)** is out of scope for this story (E3.1/E3.2/E3.4 only); the API client
  does expose `api.diff(id)` since it maps directly to `GET /api/sessions/:id/diff`, but no diff
  viewer UI was built.
- **E3.5 (cost page) / E3.6 (full providers dashboard)** are separate stories; only the
  E3.6-compatible `ProviderStrip` placeholder and a bare `/providers` table (explicitly asked for in
  this story) exist.
- **No markdown rendering or syntax highlighting** in the transcript — plain `white-space: pre-wrap`
  text, consistent with "hand-written, minimal" entries.
- **Parent/child session grouping** (mentioned in EPIC.md's E3.1 one-liner) was not built: the fleet
  table is a flat list. `SessionSummary.parentId` is threaded through the API client's type but
  unused in the UI. Flagging this as the one EPIC.md line this story doesn't fully cover; the REST
  API and protocol.md's own route list for E3.1/E3.2/E3.4 don't call it out as required, so it was
  treated as optional given the budget.

## Local dev

```sh
cd outfitter
npm install
npm run dev --workspace=@outfitter/api      # http://localhost:8082, MONGODB_URI=memory works out of the box
npm run dev --workspace=@outfitter/web      # http://localhost:5173, proxies /api to :8082
```

Set a dev bearer token in the browser console if you want to exercise the `Authorization` header
path even though `OUTFITTER_DEV=1` doesn't require it: `localStorage.outfitterDevToken = "whatever"`.

Tests and build:

```sh
npm test --workspace=@outfitter/web         # vitest: 18 tests (api client, relative-time, entry-view)
npm run build --workspace=@outfitter/web    # tsc --noEmit + vite build -> packages/web/dist
npm test --workspace=@outfitter/api         # unchanged API tests still pass (91 tests, unaffected)
npm run build --workspaces --if-present     # root build, now also builds @outfitter/web
docker build -f packages/api/Dockerfile -t outfitter-api outfitter/   # builds and ships web/dist
```
