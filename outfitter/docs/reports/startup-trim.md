# Sandbox start-up trim: our share of the wake

The "Now" step of `sandbox-startup.md`: cut the part of a cloud wake that is ours, meaning
session restore and pi's extension loading, and leave Cloud Run scheduling and the image pull
alone. E2.9 put our part at about 28 s of a 123 s median wake (13 s restore, 15 s extension
loading). Nothing here was deployed. All numbers come from a local simulation of the image, so
the cloud numbers still have to be measured (see "Re-running the cloud benchmark").

## Result

Medians of 5 interleaved runs each, M4 Pro laptop. Times are ms from `run.spec` arriving at agentd.

| Milestone (ms after run.spec) | fresh, before | fresh, after | 50 entries, before | 50 entries, after |
|---|---:|---:|---:|---:|
| session import done | 485 | 8 | 416 | 10 |
| pi ready (answers its first RPC command) | 7 180 | 2 397 | 7 131 | 2 524 |
| **first prompt accepted** | **8 081** | **2 786** | **7 865** | **2 848** |
| first model token | 9 954 | 4 035 | 9 872 | 4 416 |
| answer complete | 10 184 | 4 273 | 10 165 | 4 629 |
| pi's `createAgentSessionRuntime` (extension loading) | 4 642 | 1 513 | 4 712 | 1 450 |

Our time from `run.spec` to the first prompt being accepted went from 8.1 s to 2.8 s (−65%). The
first answer (model latency included) went from 10.2 s to 4.3 s. Restoring 50 entries costs no
more than restoring an empty session, before or after: the restore time was never per-entry work.
It was the import of pi's package (see below).

The laptop is several times faster than a 1-vCPU Cloud Run sandbox that has just pulled its
image. In E2.9, our 28 s in the cloud corresponds to 8.1 s here, a ratio of about 3.5×. If the
cloud scales the same way, our share should drop from about 28 s to about 10 s per wake. Treat
that as a projection until the cloud benchmark confirms it.

Where the pi part went (import + factory time per extension, ms, fresh session):

| Extension | before | after | why |
|---|---:|---:|---|
| pi-subagents | 1 805 | 733 | compile cache (the rest is evaluating ~280 modules; see "What's left") |
| connect (kernal) | 978 | 571 | no key re-check or LM Studio probe; `/model/info` kept |
| pi-web-access | 696 | 21 | compile cache |
| pi-mcp-adapter | 427 | 58 | compile cache |
| compaction (kernal) | 163 | 3 | compile cache |
| kernal-banner | 85 | 3 | compile cache; identity lookup (2× `git config`) deferred to TUI |
| kernal-codebase-index | 85 | — | no longer in the image |
| teleport (kernal) | 47 | 3 | compile cache; no git store prefetch at load |
| others (context, report, subagents, memory, spend, mail) | ~147 | ~25 | compile cache |

### Each change on its own

Each row takes one change back out of the "after" build (fresh session, n=3, same machine and
method):

| Taken back out | pi ready | first prompt accepted | cost of not having it |
|---|---:|---:|---|
| (nothing: the "after" build) | 2 397 | 2 786 | — |
| extension compile-cache prewarm | 5 640 | 5 900 | +3.1 s |
| dropping the OAuth MCP servers | 2 561 | 3 417 | +0.6 s, plus two failure notices on every start |
| `KERNAL_SANDBOX=1` | 2 980 | 4 344 | +0.6 s to ready; noisy (one run: 10 s) |
| preloading pi's session manager | — | — | +0.48 s on the run.spec → spawn path (485 ms → 8 ms) |

## Method

Docker was not running on this machine, so the image was not built. Instead:

- **Image layout, simulated.** A scratch `/opt/kernal` is rebuilt before every run exactly as
  `outfitter/image/Dockerfile` builds it: the same extension removals, `render-settings.sh`,
  `render-mcp.sh`, and `kernal/.pi/npm`'s committed lockfile. It runs with the image's
  environment: `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`,
  `KERNAL_NO_CODEBASE_INDEX=1`, and `KERNAL_SANDBOX=1` for "after". Each run also gets a fresh
  `$HOME` with no `~/localllm/.env`, a fresh `TMPDIR` (for "after", a copy of the prewarmed one,
  the image's `/tmp`), and a fresh agent dir with no `mcp-cache.json`. Without a fresh agent dir,
  pi-mcp-adapter's metadata cache from earlier runs hides the MCP cost.
- **Real agentd.** Each run starts the built agentd (`dist/src/main.js`; "before" is
  origin/main's build) against a small fake api WebSocket. The fake api waits 3 s after `hello`,
  roughly the gap E2.9 measured between agentd and `run.spec`, then sends a repo-less `run.spec`
  (empty snapshot, or 50 alternating user/assistant entries). It follows with a `get_state` rpc and
  a prompt immediately, which is what a message to a stopped session does. The real model is
  `litellm/gpt-5.4-nano` through the real LiteLLM router, with the prompt "Reply with exactly: ok".
- **Timings.** The fake api timestamps every up-frame on a monotonic clock. agentd's new `phase`
  lines give the same milestones from inside. pi's own `PI_TIMING=1` table gives per-extension
  import and factory times. "Before" and "after" runs alternate so machine load affects both
  equally. The laptop was shared with other work, so single runs are noisy. The tables use medians.

## What changed

**The sandbox signal.** `KERNAL_SANDBOX=1` is set in the Dockerfile and nowhere else. It is read
through `inSandbox()` in `kernal/.pi/extensions/_shared/env.ts`, so the `env()` helper and the
`MGM_` fallback apply. Nothing is guessed from the rest of the environment. Without it, a laptop
behaves exactly as before; tests cover both sides.

**Image (`outfitter/image/`)**

- `prewarm-extensions.sh` is the biggest win. pi loads every extension through jiti, which runs
  each TypeScript or ESM module through Babel and caches the output in `$TMPDIR/jiti`. A new
  container starts with that cache empty, so every wake re-transformed about 100 modules. The
  image build now runs pi once as `agent`, with the same paths and `--extension` flags agentd
  uses, answers one `get_state`, and exits. That leaves about 3 MB of compiled modules in
  `/tmp/jiti`. jiti keys entries on each file's absolute path plus a hash of its source, so an
  edited file just misses and is recompiled; the cache can't serve stale code. Anything pi writes
  into the agent dir or `$HOME` during the prewarm is deleted.
- `render-mcp.sh` drops MCP servers that use `"auth": "oauth"` (google_admin, augment_admin)
  from the image's `mcp.json`, the same way `render-settings.sh` handles packages, so the laptop
  file is untouched. In a sandbox they could never sign in (no browser, no keychain). They failed
  after network probes on every start, and pi-mcp-adapter's `input` hook holds the first prompt
  until its start-up connections settle. The litellm MCP server (header-keyed) stays.
  `render-mcp.test.sh` tests the script.
- `kernal-codebase-index` is no longer copied into the image. `open-codebase-index` isn't
  installed, so the extension could only return early.
- `PI_TIMING=1`: pi prints its per-extension start-up table to stderr once. agentd already logs
  pi's stderr at DEBUG, so every wake's breakdown ends up in Cloud Logging.

**Kernal extensions (only when `KERNAL_SANDBOX=1`)**

- connect skips the separate key check (`/v1/models`). The key was minted for this run, and a bad
  one still shows up as a 401 on the first prompt. It skips the LM Studio backend unless
  `LMSTUDIO_BASE_URL` is set explicitly; a tunnelled laptop model stays opt-in. It no longer
  blocks `session_start` on `/key/info`. pi answers no RPC command until every `session_start`
  handler returns, and that lookup only feeds the footer. Model discovery (`/model/info`) is kept,
  because the guru's model has to be registered before pi resolves `--model`.
- teleport no longer prefetches its session list at load. That prefetch ran `git init` on
  `~/.kernal-sessions` plus `git remote`/`pull` and competed with pi for the sandbox's single CPU.
  The cache only fed TUI tab completion.
- The banner looks up identity (two `git config` calls) on the first TUI `session_start` instead
  of at load, in every mode. Headless modes never draw a banner.

**agentd (`outfitter/packages/agentd/`, kept apart from the concurrent run.ts/link.ts work)**

- `src/startup-phases.ts` (new) logs one structured `phase` line per milestone, measured on a
  monotonic clock from `run.spec`: `run.spec received`, `repo cloned`, `workspace restored`,
  `session import done`, `pi spawned`, `pi ready`, `first prompt accepted`, `first model token`,
  `first answer done`. Each line has `ms` and `sinceLastMs`. For `pi ready`, agentd sends
  `get_state` right after spawning pi. pi only answers once its extensions have loaded; agentd
  recognises the response by id and drops it without forwarding it to the api. `run.ts` only gains
  the mark, probe and observe calls, behind `RunControllerDeps.startupPhases`. main.ts turns that
  on; existing tests don't.
- `preloadSessionManager()` in `session.ts` starts importing pi-coding-agent (for
  `SessionManager.forkFrom`) right after `link.connect()`. The import is the whole of the old
  restore time (≈0.45 s here, most of E2.9's 13 s in the cloud). It now overlaps the ID-token
  fetch, the handshake and the api's run.spec preparation. Locally, `hello` goes out about 130 ms
  later because of it (the import's synchronous evaluation runs on the event loop), for 480 ms
  saved after `run.spec`.
- `src/pi-version.ts` (new) reads pi's version for `hello` from pi's `package.json` behind the
  `.bin/pi` symlink. `pi --version` is now only the fallback. That removes a 270 ms spawn of
  pi's whole CLI bundle before the link connect.

**Deploy:** `outfitter/deploy/wake-bench.mjs` turns E2.9's measurement into a committed script;
see the end of this report.

**Tests.** `kernal`: `npm ci && npm test` gives 366/366. New tests cover: in a sandbox, connect
skips the LM Studio probe and the key check, keeps discovery, and doesn't wait on `/key/info`;
the laptop path still does all of those and seeds the footer before returning; `inSandbox()`
parsing; teleport's prefetch runs on a laptop and not in a sandbox; the banner does nothing
headless. `outfitter`: `npm ci && npm test && npm run build` passes (agentd 153, api 242, provider-local 2,
web 158). New agentd tests cover: phase lines and their order; the probe goes out before a queued
prompt and its response is never forwarded; without the flag pi sees only the api's commands; the
preload never raises; the version is read from `package.json` through the symlink, falling back to
the spawn and then to `unknown`.

## Image size

Not measured: Docker wasn't running and the image wasn't built. Expected change: +3.3 MB (the
prewarmed `/tmp/jiti`, 106 files) and −64 KB (`kernal-codebase-index`), so about 681 → 684 MB.
Negligible next to the pull. Check with `docker image ls outfitter-agent:trim` after
`docker build -f outfitter/image/Dockerfile -t outfitter-agent:trim .`.

## What's left

- **Model latency: 1.2–1.6 s** from prompt accepted to first token. That's the router and model,
  not start-up.
- **pi's own boot and `session_start` handlers: about 0.9 s** outside extension loading (Node plus pi's
  CLI bundle). I tried `NODE_COMPILE_CACHE` baked the same way as the jiti cache. It made no
  gain I could separate from noise on this machine, added 18 MB, and was not adopted. Worth one
  more try on a quiet 1-vCPU box.
- **pi-subagents: about 0.7 s even with a warm cache.** That's jiti evaluating its roughly 280
  modules through `new Function` with `moduleCache: false`. Only pi's loader or the package
  could change it. It is a required package.
- **connect's `/model/info`: about 0.5 s.** It must finish before pi resolves `--model`. The
  alternative is to register providers from the fallback list plus the guru's model and refresh
  in the background. That risks wrong context windows and prices for the first turn, so I didn't
  do it.
- **litellm MCP server: about 0.3–0.4 s** before the first prompt. pi-mcp-adapter has no metadata
  cache in a fresh container, so it connects before accepting input. Baking a cache would need a
  key at build time.
- **Session import in the cloud.** Locally it is fully hidden. In the cloud it is hidden only up to
  the time between `link.connect()` and `run.spec` (about 3.5 s in E2.9). If `session import
  done` still shows several seconds in the phase lines, the next step is to import only
  `dist/core/session-manager.js` (measured 200 ms vs 500 ms for the whole package), or to write
  the forked file directly.
- **Restored entries are sent back up.** The session tailer starts at offset 0, so a restore sends
  every restored entry up to the api again as `entry` frames. That's off the critical path and
  belongs to the entry-idempotency work in progress. It isn't touched here.
- **Everything before `run.spec`** (Cloud Run scheduling, about 32 s; image pull and container
  start, about 97 s cold or 15 s cached) is untouched. `sandbox-startup.md` covers it (GKE Agent
  Sandbox is the "Next" step).

## Re-running the cloud benchmark

After deploying the image (`outfitter/deploy/agent-job.sh`), run this against a stopped repo-less
session on a cheap guru model. `OUTFITTER_API` is the link service origin, and the token is a
personal `outf_` token from the Tokens page:

```sh
OUTFITTER_API=https://<link-origin> OUTFITTER_TOKEN=outf_... \
  node outfitter/deploy/wake-bench.mjs <session-id> 10
```

For each wake it prints time until the run is up and time until the answer is stored, then the
medians. At the end it prints a `gcloud logging read` command for those runs' `phase` lines, which
split each wake into import, pi ready, prompt accepted and first token. pi's per-extension table
is in the same executions as DEBUG lines with `source: "pi"`. Compare the result with E2.9's
123 s median (≈28 s of it ours). If module imports are still slow in the pi table, the image's
`/tmp/jiti` wasn't used; check that nothing sets `TMPDIR` for pi.
