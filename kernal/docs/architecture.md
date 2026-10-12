# kernal internals

How the parts work and why. The user-facing guide is [../README.md](../README.md); this file is for
whoever has to change the thing. kernal is extensions and settings on top of the pi coding agent, and
pi's own source is never modified: everything below lives in `.pi/extensions`, `.pi/settings.json`,
`bin/kernal` or `scripts/`.

## How the extension works (`.pi/extensions/connect/index.ts`)

- Registers each backend with `pi.registerProvider(id, { api: "openai-completions", ... })`.
  LM Studio and LiteLLM models come from `GET /v1/models` at startup (4 s timeout, static fallback).
- Thinking: pi's `off/low/medium/high` map to `reasoning_effort`; `off` sends `"none"` for the Qwen
  routes so the model does not burn tokens reasoning about trivial prompts.
- `compat.supportsStore: false` because LiteLLM forwards OpenAI's `store` flag to Anthropic and
  Vertex, which reject it. `supportsDeveloperRole: false` for the same proxy reasons.
- `/connect` uses `ctx.ui.select` for the pickers, `pi.setModel` to switch, and writes the project
  settings file so the choice sticks.

## Pricing and budget (built in, no pi-provider-litellm needed)

- **Pricing and limits** come from the router's `/model/info` at startup: per-model input/output/cache
  prices, context window and max output, so pi's own cost estimate and the powerline footer are accurate
  for every `litellm/` model. Falls back to `/v1/models` with generic values if the key cannot read it.
- **Session cost** is pi's own token accounting times those router prices (immediate, per message).
  Streamed responses carry LiteLLM's cost headers before the cost is computed, so they read 0 and are not
  used. **Key spend and budget cap** come from `x-litellm-key-spend` / `x-litellm-key-max-budget` on every
  response; the footer shows `◆ $0.0760 · key $0.56/$1000.00 (0.1%)` while a `litellm/` model is active.
- **`/budget`** draws a panel above the editor: session estimate, router-billed delta since the session
  started (lags a little; LiteLLM writes spend asynchronously), key and team spend with budget bars, and
  the current model's prices. `/budget off` hides it. The key needs `info_routes` in `allowed_routes` for
  the key and team lines; otherwise only the header-based numbers show.
- Set `KERNAL_SPEND_LOG=/path/file.jsonl` to append one JSON line per call for auditing.

## Context window and compaction on the local model

**Window discovery.** The OpenAI-compatible `/v1/models` says nothing about context, so the
provider reads LM Studio's native `/api/v0/models` at startup: `loaded_context_length` for loaded
models, `max_context_length` otherwise (Qwen 3.6 serves 183k; the MLX engine ignores the CLI
context flag). `LMSTUDIO_CONTEXT` in `~/localllm/.env` caps what pi budgets against, 128k by
default; leave it empty to use the served window. Qwen 3.6 35B-A3B is a hybrid with 10 full-attention layers and 2 KV heads, so its KV cache
is tiny: ~2.5 GB at 128k, ~3.5 GB at 183k, on top of 20.4 GB of weights. The real cost of a large
window is prefill (~500 tok/s: a cold 100k prompt is ~3 min; LM Studio's prompt cache makes
follow-up turns incremental) and long-context quality, not memory. Set 65536 if you want faster
cold starts; the extension re-derives all budgets from whatever is declared.

**Thinking is off by default for the local routes** (`local/<user>-<host>/<model>`, and the retired
`litellm/local-qwen-mlx` name if a session still has it).
With thinking on, Qwen reasons for thousands of tokens per turn at ~30 tok/s; turn it on per session
with `/thinking` when a task needs it.

**Why compaction failed before.** pi's stock compaction keeps 20k recent tokens and reserves 16k, so
on a ≤32k window the threshold fires at 16k, the cut point keeps everything, preparation reports
"nothing to compact", and overflow recovery fails the same way. LM Studio never errors on overflow:
it silently truncates the prompt (a 42k-token prompt at a 32k load returns 200 with a plausible
answer) and pi only notices via the reported token count. And pi's chars/4 estimate undercounts code
and lockfiles by up to 40%. `.pi/extensions/compaction/` addresses this in layers:

| Layer | What | When |
|---|---|---|
| Observation masking | all but the newest N (2 on ≤64k windows, 8 above) tool results larger than 1.5k/4k chars are replaced by a 400-char head + marker, by result age not user turn, so a read loop inside one turn is pruned too (no LLM call; the session file keeps the full output) | every request, `context` hook |
| Proactive trigger | compact at 60% of the window (85% above 64k) while idle, before pi's threshold or an overflow | `agent_end` |
| Chunked summary | history folded into the summary in chunks ≤ 30% of the summarizer's window, summary capped at 5% of the working window (1k–3k), "shorten" retry instead of discard on length | `session_before_compact` |
| Configurable summarizer | `/compaction model <provider/id>` picks who writes the summary (saved as `kernal.summaryModel` in `.pi/settings.json`; `self` = the working model; `default` = `litellm/gpt-5.4-nano`, chosen by `docs/summarizer-benchmark.md`: most detail retained at ~$0.004 per fold; `gemini-3-5-flash-lite-low` is 3x faster but terser; `KERNAL_SUMMARY_MODEL` env overrides). Falls back to the working model when the choice has no credentials | same |

**What is never touched.** The system prompt and tool schemas live outside the message list, so
neither masking nor compaction can see them. Masking only rewrites the text of `toolResult`
messages and keeps call ids, so call/result pairs stay valid. **Pinned content** survives every
compaction verbatim in a `<pinned-context>` block placed ahead of the model-written summary (the
model never sees or rewrites it): the first user message of the session, extension-injected custom
messages (e.g. pi-memory notes) that pi's default compaction would drop, and anything you mark with
`/pin <text>` or `/pin` (pins your last message).

**Long model calls.** `.pi/settings.json` sets `httpIdleTimeoutMs: 1800000` (30 min). pi aborts a
model request after that long with no bytes, headers or body alike (undici's `headersTimeout` and
`bodyTimeout`), and its own default is 5 min: a reasoning model that thinks silently, or a gateway
that holds headers until the upstream answers, crossed that on long turns. It isn't 0 (disabled), so a
dead connection still ends. The Outfitter sandbox renders this same file (`outfitter/image/render-settings.sh`).
Other limits on the path stay: pi's bash tool has no default timeout (only one the model passes), and
the LiteLLM gateway's own load balancer and Cloud Run request timeouts are set where it's deployed.

`.pi/settings.json` sets `compaction.keepRecentTokens: 6000` / `reserveTokens: 8192` only so pi's own
preparation succeeds on small windows; the extension re-derives the real budgets from the model.
**`/compaction` opens a settings dialog**: summarizer (list of authenticated models, cheapest first,
with a $/fold estimate), profile, pruning depth, masking on/off, trigger point, summary length,
compact now, reset. Choices persist under `kernal.compaction` in `.pi/settings.json`.
**Profiles** tune the layers for the kind of work: `code` keeps paths, symbols, commands and errors
and prunes tool output hardest; `research` keeps twice as many tool results and larger ones, and the
summary focuses on sources, figures and conclusions; `chat` prunes most and keeps preferences and
decisions. The default is `auto`, detected each session from the tools actually called (read/edit/
bash/grep → code; web_search/fetch/mcp → research; none → chat). Detection is deterministic and
free; it is not asked of the model, so behaviour stays predictable. Pin a profile when you know
better. `/compaction now` compacts; `/compaction model <provider/id>` sets the summarizer directly;
`KERNAL_COMPACTION=off` disables the extension;
`KERNAL_COMPACTION_LOG=<file>` logs every mask/compact event (`KERNAL_COMPACTION_DEBUG=1` adds per-request
context and overhead lines). Verified on a 32k declared window: two overflow-triggered compactions
via claude-haiku produced 300–425-token summaries and the task completed.

**Fixed overhead.** A bare session costs ~19k prompt tokens: pi's system prompt plus the tool
schemas of nine extensions. On a 32k window that is 59% before any work, which is why "nothing to
compact" appeared so often; at 128k it is 15%.

Background: JetBrains' *Complexity Trap* (2025) found masking old observations matches or beats
LLM summaries on SWE-bench at half the cost; Claude Code, OpenCode and OpenHands all prune tool
output before summarizing; Aider and Cursor summarize with a cheaper model. Survey with sources:
`docs/compaction-research.md`.

## The web admin (`.pi/extensions/kernal-admin/`)

`/admin` starts a `node:http` server inside the agent (works under pi's Bun-compiled binary too) and
opens a single-page app served from it: `app.ts` holds the HTML shell, the stylesheet and the script
as strings (no framework, no build step, nothing fetched from the network), `server.ts` the server
and its request gate, `lib.ts` the pure rules, `index.ts` the command and the API routes.

**One source of truth.** The admin never reimplements a setting. Each extension keeps its state in
its own closure, and pi gives extensions exactly one channel between them, the shared event bus
(`pi.events`). `connect/lib.ts` turns it into request/reply (`busServe`, `busRequest`), and two
extensions answer on it:

| Channel | Served by | Ops |
|---|---|---|
| `kernal:connect` | `connect` | `state` (backends, models, key rejections), `reload` (the same `registerAll` `/setup` runs), `select` (the same switch-and-save `/connect` runs) |
| `kernal:index` | `kernal-codebase-index` | `status` (its `index_status` and `knowledge_base_list` tools), `update` / `rebuild` (`index_codebase`, started and left running) |

Everything else is plain imports of the owners' exported functions: `writeEnvValues` (the `.env`
write `/setup` now uses too), `loadEnv`, `testConnection`, `normalizeBaseUrl`, `cleanKey`; and for the
index `FIELDS`, `applyEdit`, `setReranking`, `applyEmbeddingChoice` (both now also used by the `/index`
dialog), `writeConfig` (0600 when the file holds a key), the model and dimension probes. Settings are
written to the user's index config, as the dialog does: a project config replaces whole top-level
blocks, so writing one field there would drop the user's other settings in that block. The page marks
the fields a project config overrides instead. The look is `kernal-context/report.ts`'s `THEME`.

**The request gate** (`server.ts`, in this order): `Host` must be `127.0.0.1:<port>` or
`localhost:<port>`; `Origin`, when present, must be the server itself, and `Sec-Fetch-Site` must not
be cross-site; the static shell is served without a token (it holds no data); every `/api/` request
needs the per-start token in `x-kernal-admin-token` (a header, never a cookie or query string, compared
in constant time); writes must be `application/json` and under 64 KB. Every response carries a CSP
that allows only same-origin script and style and no framing. Before a response leaves, it is checked
against every key-like value in the environment and withheld if one appears in full. The idle timer
resets only on requests without `x-kernal-poll: 1`, so a forgotten tab does not keep it running.

**Subagents** (`subagents.ts`). Discovery, parsing, validation and writes are pi-subagents' own code,
imported from the installed package: `discoverAgents` / `discoverAgentsAll`, `parseFrontmatter`, and the
`create` / `update` / `eject` / `delete` handlers its `subagent` tool runs. The admin adds its own rules
around them: an agent name is a file name, so it must be the package's sanitised form (no slashes, no
dots) and is refused, not rewritten; only files whose real path is inside the user or project agents
directory are written (a symlink out of it is read-only); a file that holds a key, or looks like it
does, is never sent to the page, and a prompt carrying one is refused. After every write the package
re-discovers the agent and the result is compared with the request (file found, no diagnostic,
description, model, thinking, tools and prompt read back); any difference undoes the write. The models
(`subagents.defaultModel`, `agentOverrides.<name>.model/thinking`) are written to the agent's
`settings.json` through `connect/settings.ts`, then checked the same way. The preview is
`markdownToHtml` on the server, rebuilt in the page from a tag allowlist.

User agents live in `$PI_CODING_AGENT_DIR/agents`, which a bundle links to `~/.kernal/state/agents` and a
checkout git-ignores. kernal ships no agents; if it ever does, they belong in their own directory under
`subagents.agentScanDirs` in the shipped settings, where the admin treats them as read-only.

## Settings across an upgrade (`connect/settings.ts`, `scripts/install.sh`)

Every writer (pi, `/connect`, `/compaction`, the admin) saves into the bundle's `settings.json`, and
the bundle's own defaults live in the same file, so an upgrade can neither link it to state nor copy
the old one over. `package.sh` ships a pristine `settings.shipped.json` in every bundle; `install.sh`
reads the outgoing bundle's `settings.json` and shipped copy before replacing anything, then runs
`settings-merge.ts` with the new bundle's pi binary (a Bun executable: `BUN_BE_BUN=1 pi/pi file.ts`;
Node if the binary cannot) to do a three-way merge: a value the user changed wins, a value only the
release changed follows the release, objects merge key by key, package lists keep the user's additions
and removals. Bundles from before this had no shipped copy; for that one upgrade only the keys a user
sets through kernal are carried (`LEGACY_USER_KEYS`). An install-time merge was chosen over a load-time
overlay because pi reads `settings.json` before any extension runs and every writer, pi included,
writes that one file: merging once at install needs no change to any writer and costs nothing at start.

## Startup banner

`.pi/extensions/kernal-banner/` replaces pi's header with block-letter MGM, the provider indicator
(● = active) and the current model. `/builtin-header` restores the stock header.

## Installed packages (`.pi/settings.json` → `packages`)

| Package | Gives you | Notes |
|---|---|---|
| `pi-mcp-adapter` | MCP tools (`.pi/mcp.json`): key-backed servers via the LiteLLM gateway, OAuth servers directly | `/mcp`, `/mcp status`, `/mcp-auth <server>` |
| `pi-web-access` | `web_search`, `fetch_content` | keyless by default |
| `pi-subagents` | delegate to sub-agents with their own models | route cheap work to `lmstudio/...` |
| `pi-powerline-footer` | status bar with model, git, context %, cost | `/vibe`, `/cd` |
| `pi-memory` | long-term markdown memory + scratchpad | `~/.pi/agent/memory/`; optional `qmd` search |
| `open-codebase-index` | hybrid semantic + BM25 code search (`codebase_search`, `call_graph`, ...) | per-repo `.codebase-index/config.json` (copy the one here) pointing embeddings at LM Studio's `text-embedding-nomic-embed-text-v1.5`; run `/index` |
| `pi-lsp` | diagnostics, hover, definitions, references | `.pi/agent/lsp.json`: TypeScript, Python, Rust (see below) |

Not installed, by decision: `pi-goal-x` (peer range excludes pi 0.85), `pi-background-tasks` (peer
pinned to 0.81–0.84, untested on 0.85; Kernal's own `kernal-background` extension covers background
jobs instead, #121), `@quintinshaw/pi-dynamic-workflows` (overlaps pi-subagents;
only for mass fan-out), `pi-provider-litellm` (see below). Add with `bin/kernal install -l npm:<pkg>`.

### Why not pi-provider-litellm?

It would replace the `litellm` provider in `connect`. Extras it brings: model metadata and pricing
from `/model/info`, native Anthropic `/v1/messages` transport for Claude deployments (better
thinking-block and cache handling), `/login litellm` SSO, session-id headers for log grouping, and
its own MCP + Skills discovery. The hand-written provider already does live discovery, thinking
mapping and works with every route including `local/<user>-<host>/<model>`. Switch if you want the native
Anthropic path or cost metadata; if so disable its MCP (`litellm.mcp.enabled: false`) to avoid
double registration with pi-mcp-adapter.

## Manage on the router

`~/code/openllm/litellm-config/teams/tools.json` owns the original `pi-agent` key (alias kept on the router) and the team's models and
MCP servers (`object_permission.mcp_servers`); apply with `./apply-teams.sh`.

## MCP servers and how each authenticates

| Server | Route | Auth |
|---|---|---|
| `ce_knowledge_base`, `headroom` | LiteLLM gateway `…/mcp/` with `x-mcp-servers` | the agent key; LiteLLM holds the upstream bearer token |
| `sentry` | LiteLLM gateway `…/sentry/mcp` | OAuth through the gateway to the signed-in Sentry account; `/mcp-auth sentry` once on a laptop. The `x-litellm-api-key` header is `Bearer ${KERNAL_ROUTER_KEY}`, filled in by the process. The gateway keeps that token for the person's user id, so a Drive run key uses it with no browser. Every router key may call it |
| `google_cloud` | LiteLLM gateway `…/google_cloud/mcp` (a router toolset) | Google's product MCP servers (Cloud Run, Logging, Monitoring, Firestore) plus the gcloud CLI server, one entry and one Google sign-in as the signed-in person (`/mcp-auth google_cloud`). Tools are prefixed `<server>-<tool>`. Sysop operators only: the router admits the toolset id (`object_permission.mcp_toolsets`) to operator device keys and to run keys of `adminTools: operator` tapes with an operator owner; the Drive image ships it `disabled` and agentd enables it per run. Shipped `disabled` with `approveTools`; connect enables it when the delivered key list names `google_cloud`. The standalone `gcloud` entry (`…/gcloud/mcp`, same gating and approval) ships alongside it as the fallback: connect enables `google_cloud` when delivered and then leaves `gcloud` off, and enables `gcloud` only for a key without the toolset (id not set yet, an older Outfitter, a device key not yet re-minted). Operators run `kernal login` after the toolset id is set. Usage rules: `skills/gcloud-mcp` |

Every server goes through the LiteLLM router. The Augment work-org servers `google_admin` and
`augment_admin` (direct OAuth, augmentcode.com accounts only) were removed on 2026-10-08 (#497):
Kernal is for mgmonteleone.com people, and `/mcp-auth` kept offering a sign-in that always failed
with "Access blocked".

A Drive image cannot open a browser or a keychain. `outfitter/image/render-mcp.sh` keeps a gateway
OAuth server (one that already sends `x-litellm-api-key`, such as `sentry`) and turns client OAuth
off, so the run presents only its router key and the gateway attaches the token it stored for that
person. A direct OAuth server (one without the router header), if someone adds one, is still left out: its
token never leaves the laptop, and probing it held the first prompt on every start.

## Loading the index package, and why it is pre-bundled

The package cannot be listed in `packages`: pi loads package extensions through jiti, which hands
the runtime a data: URL of the transpiled 1 MB entry, and pi's Bun-compiled binary rejects a
specifier that long (`ResolveMessage: NameTooLong`). Requiring the package's own CommonJS build
fails too, because its dependencies are ESM-only and Bun cannot `require(esm)`. So
`scripts/prebundle.sh` (run by `scripts/package.sh`, or `npm run build:index` in a checkout) uses
esbuild to inline every dependency into one CommonJS file inside the package's `dist/`, which
`require()` loads straight from disk; `kernal-codebase-index` loads that when present and falls back to
the package's own entry under Node. Only packages that need it are pre-bundled (`PREBUNDLE`);
everything else loads the normal way, and pre-bundling them all would add a build step and break on
every package update for no gain.

## What tuning codebase search measured

**What the tuning found** (numbers and method in `docs/index-retrieval.md`, rerun with
`node --import ./tests/resolve-pi.mjs scripts/index-eval.mjs`): reranking is the only lever that
matters, doubling top-three hits and tripling top-one on a twelve-question set. Keyword balance,
weighted fusion and the score floor changed nothing. The one tuning default worth shipping is
`search.rerankTopN: 100`, because the package reranks only `maxResults` candidates otherwise, so the
reranker could merely reorder what fusion had already chosen. `voyage/rerank-3` beats the lite model.
What is left is not tuning: shell scripts are chunked at function declarations only, so a script's
body is not in the corpus, and extensionless files such as `bin/kernal` are never walked at all.

## What a release bundle contains

**Not in bundles:** `open-codebase-index`. Its single-file extension trips a `NameTooLong` in the
module loader of pi's Bun-compiled binary (reproduced on pi 0.85.1 and 0.86.1); it loads fine in a
source install, where pi runs under Node. `scripts/package.sh` drops it from the bundle's package
list (`BUNDLE_EXCLUDE` to change), and its smoke test fails the build if any remaining extension
fails to load. `install.sh` puts the bundle under `~/.kernal/kernal-<version>-<platform>` with a `current` symlink and
`kernal` in `~/.local/bin`, and after a successful install removes older bundles, keeping
`KERNAL_KEEP_VERSIONS` (default 2: the new one and the one it replaced). The pruning code is shared
text between `install.sh` and `bin/kernal` (`kernal prune`), checked identical by
`tests/install.test.ts`, because `install.sh` is downloaded and run on its own and cannot source a
sibling. `GH_TOKEN` is needed while the repo is private. Windows is not built (the launcher
is a shell script). Why not compile kernal ourselves with Bun or Node SEA: pi already is a compiled
binary, and it must load extensions from a directory on disk, so a second compile step would add
nothing.
