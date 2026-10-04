# Sentry Integration: Kernal & Outfitter

Error reporting and low-volume tracing for Kernal (the laptop CLI) and Outfitter (API, agentd, web
app, Agent Engine Python agent). Epic [#368](https://github.com/cognitio-org/mgm-pi/issues/368).

## 1. One switch, set in Outfitter (fleet settings)

Sentry is **off everywhere until an operator turns it on**, in the web app under
**Settings → Telemetry**. That panel writes the fleet settings: one document
(`fleetSettings` collection, `outfitter/packages/api/src/fleet-settings.ts`) holding

- `enabled`: whether anything is sent at all,
- `dsn`: where events go. It defaults to the project's own DSN (`DEFAULT_SENTRY_DSN`), and the API
  stores it in the document on first boot (`ensureFleetSettings`), so turning Sentry on is one click.
  It is kept while off, never sent to clients while off, and never re-added once an operator clears it,
- `tracesSampleRate`: the fraction of traces kept (default 0.05). Errors are always sent in full.

No machine carries its own DSN. Each reads the fleet settings and follows them:

| Runtime | How it gets the settings | When a change applies |
|---|---|---|
| API | its own store, through `FleetSettingsCache` (re-read when stale, on requests) | within a minute; at once on the instance that took the change |
| agentd (Drives) | run.spec's `telemetry`, sent only while Sentry is on (`docs/protocol.md`) | the next run start |
| web app | `GET /api/fleet-settings` before it starts the SDK | the browser's next load |
| Kernal laptops | `GET /api/fleet-settings` with the laptop's Dongle, cached in `~/.kernal/.fleet-settings.json` | the next Kernal start (or mid-session, once the background refresh lands) |
| Agent Engine Python agent | still `SENTRY_DSN` in its own env: it has no API channel at start-up | its next deploy |

Off is also the answer whenever a reader cannot get the settings: a laptop with no Dongle, an
Outfitter that has never saved them, or a failed read with nothing cached. A laptop whose Dongle is
refused (401/403) replaces its cached copy with off, and a cached copy older than 30 days reads as
off.

No runtime adds `sentry-trace`/`baggage` headers to its outbound calls (`tracePropagationTargets: []`):
the SDK's default is every host, which would tell each LLM provider and API the release, the Sentry
org and one id shared across all of them, whether Sentry was on or not. The API also strips the
request's headers, body, cookies and query from any event.

"Off" means nothing leaves a process once its SDK has started either: besides the event hooks, the
API and Kernal gate the transport itself, so client reports and session envelopes stop too.

`GET /api/fleet-settings` is open to any signed-in caller (an IAP session, or a Dongle on the link
role) and returns the DSN only while Sentry is on. `PUT /api/operator/fleet-settings` is
operator-only and exists on the web role only. `GET /api/operator/settings` shows the full document,
including who changed it last.

### A person's own opt-out (Kernal)

`/sentry off` in Kernal writes `telemetry.sentry.enabled: false` to this machine's config layer
(`~/.kernal/config.local.json`, where `/admin`'s "Only this machine" saves too, so either undoes the
other; #374's `kernal.sentry: false` in the agent settings.json still counts, and `/sentry on`
clears it). It stops sending at
once and keeps Kernal from even asking Outfitter. `/sentry on` clears it, which means "follow
Outfitter": it can never turn Sentry on when the fleet has it off. `/sentry` shows which of the two
decided.

## 2. What is sent

- **Errors (100%)**: unhandled route errors (API), failed runs and unexpected pi exits (agentd,
  flushed before it exits),
  React crashes caught by the ErrorBoundary (web), agent runs that end in an assistant error and
  uncaught exceptions (Kernal), LLM call failures (Python).
- **Traces (the fleet rate, default 5%)**: one span per API request (named after the route pattern,
  never the raw URL; none for websockets), agentd's run start-up, and in Kernal one transaction per
  agent run with a child span per tool call, sampled together (a tool call outside a run is not
  traced). A tool span carries only the tool name, never its arguments or output.
- **Session replay (web)**: error-only (`replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 1`)
  to stay inside the free plan's replay quota.

Kernal trims events before they leave the laptop: no hostname, the home directory written as `~`,
no console breadcrumbs (`Console` integration dropped). Kernal, the API and agentd all drop
`OnUnhandledRejection`, because any `unhandledRejection` listener would stop Node from crashing on
one (pi registers none). An unhandled rejection is therefore still raised as an uncaught exception,
which Sentry reports. The integration lists use the SDK's function form: an array is added to the
defaults, so filtering a copy of them drops nothing.

## 3. Implementation notes

- **Kernal ships `@sentry/node` in `kernal/.pi/npm`**, the extension packages that `scripts/package.sh`
  installs exactly as locked into every bundle. The extension imports the SDK's ESM entry by absolute
  path. pi's compiled (Bun) binary resolves bare names from outside that tree, and CommonJS
  `require`, wrongly. The SDK loads only once Sentry is on, so it costs nothing while off. A failure
  to start is reported once on stderr and never stops Kernal. The Outfitter image removes both the
  extension and the package; a Drive reports through agentd.
- **Process-wide state**: pi re-instantiates extensions on /new, /resume, /fork and /reload with a
  fresh module copy, so Kernal keeps its Sentry state on `globalThis`. The SDK starts once per
  process; after that, on/off and the rate are a live gate that `beforeSend`, `beforeSendTransaction`
  and `tracesSampler` read for every event. The API works the same way. A new DSN cannot replace the
  one a running process started with, so that process sends nothing until it restarts.
- **Versions**: every runtime is on the same SDK line, `@sentry/node` / `@sentry/react` 11.2.0,
  pinned exactly (the version verified inside pi's Bun binary). It brings `@sentry/bundler-plugins`,
  with `oxc-parser`'s native binding and the `sentry` CLI (no install scripts), about 18 MB per image
  or bundle. The API, agentd and Kernal set `traceLifecycle: "static"`, so spans are sent as whole
  transactions that `beforeSendTransaction` can gate; SDK 11's default streams spans past that hook.
  The web app keeps streaming on purpose: it starts only when on, and streamed page spans are named
  "Pageload"/"Navigation" instead of a pathname that can carry ids.
- **Interactive crashes**: pi's own `uncaughtException` handler runs first in interactive mode and
  calls `process.exit`, so nothing can be sent at crash time. pi writes each crash to the agent dir's
  `crashes.json` first, though. The first time Sentry is on in a later run, Kernal sends the crashes
  it has not sent yet as fatal events (tag `source: crash`, grouped by their top stack frames), and
  once they have been delivered records their timestamps in `.sentry-crashes-sent.json` beside the
  settings cache. Two Kernals starting at the same moment may both send one; it groups with the first. It sends message, stack, kind and pi version
  only, never the record's working directory or session file.

## 4. Not done yet

- The Agent Engine Python agent still reads `SENTRY_DSN` from its own env (see the table above).
- A crash is reported on the next start with Sentry on, not at the moment it happens; a crash
  recorded by a bundle version that was then upgraded away from stays in that bundle's crashes.json.
- Not built: always tracing failed requests (a `tracesSampler` that keeps every 5xx), and custom
  Sentry metrics.

## 5. Tracking

- Epic: [#368](https://github.com/cognitio-org/mgm-pi/issues/368)
- [Sentry-1] Configuration and sampling (now the fleet settings): [#369](https://github.com/cognitio-org/mgm-pi/issues/369)
- [Sentry-2] Kernal: [#370](https://github.com/cognitio-org/mgm-pi/issues/370)
- [Sentry-3] Outfitter API and agentd: [#371](https://github.com/cognitio-org/mgm-pi/issues/371)
- [Sentry-4] Outfitter web: [#372](https://github.com/cognitio-org/mgm-pi/issues/372)
- [Sentry-5] Agent Engine (Python): [#373](https://github.com/cognitio-org/mgm-pi/issues/373)
