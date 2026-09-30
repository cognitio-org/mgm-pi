# Data model

EPIC.md E2.1. Six collections, all behind the `Store` interface (`src/store/types.ts`) so
`MemoryStore` (dev/tests) and `MongoStore` (prod) are interchangeable — every route, `runs.ts` and
`agentlink.ts` is written against the interface only, never a Mongo type. `MongoStore.ensureIndexes`
(`src/store/mongo.ts`) is the migration script this story asks for: it's declarative and safe to
re-run (Mongo's `createIndex` is idempotent), so there's no separate numbered-migrations mechanism.

## Collections

### `sessions`

One document per Outfitter session — the thing a user starts, watches and can pull to their
laptop. `_id` is the session id (also the pi session id: see "why one document per pi entry"
below).

| Field | Type | Notes |
|---|---|---|
| `id` | string | `randomUUID()`, mirrored into `_id` |
| `name` | string? | |
| `guruId` | string | FK into `gurus` |
| `repo` | string \| null | `null` = non-coding session (protocol.md: `repo` omitted on `POST /api/sessions`) |
| `baseBranch` | string? | repo sessions only |
| `branch` | string? | repo sessions only; absent = agentd works out of a scratch `/workspace` |
| `prompt` | string? | the opening prompt, replayed to agentd on the first `wake()` |
| `modelOverride` | string? | E2.8: per-session model override, takes priority over the guru's `model` |
| `parentId` | string? | set for a session created by `outfitter_delegate` (E5.2, not yet implemented) |
| `status` | `"open"` \| `"closed"` | |
| `leafId` | string? | id of the current leaf entry (tip of the transcript tree) |
| `cost` | number | high-water mark of `spend.keySpend` frames seen so far (agentlink.ts) |
| `checkpoint` | object? | most recent `checkpoint` frame's fields, replaced wholesale each time: `{branch?, head?, snapshotUrl?, workspaceUrl?}` |
| `createdAt`, `updatedAt` | ISO string | |

Indexes: `{updatedAt: -1}` (fleet list, most-recently-active first).

### `entries`

One document per pi session entry (message, model_change, compaction, custom, ...), exactly as pi
writes it to its own JSONL file plus routing metadata.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | FK into `sessions` |
| `seq` | number | monotonically increasing per run (protocol.md); NOT the same as pi's own entry ordering, just insertion order into this collection |
| `entry` | object | the pi entry verbatim: `{id, parentId, type, ...}` |
| `blobRef` | string? | TODO, see "blobRef" below — always `undefined` today |
| `runId` | string? | #147: the run whose agentd sent the entry (`agentlink.ts`). Absent for entries the api writes itself (browser captures, session-route writes) and for entries stored before the field. Sent to browsers as `outfitterRunId` next to the entry's own fields (`entry-wire.ts`); never written into `entry` |

Indexes: `{sessionId: 1, "entry.id": 1}` **unique** (the idempotency key: `agentlink.ts`'s
`insertIfNew` relies on the resulting duplicate-key error to detect a re-delivered `entry` frame
and treat it as a no-op ack rather than a new row); `{sessionId: 1, seq: 1}` (tree-order reads:
`GET /api/sessions/:id/entries`, `export.jsonl`).

### Why one document per pi entry

EPIC.md's framing: "a session is exactly a pi JSONL file, and teleport is a query plus concat."
`GET /api/sessions/:id/export.jsonl` does exactly that —
`[headerLine(session), ...entries.map(e => JSON.stringify(e.entry))].join("\n")` — so the export a
laptop pulls is byte-for-byte what pi itself would have written, with no reconstruction logic.
Storing one entry per row (rather than one big array field on the session document) also makes the
protocol's idempotency guarantee cheap: a re-delivered `entry` frame (agentd reconnect, at-least-
once delivery) is a single indexed `insertOne` that either succeeds or hits the unique index and is
ignored, instead of a read-modify-write race on a shared array.

### `runs`

One document per attempt to execute a session (`queued → provisioning → running ⇄ idle → stopped |
failed`, protocol.md's run state machine). A session can have many runs over its lifetime (wake
after wake after an idle-stop); at most one is ever active (`state` in
`queued|provisioning|running|idle`) at a time, enforced by `RunManager.wake` returning the existing
active run instead of creating a second one.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | FK into `sessions` |
| `state` | `RunState` | |
| `reason` | string? | why it stopped/failed |
| `lastSeenAt` | ISO string? | last `hello`/`status`/`entry`/`event`/`heartbeat` frame; drives the reconciler |
| `lastAckedSeq` | number | highest `entry`/`event` seq acked |
| `pending` | `DownMessage[]` | down-messages queued while no agentd socket is connected (REST calls that need to reach agentd write here; drained on `hello`) |
| `providerHandle` | unknown | opaque `SandboxProvider` handle (Cloud Run execution name, child PID, ...) |
| `pendingUiRequest` | unknown? | **not in protocol.md**: the last `extension_ui_request` event, so a browser that (re)opens the session still sees a question the run is waiting on; cleared on `ui_response` |
| `modelFallback` | `{wanted, used}`? | **not in protocol.md**: set by the E2.8 laptop preflight (`src/laptop.ts`) when a laptop-only model was substituted for a cloud one, so the UI can show "running on X instead of Y" |
| `sandboxExit` | `{reason, exitCode?, finishedAt?}`? | #193: how the sandbox's agent container ended, per the orchestrator (GKE: the pod's `agentd` terminated state, e.g. `OOMKilled`/137). Read shortly after agentd goes quiet (`RunManager.checkSandboxExit`); a clean exit (0/`Completed`) marks the run `stopped`, anything else `failed`. Absent while running, after a clean bye, and on Cloud Run. Kubernetes' termination `message` is not kept: the container writes it |
| `allowExternalHtmlResources` | boolean? | #132: the guru's flag as it was when this run's first `run.spec` was built, written once and reused by later specs on reconnect. `GET /api/sessions/:id` returns it so a session opened later previews HTML the way that run's prompt said; a Tape changed mid-run applies to the next run |
| `githubIdempotency` | object? | **not on the wire**: last 100 `github.request` write results keyed by `idempotencyKey`, so a retry does not post twice (`src/github-broker.ts`) |
| `createdAt`, `updatedAt` | ISO string | |

Indexes: `{sessionId: 1, state: 1}` (`findActiveForSession`, the hot path on nearly every route).

`listStale` (the reconciler's input) doesn't get its own index today — it scans
`state in ACTIVE_RUN_STATES` with a `lastSeenAt`/`createdAt` range, which the `{sessionId,
state}` index doesn't cover well for a project-wide scan. Fine at today's scale (the reconciler
runs once a minute over what should be a handful of active runs); revisit with a `{state: 1,
lastSeenAt: 1}` index if the fleet grows.

### `gurus`

Reusable agent configs (EPIC.md vocabulary: **Guru**, never "Expert").

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `systemPrompt`, `appendSystemPrompt` | string? | pi `--system-prompt` / `--append-system-prompt` |
| `model` | string | e.g. `litellm/local-qwen-mlx`, `litellm/claude-auto-llm` |
| `fallbackModel` | string? | E2.8: substituted for `model` when it's a laptop model and the laptop preflight is offline |
| `thinking` | string? | |
| `tools`, `excludeTools` | string[]? | |
| `packages` | string[]? | pi packages/skills for the run's `PI_CODING_AGENT_DIR` |
| `env` | object? | |
| `mergeFromCloud` | boolean? | phase 3: when true, this guru's cloud runs may `github_pr.merge`. Absent or false refuses with "not permitted" |
| `playwrightBeforeCheckpoint` | boolean? | default off. When true, agentd runs a Playwright spec already in the workspace against a fresh headless Chromium before checkpoint. Absent on existing gurus (not stored as true). |
| `allowExternalHtmlResources` | boolean? | #132, default off. Picks which HTML preview paragraph agentd appends to pi's system prompt (external CSS and JS allowed, or sealed) and the preview dialog's starting access. Copied onto each run as it starts. A PUT that omits it leaves it as it was. |
| `adminTools` | `"off" \| "manage" \| "operator"`? | Sysop tools (#286), default off. Whether this tape's runs get the admin tools. `operator` also allows sysop actions, and only when the session's owner is an operator. Only a person in the web UI sets it (`gurus-service.ts`); an agent or a Dongle caller gets 403, and `operator` needs a sysop. |
| `createdAt`, `updatedAt` | ISO string | |

No indexes beyond `_id` — the guru list is small and read in full (`GET /api/gurus`).

### `environments`

Named repo/base-branch/env presets for the "new session" dialog (E3.4). Same shape family as
`gurus`: `{id, name, repo?, baseBranch?, env?, createdAt, updatedAt}`. No indexes beyond `_id`.

### `adminAudit`

Sysop tools (#286): one row per admin op an agent ran that was not a read (`admin/ops.ts`),
successful or not. `{id (== _id), at, actor (email the op ran as), via ("token" | "drive"),
sessionId?, runId?, op, target?, ok, error?, approvalId?}`. No indexes beyond `_id`: it is read
newest first by a reverse natural-order scan.

### `users`

Every distinct IAP identity seen, upserted on `GET /api/me`. `{email (== _id), createdAt,
lastSeenAt}`. Not a permissions table — every `mgmonteleone.com` account IAP admits is trusted
equally today; this is just a "who's used this" log.

## `blobRef` (TODO, not implemented)

`Entry.blobRef` exists in the type today but is always `undefined`. Per EPIC.md ("Transcript lives
in Atlas as pi entries"): entries whose `entry` payload exceeds ~100 KB (tool output being the
common case — a large file read or command output pi decided to keep inline) should be offloaded
to the GCS bucket instead of stored inline in Mongo, with `blobRef` holding a pointer (bucket +
object key) instead of the entry carrying the full payload. Left out of this story because it
needs a GCS bucket and upload path that doesn't exist yet (the checkpoint/snapshot GCS wiring is
agentd's side, E1.2); `MongoEntries.insertIfNew` and `listForSession` are already shaped to carry
`blobRef` through unchanged once a caller starts setting it, so wiring it up later is additive —
no schema migration, just start populating the field and teach whoever renders an entry to resolve
`blobRef` before `entry` when both could apply.
