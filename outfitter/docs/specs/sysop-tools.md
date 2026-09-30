# Sysop tools: self-administration, session search and transcripts

Epic #291. Status: PR1 (#286) implements the op registry, `adminTools`, the audit collection and
`POST /api/admin/ops`. Where this spec and the code differ, "Changes since the plan" below wins.

## Context
Outfitter and Kernal should be able to administer and develop themselves. Today an agent that wants to
create a Tape (code name: Guru) has to find the right API endpoints, and it usually cannot reach them:
- In a Drive, pi has no Outfitter credential. agentd strips `RUN_TOKEN`/`OUTFITTER_*` (`outfitter/packages/agentd/src/pi.ts:108-124`), and every tool reaches the API through agentd (GitHub socket, mail entries, browser loopback).
- Locally, Kernal only knows the teleport routes on the link origin (`kernal/.pi/extensions/teleport/outfitter-store.ts`). The link role has no tape routes (`outfitter/packages/api/src/routes/index.ts:46-52`).

The goal is a small set of built-in tools with short descriptions, plus a skill for the workflow. With
these, an agent can create, update and test a Tape (and do other admin tasks) from Kernal or from a Drive
started in the web UI, without learning the API.

Decisions (confirmed with the owner):
- **Authority:** an agent acts as the session owner, with the API brokering every call. Operator actions also need a Tape opt-in and human approval.
- **Confirmation:** create and update apply directly and return a diff. Deletes and operator actions need a human confirmation.
- **Local Kernal:** add Tape and environment routes to the link role for Dongles. Operator routes stay unreachable from a Dongle.
- **Tape skills and packages:** out of scope; a later epic.

## Changes since the plan (PR1)
- **One op endpoint, not REST routes on link.** The laptop reaches the op registry through
  `POST /api/admin/ops {op, args, confirmed?}` (routes/admin.ts), registered on web and link. The
  gurus/environments REST routes stay web-only. A Drive's admin socket (#287) calls the same
  `runAdminOp`, so there is one set of checks and one text renderer for both transports.
- **`adminTools` from an agent is refused, not stripped:** a one-line 403 ("adminTools can only be
  set in the web UI") tells the agent why, where silently dropping it would not. A Dongle caller
  counts as an agent on every route (`Identity.viaToken`).
- **A write to a tape that already has admin tools needs approval,** like a delete, so an agent
  can't rewrite the Sysop tape's prompt unseen.
- **Laptop approval** is `confirmed: true` after Kernal's TUI confirm; the Dongle's holder is the
  person at the keyboard. A Drive never gets this shortcut: its approval is the web card (#287).
- **Only a sysop may change or delete a tape with `adminTools: operator`**, a person in the web UI
  included; a Dongle never can. An agent's delete always needs approval, on the op path and on the
  REST route alike.
- **Env values never reach an agent:** `get` prints env names with "(values hidden)", and an update
  prints `env: +NEW, -OLD, ~CHANGED`.
- **Stricter tape types** (strings, string lists, a string map for env), and create/update keep only
  known fields, so a dotted key such as `env.LD_PRELOAD` can't reach Mongo's `$set`.
- **Reserved ids:** agents can't create `default` or `sysop`.
- **Agent-created tape ids** are slugs (`[a-z0-9-]`), so later calls stay short; UUID ids print
  as 8-character prefixes and any unique prefix of 4+ characters resolves.

## Changes since the plan (PR2)
- **Approvals reuse the session's confirm card,** answered through `POST /api/sessions/:id/ui-response`
  (the api handles the run's own `admin:<id>` itself). There is no `/admin-approvals` route. The card
  carries `source: "outfitter"`, which pi events can't claim, so the page draws it as "Outfitter asks
  you (not the agent)" with Allow/Deny; every card's buttons wake 1 s after it appears.
- **Approvals live in `adminApprovals`,** one per run, with conditional claim/decide/clear, not on
  the run document (which several routes return whole).
- **Only the owner, as a person, sees the card:** GET filters by identity; SSE filters per stream.
- **The card is all api words:** the resolved target's name and full id, the known field names, the
  start of a new prompt. The approved op acts on that full id, after re-reading the tape and rights.
- **A Drive asks first, then runs once** (`approvalNeeded`), so an approved op writes one audit row.
  Write replays are deduplicated by idempotency key; 8 admin requests per run at most.
- **No protocol version bump:** an older api never sends `adminTools`, so agentd never opens the socket.

## Changes since the plan (PR1)
- **One op endpoint, not REST routes on link.** The laptop reaches the op registry through
  `POST /api/admin/ops {op, args, confirmed?}` (routes/admin.ts), registered on web and link. The
  gurus/environments REST routes stay web-only. A Drive's admin socket (#287) calls the same
  `runAdminOp`, so there is one set of checks and one text renderer for both transports.
- **`adminTools` from an agent is refused, not stripped:** a one-line 403 ("adminTools can only be
  set in the web UI") tells the agent why, where silently dropping it would not. A Dongle caller
  counts as an agent on every route (`Identity.viaToken`).
- **A write to a tape that already has admin tools needs approval,** like a delete, so an agent
  can't rewrite the Sysop tape's prompt unseen.
- **Laptop approval** is `confirmed: true` after Kernal's TUI confirm; the Dongle's holder is the
  person at the keyboard. A Drive never gets this shortcut: its approval is the web card (#287).
- **Only a sysop may change or delete a tape with `adminTools: operator`**, a person in the web UI
  included; a Dongle never can. An agent's delete always needs approval, on the op path and on the
  REST route alike.
- **Env values never reach an agent:** `get` prints env names with "(values hidden)", and an update
  prints `env: +NEW, -OLD, ~CHANGED`.
- **Stricter tape types** (strings, string lists, a string map for env), and create/update keep only
  known fields, so a dotted key such as `env.LD_PRELOAD` can't reach Mongo's `$set`.
- **Reserved ids:** agents can't create `default` or `sysop`.
- **Agent-created tape ids** are slugs (`[a-z0-9-]`), so later calls stay short; UUID ids print
  as 8-character prefixes and any unique prefix of 4+ characters resolves.

## Changes since the plan (PR2)
- **Approvals reuse the session's confirm card.** `Run.pendingAdminApproval` is shown through the
  existing `pendingUiRequest` channel (id `admin:<approvalId>`) and answered through
  `POST /api/sessions/:id/ui-response`, which the api handles itself for that prefix. There is no
  new web component and no `/admin-approvals` route. Only the owner, as a person, may answer.
- **A Drive asks first, then runs once** (`approvalNeeded`), so an approved op writes one audit row.
- **No protocol version bump:** an older api never sends `adminTools`, so agentd never opens the socket.

## Design

### Tools (one Kernal extension, two transports)
- New extension: `kernal/.pi/extensions/outfitter-admin/` with `index.ts`, `tools.ts` and `transport.ts`. It ships in the Kernal bundle and in the image, because `image/Dockerfile:46` copies `.pi/extensions`; don't add it to the list removed at `Dockerfile:47-65`.
- There are few tools, each taking an `action` enum. This keeps the prompt small. Descriptions are one line and use `promptSnippet`/`promptGuidelines` like `kernal-chrome/index.ts:52-67`. Schemas are plain JSON Schema cast `as any`, which matches the repo's style.

| Tool | Actions | Notes |
|---|---|---|
| `outfitter_tapes` | `list`, `get`, `meta`, `create`, `update`, `delete` | `meta` returns thinking levels, the env denylist, valid models (from `GET /api/models`) and the caller's capabilities. `update` is partial and returns a field diff. `delete` needs confirmation. |
| `outfitter_environments` | `list`, `get`, `create`, `update` | Same as the REST routes; there is no delete today. |
| `outfitter_sessions` | `list`, `get`, `start`, `stop`, `archive`, `restore` | `start {tapeId, prompt, environmentId?}` lets the agent test a Tape it just built. Owner rules come from `canManageSession`. |
| `session_search` | one call: `{query, mode?: hybrid\|text\|semantic, scope?: cloud\|local\|all, filters?: {tape, repo, owner:"me"\|email, since, until, status, role}, limit?}` | Returns hits as `{sessionId, entryId, name, tape, when, role, snippet, score}`. The default mode is `hybrid`; the default scope is `all` on a laptop and `cloud` in a Drive. See "Session search and transcripts". |
| `session_transcript` | `{sessionId, view?: outline\|text, around?: entryId, window?, fromEntryId?, maxChars?, toolOutput?: none\|trimmed\|full, roles?}` | Returns a compact rendered transcript, never raw JSONL. `outline` gives one line per turn with entry ids. `around` combined with `session_search` jumps straight to a hit. The result is paged with `nextEntryId`. |
| `outfitter_sysop` | `settings`, `secret_test`, `secret_disable`, `tokens_revoke` | Registered only when the capabilities say `operator`. It never takes a secret value, so secrets never enter a transcript; setting one stays a web-UI task. All actions need confirmation. |

- **Transport selection** is in `transport.ts`:
  - **Drive:** `OUTFITTER_ADMIN_SOCKET` is set. Send one JSON line per request (`admin.request` → `admin.result`), with a `reqId`, and an `idempotencyKey` on writes. This copies the shape of `kernal-github/broker.ts`.
  - **Laptop:** `OUTFITTER_API` + `OUTFITTER_TOKEN` are set. Send HTTP with a Bearer token to the link origin. Pull the fetch and error handling out of `teleport/outfitter-store.ts` into `_shared/outfitter-http.ts` and reuse it in both places.
  - **Neither:** register no tools.
- **Local confirmation:** the laptop transport asks for deletes with `ctx.ui.confirm` in the TUI. The human at the keyboard owns the Dongle.

### Token efficiency (a design rule for every tool here)
**Fixed cost, paid on every turn: definitions**
- **Few tools.** There are six tools, each with an `action` enum rather than one tool per endpoint.
  - `outfitter_sysop` is registered only when the capabilities say `operator`.
  - No tool is registered when there is no transport.
  - `session_search` and `session_transcript` still register locally without a Dongle, in local-only scope.
- **Short text.**
  - A tool description is one line of at most about 160 characters. A parameter description is at most about 10 words.
  - No examples go in schemas.
  - `promptSnippet` is one line, and `promptGuidelines` is at most two short rules for the whole extension.
- **Workflow guidance lives in the skill.** pi puts only a skill's name and description in the prompt and loads the body on demand, so how-to text stays out of the per-turn cost.
- **Budget test.** `tests/outfitter-admin-budget.test.ts` serialises every registered definition and fails above a fixed budget, about 1.5 k tokens in total, estimated at 4 characters per token.

**Variable cost: results**
- **Compact text, not JSON.**
  - The API renders results server-side with `?format=text`, which is the default for broker and tool callers. The web UI keeps `format=json`.
  - Lists are one line per item with fixed columns, for example `abc12345  fix-login  tape=coder  2d ago  closed`.
  - Null and default fields are omitted, and inputs are never echoed back.
- **Short ids.** Tools accept any unique prefix of at least 8 characters for session and entry ids, like git, and print 8-character prefixes. Tape ids are already short slugs.
- **Summary first, detail on request.**
  - `list` returns at most 20 rows by default and truncates prompts to about 80 characters.
  - `get` returns the full record.
  - `create` returns `created <id>`. `update` returns only the changed fields as `field: old → new`, with long text shown as a line diff.
- **A hard cap on every result,** 12 k characters by default. When the cap is hit, the tool ends with a one-line notice and a cursor (`more: from=<id>`) instead of silently cutting off.
- **Search results:**
  - Results are grouped by session: a header line per session, then at most 3 hits.
  - A snippet is at most about 200 characters around the highlight.
  - The default limit is 10 sessions.
  - Scores are hidden unless `explain:true`.
- **Transcripts:**
  - `outline` is the suggested first call, at about 1 line per turn.
  - `text` view:
    - drops thinking;
    - turns images into `[image]`;
    - collapses a tool call to `→ tool(args≤120c) ⇒ first 300c`, with `toolOutput:none|trimmed|full` controlling this;
    - folds consecutive identical tool results into `(×N)`;
    - shows each system-prompt or compaction summary once.
  - `around` plus `window` (default 6 entries) reads only the neighbourhood of a search hit.
- **Errors are one actionable line,** for example `tape "x" not found; tapes: coder, sysop, default`, never a stack trace or raw HTTP body.
- **`meta` returns only what's needed.** It lists model ids, filterable with `models:"claude"` for example, with no pricing or context metadata unless asked.
- **Measured.** The fixture tests assert output-size ceilings, such as an outline of a 200-entry session under 3 k characters and a search page under 4 k characters, so a regression fails CI.

### Session search and transcripts
Use cases: diagnosing and debugging a Drive, finding "the session where X broke", and mining past sessions
to write a Tape's prompt.

**Where sessions live**
- **Cloud:** Mongo `sessions` (metadata) plus `entries` (one pi entry per document, `packages/api/docs/data-model.md:36-60`). Existing indexes cover only `sessionId`, `seq` and `_id`, so there is no content search today.
- **Laptop:** pi JSONL files under `~/.kernal/state/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`, about 9 MB today. A session teleported to the cloud is in both places.

**Cloud index: a derived `sessionChunks` collection.** Don't index `entries` directly: pi entries are verbose, deeply nested, and dominated by tool output.
- **Chunker** (`packages/api/src/search/chunker.ts`), one chunk per searchable entry:
  - user and assistant text (thinking blocks dropped),
  - the tool name and arguments, plus the first ~2 KB of tool-result text, where errors show up,
  - compaction summaries,
  - a session-level chunk (name, prompt, Tape, repo).
- **Chunk document:** `{_id: sessionId:entryId, sessionId, entryId, ownerEmail, guruId, repo, role, kind, createdAt, text}`.
- **Redaction** runs before insert and is shared with the existing redaction helpers (`packages/api/src/github-broker.ts`, `packages/agentd/src/logger.ts`). It covers tokens (`outf_`, `ghp_`, `sk-`, JWTs, PEM blocks) and the values of known secrets.
- **When chunks are written:**
  - The chunk is written right after the entry insert in `agentlink.ts` (`entries.insertIfNew`) and in teleport `import`.
  - It is best effort: a failure is logged and never blocks the entry ack.
  - A `search/backfill.ts` script indexes existing sessions.
  - Formatting a session (`deleteForSession`) deletes its chunks.
- **Two Atlas indexes on `sessionChunks`.** That leaves one spare of the 3-index cap on the Free tier.
  - `chunks_text`, an Atlas Search index: `text` with lucene.english, plus token and date filter fields.
  - `chunks_vec`, a Vector Search index with `{type:"autoEmbed", modality:"text", path:"text", model:"voyage-…"}` and `filter` fields `ownerEmail`, `guruId`, `repo`, `role`, `createdAt`. Atlas embeds on write and at query time, so there is no embedding code on our side.
  - Both indexes are created by an idempotent `deploy/atlas-search.sh`. The search indexes have their own admin API, so it can't reuse the normal `createIndex` code.
- **Queries** (`packages/api/src/search/query.ts`):
  - `text` runs `$search`, with `highlight` for snippets.
  - `semantic` runs `$vectorSearch {query: "<text>"}` with pre-filters.
  - `hybrid` runs `$rankFusion` over both, which needs MongoDB 8.0 or later. Then `$group` by session so one session can't flood the results; return the top entries per session.
  - `$rankFusion` can't paginate, so use a `limit` of at most 50.
  - **Visibility:** it matches the rules that already exist. Every signed-in user can list sessions today (E2.2 is still open), so the only default filter is `owner`, and the query accepts `owner:"me"`. If E2.2 later restricts listing, the same filter moves into the query here.
- **Degraded mode:** the in-memory store and dev environment have no Atlas Search. There, `text` uses a plain regex scan, and `semantic`/`hybrid` return a clear "unavailable" error rather than silently falling back.
- **Routes:**
  - `GET /api/search/sessions?q&mode&…`, on web and link.
  - `GET /api/sessions/:id/transcript?view&around&window&from&maxChars&toolOutput&roles`, on web and link.
  - Both are also broker ops (`sessions.search` and `sessions.transcript`, class `read`).

**Transcripts** (`packages/api/src/search/transcript.ts`, one renderer shared by the API and Kernal)
- The renderer walks the entry tree from `leafId`, the same way export does.
- It prints `[entryId] role: text`, collapses tool calls to `→ tool(args) ⇒ first N chars` under `toolOutput`, and stops at `maxChars`, which defaults to about 12 k characters. It returns `nextEntryId` so the next page can be requested.
- Add `EntriesCollection.listPage(sessionId, {afterId, limit})` so a large session isn't loaded all at once. Today `listForSession` loads every entry.
- The laptop needs the same renderer. Kernal can't import from Outfitter, so copy the file into `kernal/.pi/extensions/_shared/transcript.ts` and add a drift test, following the `html-preview-prompt.ts` precedent.

**Local (laptop) search** (`kernal/.pi/extensions/outfitter-admin/local-sessions.ts`)
- **Keyword search:** a streaming scan of `~/.kernal/state/sessions/**/*.jsonl` with the same chunker rules.
- **Cache:** a small inverted-index file in `~/.kernal/state/session-index.json`, rebuilt incrementally by file mtime. This is fine at the current size of about 10 MB, and needs no extra dependency.
- **Transcripts** of local sessions use the shared renderer.
- `scope:"all"` merges local hits with the cloud's `hybrid` hits using reciprocal rank fusion in the tool, and de-duplicates teleported sessions by session id.

**Opt-in upload of local sessions**
- Upload through the existing teleport `PUT /api/sessions/:id/import` (link role, Dongle).
- Triggers: `kernal sessions sync [--since 7d | <id>]`, the `/sessions sync` command, or `KERNAL_SESSION_SYNC=1` for automatic upload at `agent_end`.
- Uploaded sessions are marked `origin:"laptop"` on the session document, so they can be told apart from sessions that ran in a Drive, and they are indexed like any other session.
- Nothing is uploaded unless the user turns this on.

**Spend and limits**
- Voyage embedding is billed per token.
- The chunk cap (~2 KB of tool output) bounds cost per session.
- Embedded vectors use cluster storage, which is 512 MB on M0. The spike measures bytes per chunk before backfill. If the numbers are bad, move to Flex, which needs the owner's OK because it is billable.

### API: one op registry used by both REST and the broker
- **Pull validation out of the routes.** Move it from `packages/api/src/routes/gurus.ts:30-123` (model regex, thinking levels, env denylist, `parseBranchPrefix`, the `default` guard, the 409 on delete) into `packages/api/src/gurus-service.ts`. Do the same for environments. REST routes and admin ops then call the same functions.
- **New `packages/api/src/admin/ops.ts`:** maps each op to `{class: read|write|delete|operator, handler(identity, args)}`.
  - The broker path takes its identity from the session owner (`ownerEmail` on the session).
  - `operator` is true only when the owner is in `OUTFITTER_OPERATORS` **and** the session's Tape has `adminTools: "operator"`.
- **New Tape field `adminTools?: "off" | "manage" | "operator"`** (default `off`), in `store/types.ts:419-451` and `data-model.md`.
  - Only a human can set it, through the web REST route; `operator` requires an operator caller.
  - The admin ops strip it from `create`/`update` input. An agent therefore cannot raise its own rights or build a more powerful Tape.
- **Enforcement is in the API only.** The model's shell can reach the socket (the same threat as the GitHub socket, `github-socket.ts:5-8`), so the API checks every request: the run's Tape `adminTools`, the op class, and owner rights.
- **Approvals for `delete` and `operator` ops:**
  1. The API stores a pending approval, pushes it to the session's SSE stream and holds the request.
  2. The web session view shows an approval card. The owner approves or denies it with `POST /api/sessions/:id/admin-approvals/:approvalId`, a web-role route under IAP.
  3. The API runs the op on approve. On deny or after a 10-minute timeout it returns an error to the tool.
  4. Approval happens outside the sandbox's trust boundary, so pi-side `ui.confirm` is not relied on in Drives.
- **Audit:** a new `adminAudit` Mongo collection records `{id, at, actor, via, sessionId?, runId?, op, target?, ok, error?, approved, approvalId?}` for every non-read call, refused ones included. It exists in both the memory and Mongo stores.
- **Link role:** register the Tape and environment routes, plus `GET /api/models`, when `role === "link"`. Operator and token routes stay off link. Update the comment at `routes/index.ts:22-27`.
- **Run spec:** add `adminTools` to `RunSpecGuru` (`agentd/src/protocol.ts:290-306`, set in `agentlink.ts:1224-1235`). This tells agentd whether to open the socket; it is not a security boundary.

### agentd
- **Generalise the broker socket.** Turn `packages/agentd/src/github-socket.ts` into a broker socket that takes a frame kind, keeping the same read-retry and write-at-most-once rules, then instantiate it for `github` and `admin`. Update the existing GitHub socket tests without changing their behaviour.
- **Open the admin socket only when `spec.guru.adminTools !== "off"`.** Give it the same ownership and permissions as the GitHub socket, and export `OUTFITTER_ADMIN_SOCKET` in the run env (`run.ts:673-730`).
- **Add `admin.request`/`admin.result` frames** to `protocol.ts` and to the API's frame switch (`agentlink.ts:1453-1710`). Document them in `docs/protocol.md` next to the GitHub broker section.

### Skill, the Sysop Tape, and the UI
- **Skill `kernal/.pi/skills/outfitter-admin/SKILL.md`.** It covers the workflow the tools don't:
  1. Interview the user for the Tape's purpose.
  2. Call `outfitter_tapes meta`.
  3. Pick a model.
  4. Draft the system prompt.
  5. `create`.
  6. `outfitter_sessions start` a short smoke prompt.
  7. Read the result and `update`.

  It adds two recipes built on the search tools:
  - **Debug a Drive:** `session_search` → `session_transcript view:outline` → `around` the failing entry.
  - **Tape from past sessions:** search for sessions that did the job well, read their transcripts, and draft the Tape's prompt from them.

  It also covers the vocabulary (Tape = Guru, Drive = Run, Dongle = token) and the rules for self-development: work on a branch and open a PR; never deploy or tag a release (`outfitter-v*` tags and Kernal releases stay human). The laptop bundle already ships `.pi/skills`. For the image, add a copy of `kernal/.pi/skills` to `image/Dockerfile`, since skills are not copied there today.
- **Sysop Tape:** seed a built-in `sysop` Tape, the same way `default` is guarded, with `adminTools: "manage"` and a system prompt that points at the skill. This covers the "specific Tape" case. The general case is any Tape where a human turned on `adminTools`, plus local Kernal whenever a Dongle is configured.
- **Web:**
  - Add an "Admin tools" select to the Tape editor (Tape options). `operator` is shown only to operators.
  - Add approval cards to the session view.
  - Add glossary and vocabulary entries if a new term is needed (`packages/web/src/lib/glossary.ts`).

## Delivery (GitHub epic plus one child issue per PR, `area` labels, per the issues-current rule)
1. **API foundations:** the gurus and environments services, `adminTools` field, the op registry, audit, and link-role Tape and environment routes.
2. **Broker:** the generalised agentd broker socket, the admin socket and frames, run-spec wiring, the approval flow (API and web card), and `docs/protocol.md`.
3. **Kernal extension:** `outfitter-admin` with both transports, `_shared/outfitter-http.ts`, and teleport refactored onto it.
4. **Session search spike, then build:**
   - **Spike:** on the live cluster, confirm its tier and version (8.0 or later for `$rankFusion`), that the Free tier accepts `autoEmbed`, and what it costs in storage per chunk. Get the owner's OK before anything billable.
   - **Build:** the chunker, redaction, `sessionChunks` writes, `atlas-search.sh`, the query, transcript and page APIs, the `session_search`/`session_transcript` tools, local search, and `kernal sessions sync`.
5. **Skill and UI:** the skill, the Sysop seed, the Tape editor toggle, the skill copy in the Dockerfile, and docs (`EPIC.md` new section, `data-model.md`, README).
6. **Releases:** a Kernal release, then an `outfitter-v*` tag through `tag-release.sh`. Never deploy from a worktree.

## Verification
- **Unit tests** in each workspace:
  - **Ops:** each op class against the memory store. Also check that `adminTools` is stripped from agent writes, that operator ops are refused unless the owner is an operator and the Tape says `operator`, and that the delete approval covers approve, deny and timeout.
  - **agentd:** the broker socket tests run for both kinds.
  - **Kernal:** `tests/outfitter-admin.test.ts`, modelled on `tests/teleport-outfitter.test.ts`, with a fake socket and a fake HTTP server.
- **Security checks:**
  - From a Drive shell, `nc -U $OUTFITTER_ADMIN_SOCKET` on a Tape with admin tools off is refused by the API.
  - A `tapes update` that sets `adminTools` has no effect.
  - A `delete` waits until the web card is approved.
  - A Dongle cannot reach any operator route on link.
- **Search:**
  - **Chunker tests** cover message, tool-result trimming, redaction (planted `outf_`/`ghp_` strings never reach `sessionChunks`) and compaction entries.
  - **Transcript renderer tests** cover outline, `around`, paging with `nextEntryId`, and the `maxChars` cap. A drift test compares the API and Kernal copies.
  - **Local search tests** use a fixture JSONL directory.
  - **Against Atlas:** backfill, then check that `session_search "the 403 from the GKE auth plugin" mode:hybrid` finds the known session, and that `text` finds an exact error string. Also check that `owner:"me"` filters.
  - **Degraded mode:** the memory store returns the "unavailable" error for `semantic`.
  - **Sync:** `kernal sessions sync <id>`, then the session shows up in cloud search.
- **End to end:**
  - **Live suite (`web/live`):** start a Drive on the `sysop` Tape and ask it to create a Tape. Assert the Tape appears in `GET /api/gurus`, and that a session started on it runs.
  - **Locally:** `OUTFITTER_API=… OUTFITTER_TOKEN=… kernal -p "create a tape named X using model Y" </dev/null`, then confirm the Tape shows in the web UI.
  - **Audit:** check that `adminAudit` rows exist for each case, refusals included.
