# Cost and logs report (E2.11, E1.6)

Scope: E2.11 (spend frames from cloud runs) and E1.6 (Job container logs). Touches
`packages/agentd/{src,pi-extension,test}`, `packages/api/src/{agentlink.ts,store/types.ts}`,
`packages/api/test/agentlink.test.ts`, `docs/protocol.md`. Does not touch `image/` or `mgm/` (another
agent owns the Dockerfile/build scripts in this session; see "Follow-up" below for what it still needs
to pick up).

## E2.11: spend frames from cloud runs

### Problem

`Session.cost` stayed 0 on the first cloud run: the connect extension's `after_provider_response`
hook (`mgm/.pi/extensions/connect/index.ts`) already parses LiteLLM's `x-litellm-key-spend` etc.
headers, but that hook runs *inside pi*, and agentd never sees pi's HTTP traffic -- there was no path
from "pi made a LiteLLM call" to a `spend` up-frame at all.

### Design

A new, self-contained pi extension, `packages/agentd/pi-extension/outfitter-spend.ts`, loaded only
under agentd:

- `renderGuru` (`packages/agentd/src/guru.ts`) now takes an optional `spendExtensionPath` and, when
  set, prepends `--extension <path>` to pi's argv.
- `RunController` (`packages/agentd/src/run.ts`) only passes `spendExtensionPath` through (and only
  sets the `OUTFITTER_SPEND_FILE` env var pi's child inherits) when `RunControllerDeps.spendFile` is
  configured -- so an interactive/local pi run, or a test that doesn't wire these deps, is completely
  unaffected; no `--extension` flag, no env var.
- The extension itself no-ops (registers no hook at all) if `OUTFITTER_SPEND_FILE` isn't set, as a
  second line of defense.
- On every `after_provider_response` event whose headers are LiteLLM's (`x-litellm-call-id` present),
  the extension appends one JSON line to `OUTFITTER_SPEND_FILE`:
  `{ keySpend?, keyMax?, modelGroup?, callId?, usage? }`. `usage` is *not* a running total -- it's the
  increase in pi's own cumulative LiteLLM cost estimate (`message.usage.cost.total` summed across
  assistant turns, the same field mgm's connect extension's `sessionEstimate` reads) since the
  previous line, i.e. this one response's own cost estimate.
- `packages/agentd/src/pi.ts` gets a `SpendTailer`, structurally the same poll-by-byte-offset tailer
  as `SessionTailer` (reused per the task's instruction), but without a session-header line to skip.
  `RunController.begin()` starts one whenever `spendFile` is configured, and each parsed line becomes
  a `spend` up-frame via a new `handleSpendLine`, which also accumulates every line's `usage` into
  `this.costEstimate` and sends it as the frame's new `estimate` field.
- `protocol.ts`'s `UpSpend` gained `estimate?: number`, and `keySpend`/`keyMax`/`modelGroup`/`callId`
  are now optional (a response can be LiteLLM-routed but carry no budget-cap header, or the frame can
  carry only `estimate` when it isn't a LiteLLM route at all). `docs/protocol.md`'s `spend` row is
  updated to describe both fields' provenance.
- `packages/api/src/agentlink.ts`'s `"spend"` case now also handles `frame.estimate`: when it's a
  number, it's stored on the run as `Run.costEstimate` (new field, `packages/api/src/store/types.ts`)
  via a plain assignment -- agentd already sends the accumulated total, so there's no delta math here,
  unlike `cost`'s `keySpendStart` baseline. This is independent of the existing `keySpend`-driven
  `cost`/session-cost logic, so a guru whose model group never returns LiteLLM headers at all still
  gets a real `costEstimate`.

### Why not import `mgm/.pi/extensions/connect/lib.ts` directly

`packages/agentd` is a separate npm workspace from `mgm/`, and the sandbox image (per
`image/Dockerfile`, which another agent in this session owns) only ever copies
`outfitter/packages/agentd/src/` in -- there's no guarantee `mgm/.pi/extensions/connect/lib.ts` is
resolvable at the path `pi-extension/outfitter-spend.ts` would need at runtime, and duplicating the
~15 lines of pure header-parsing logic locally (with its own unit tests) is simpler and more robust
than adding a cross-package relative import that only works because of how the image happens to lay
files out today.

### Tests

- `packages/agentd/test/outfitter-spend.test.ts`: `parseSpendHeaders`, `sessionCostTotal`,
  `buildSpendLogLine` (pure functions) against fake headers/entries -- a fake `after_provider_response`
  event's headers in, the log line's shape out.
- `packages/agentd/test/guru.test.ts`: `renderGuru` with/without `spendExtensionPath`.
- `packages/agentd/test/run.test.ts`: an injected fake spend tailer's lines become `spend` up-frames
  with an accumulating `estimate`; a run with no `spendFile` configured spawns pi with neither
  `--extension` nor `OUTFITTER_SPEND_FILE`.
- `packages/api/test/agentlink.test.ts`: `spend.estimate` lands on `Run.costEstimate` as a plain
  overwrite, independently of whether the same or a different frame also carries `keySpend`.

## E1.6: Job container logs

### Investigation

Cloud Run's logging agent captures a container's stdout *and* stderr and auto-parses `severity` and
`message` from a JSON line on either stream (docs.cloud.google.com/logging/docs/structured-logging;
docs.cloud.google.com/run/docs/logging) -- so agentd's stderr should not, in principle, have been
invisible. The most likely explanation, given agentd's own code, is that every agentd log line was a
plain `console.error("[agentd] ...")` string with no `severity`/`message`/JSON shape at all: Cloud
Logging still ingests a non-JSON line as a `textPayload` DEFAULT-severity entry, but plain-text lines
are far easier to lose in a filtered/severity view (or a query scoped to `severity>=INFO`) than a
line that never got a severity of its own. Per the task's brief, the fix implemented is exactly what
was asked for regardless of the precise mechanism: switch to one structured JSON log line per event on
stdout (with a human-readable fallback for a TTY), and give pi's own stderr an explicit, lower
severity instead of folding it into agentd's own log stream unmarked.

### Design

`packages/agentd/src/logger.ts` (new): a small `Logger` with `debug/info/warn/error`, `child(fields)`
(merges base fields, e.g. `{ sessionId }` once a `run.spec` is known -- shares the parent's secret
registry), and `addSecret(value)`.

- Non-TTY (the container's real stdout): one line per call, `{"severity":"INFO","message":...,
  ...fields}` -- `severity`/`message` are what Cloud Run parses; any other field (`runId`,
  `sessionId`, `state`, `source: "pi"`, ...) rides along as a normal JSON property.
- TTY (local dev): `[agentd] INFO message {"fields":...}`, for a readable terminal.
- Redaction: `addSecret(value)` registers an exact string (RUN_TOKEN at startup, `run.spec.secrets.
  githubToken`/`litellmKey` the moment `RunController.begin()` sees them) that's scrubbed from every
  later message/field string. Unconditionally, regardless of `addSecret`, every logged string also
  gets URL-userinfo (`scheme://user:pass@host`) and secret-shaped query params (`token=`, `key=`,
  `secret=`, `signature=`, `credential=`, `auth=`) redacted, as defense in depth against a token
  nobody explicitly registered showing up in a raw error message or a snapshot/workspace URL.
- `main.ts` builds one root logger (`createLogger({ runId })`), registers `RUN_TOKEN` (and
  `OUTFITTER_DEV_TOKEN` if set) immediately, and passes both the logger and a `logger.info`-backed
  `onLog` string sink into `RunController`; `controller.onStateChange` also logs every state
  transition with a `state` field. `link.onTerminal`/`onUnspecTimeout` and the top-level `main().catch`
  now go through the logger (or a fresh fallback logger for the one path that can throw before the
  real one exists) instead of `console.error`.
- `run.ts`: `RunControllerDeps` gained an optional `logger?: Logger`. When present, pi's own stderr
  (`this.pi.onStderr`) is routed to `logger.debug(chunk, { source: "pi" })` instead of the generic
  `onLog` string sink, so it's clearly tagged and at a lower severity than agentd's own operational
  logs; `begin()` registers `spec.secrets.githubToken`/`litellmKey` with the logger the moment the
  `run.spec` arrives. Every existing test (and any caller that doesn't pass `logger`) is unaffected --
  `onLog` still works exactly as before when `logger` is omitted.

### Tests

`packages/agentd/test/logger.test.ts`: JSON shape (severity/message/fields) in non-TTY mode,
human-readable output in TTY mode, severity mapping for debug/warn/error, `addSecret` redaction (in
both the message and a field, including a no-op for undefined/empty), unconditional URL-userinfo and
secret-shaped-query-param redaction, `child()` field inheritance and shared secret registry, and an
end-to-end "never logs an unredacted RUN_TOKEN or LiteLLM key" check.

## Test run

`npm test` from `outfitter/` (all three workspaces): **186 tests, 0 failures**
(`packages/agentd`: 104, `packages/api`: 80, `packages/provider-local`: 2).

## Review fixes

Code review on `outfitter/round-two` found four issues in the above; fixed here, each with new
tests. `npm test` from `outfitter/` (all three workspaces): **204 tests, 0 failures**
(`packages/agentd`: 122, `packages/api`: 80, `packages/provider-local`: 2).

1. **`outfitter-spend.ts`: `previousTotal` started at 0, so a resumed session's first line double-
   counted its whole history as one response's `usage`.** `previousTotal` is now `number | undefined`,
   baselined from `sessionCostTotal(entries)` on a new `session_start` handler (which fires once,
   before any new provider call, so its entries are exactly the prior history) -- with the
   `after_provider_response` handler also lazily baselining from its own `ctx` the same way, before
   computing the delta, as a defensive fallback if `session_start` doesn't fire first for some reason.
   New tests in `packages/agentd/test/outfitter-spend.test.ts` drive the extension's default export
   directly against a fake `pi` object and a real temp file: a resumed session (history + one new
   response) produces only the new response's own delta, and the no-`session_start` fallback path is
   covered too.

2. **`logger.ts`: unsafe field serialisation, and `Error` fields silently became `{}`.**
   - `write()` now runs field normalisation + redaction + a `JSON.stringify` probe inside a
     `try/catch`; a circular structure (or anything else JSON.stringify can't handle) falls back to
     `{ logError: "unserialisable fields" }` instead of throwing out of a logging call, in both TTY and
     non-TTY mode.
   - A new `normalizeErrors()` pass (before redaction) converts any `Error` instance -- top-level or
     nested inside an object/array field -- to `{ name, message, stack? }`, since `message`/`stack` are
     non-enumerable own properties that plain `Object.entries`/`JSON.stringify` handling skips.
     `stack` is included only at DEBUG severity or when a new `verbose: boolean` `CreateLoggerOptions`
     field is set (propagated through `child()`), since it's long and not normally wanted in Cloud
     Logging at INFO/WARNING/ERROR. The error's `message` still goes through the existing secret
     redaction.
   - Tests added to `packages/agentd/test/logger.test.ts`: circular fields in both TTY/non-TTY mode,
     `Error` field shape, `stack` presence at DEBUG vs. its absence (unless `verbose`) at other
     severities, and that an `Error`'s message is still redacted.

3. **`run.ts`/`pi.ts`: spend lines from `OUTFITTER_SPEND_FILE` were trusted without validation.**
   The file lives in `/tmp` in the sandbox image and is writable by the model's own shell user, so a
   line in it is untrusted input, not just possibly-malformed JSON. `pi.ts` gains
   `validateSpendLine(value: unknown): SpendLogLine | undefined`: rejects anything that isn't a plain
   object; `usage`, if present, must be a finite number in `[0, 1000]`; `keySpend`/`keyMax`, if
   present, must be finite non-negative numbers; `modelGroup`/`callId`, if present, must be strings
   under 200 chars; only known fields are ever read (safe against `__proto__`-shaped payloads). The
   tailer(s) now hand `handleSpendLine` the raw parsed JSON value (`unknown`, no blind cast); `run.ts`'s
   `handleSpendLine` validates it before use and, on failure, drops the line and logs a WARNING (via
   the structured `logger` when configured, else the `onLog` string sink) with a length-capped,
   never-throwing summary of the offending line instead of sending a `spend` up-frame. Tests: an
   exhaustive `validateSpendLine` suite in `packages/agentd/test/pi.test.ts` (non-object values, out-
   of-range/non-finite/wrong-type numbers, oversized/wrong-type strings, a `__proto__` payload), and a
   `RunController` test in `packages/agentd/test/run.test.ts` that feeds a mix of one valid and eight
   malformed/hostile lines through the real `handleSpendLine` path and asserts exactly one `spend`
   frame and eight WARNINGs.

4. **`pi.ts`: `SpendTailer` duplicated `SessionTailer`'s poll-by-byte-offset loop.** Collapsed into one
   `JsonlTailer` class taking an optional `skipHeader?: (parsed: unknown) => boolean` (called on each
   parsed line until it returns true once, then never again -- the same semantics `SessionTailer`'s
   inline `parsed.type === "session"` check had). `SessionTailer` and `SpendTailer` are now thin
   subclasses of `JsonlTailer` (`SessionTailer` passes a `skipHeader` matching the session header,
   `SpendTailer` passes none), keeping both exported names, constructors and behaviour unchanged --
   `packages/agentd/test/pi.test.ts`'s existing `SessionTailer` tests and `run.test.ts`'s spend-tailer
   tests pass unmodified; new tests cover `SpendTailer` tailing (no header to skip) and that both
   classes are `instanceof JsonlTailer`.

## Follow-up (out of scope for this change)

- **`image/Dockerfile`** only `COPY`s `outfitter/packages/agentd/src/` into the image today. It needs
  a second `COPY outfitter/packages/agentd/pi-extension/ ./pi-extension/` (and the `tsc` build step
  already compiles it, since `tsconfig.json`'s `include` now covers `pi-extension/**/*.ts` too) plus
  an `ENV OUTFITTER_SPEND_EXTENSION=/opt/outfitter/agentd/dist/pi-extension/outfitter-spend.js` so
  `main.ts` actually wires `spendExtensionPath` through (it already reads
  `process.env.OUTFITTER_SPEND_EXTENSION`). Also needs `RunControllerDeps.spendFile` to be given a
  real per-run path (e.g. `join(workspace-adjacent tmp dir, "spend.jsonl")`, analogous to
  `WORKSPACE_SNAPSHOT_DIR`) -- `main.ts` currently only reads it from `OUTFITTER_SPEND_FILE`, which
  nothing sets yet outside tests. Left to the agent already working in `image/` and the build scripts
  in this session, per this task's instructions.
- The API doesn't yet expose `Run.costEstimate` on any read route (`GET /api/sessions/:id`, etc.) --
  E2.11's story only asked for it to be stored on the run; surfacing it in the UI is E3.5's job.
