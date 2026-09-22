# mgm internals

How the parts work and why. The user-facing guide is [../README.md](../README.md); this file is for
whoever has to change the thing. mgm is extensions and settings on top of the pi coding agent, and
pi's own source is never modified: everything below lives in `.pi/extensions`, `.pi/settings.json`,
`bin/mgm` or `scripts/`.

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
- Set `MGM_SPEND_LOG=/path/file.jsonl` to append one JSON line per call for auditing.

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

**Thinking is off by default for the local routes** (`modelThinkingLevels` in `.pi/settings.json`).
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
| Configurable summarizer | `/compaction model <provider/id>` picks who writes the summary (saved as `mgm.summaryModel` in `.pi/settings.json`; `self` = the working model; `default` = `litellm/gpt-5.4-nano`, chosen by `docs/summarizer-benchmark.md`: most detail retained at ~$0.004 per fold; `gemini-3-5-flash-lite-low` is 3x faster but terser; `MGM_SUMMARY_MODEL` env overrides). Falls back to the working model when the choice has no credentials | same |

**What is never touched.** The system prompt and tool schemas live outside the message list, so
neither masking nor compaction can see them. Masking only rewrites the text of `toolResult`
messages and keeps call ids, so call/result pairs stay valid. **Pinned content** survives every
compaction verbatim in a `<pinned-context>` block placed ahead of the model-written summary (the
model never sees or rewrites it): the first user message of the session, extension-injected custom
messages (e.g. pi-memory notes) that pi's default compaction would drop, and anything you mark with
`/pin <text>` or `/pin` (pins your last message).

`.pi/settings.json` sets `compaction.keepRecentTokens: 6000` / `reserveTokens: 8192` only so pi's own
preparation succeeds on small windows; the extension re-derives the real budgets from the model.
**`/compaction` opens a settings dialog**: summarizer (list of authenticated models, cheapest first,
with a $/fold estimate), profile, pruning depth, masking on/off, trigger point, summary length,
compact now, reset. Choices persist under `mgm.compaction` in `.pi/settings.json`.
**Profiles** tune the layers for the kind of work: `code` keeps paths, symbols, commands and errors
and prunes tool output hardest; `research` keeps twice as many tool results and larger ones, and the
summary focuses on sources, figures and conclusions; `chat` prunes most and keeps preferences and
decisions. The default is `auto`, detected each session from the tools actually called (read/edit/
bash/grep → code; web_search/fetch/mcp → research; none → chat). Detection is deterministic and
free; it is not asked of the model, so behaviour stays predictable. Pin a profile when you know
better. `/compaction now` compacts; `/compaction model <provider/id>` sets the summarizer directly;
`MGM_COMPACTION=off` disables the extension;
`MGM_COMPACTION_LOG=<file>` logs every mask/compact event (`MGM_COMPACTION_DEBUG=1` adds per-request
context and overhead lines). Verified on a 32k declared window: two overflow-triggered compactions
via claude-haiku produced 300–425-token summaries and the task completed.

**Fixed overhead.** A bare session costs ~19k prompt tokens: pi's system prompt plus the tool
schemas of nine extensions. On a 32k window that is 59% before any work, which is why "nothing to
compact" appeared so often; at 128k it is 15%.

Background: JetBrains' *Complexity Trap* (2025) found masking old observations matches or beats
LLM summaries on SWE-bench at half the cost; Claude Code, OpenCode and OpenHands all prune tool
output before summarizing; Aider and Cursor summarize with a cheaper model. Survey with sources:
`docs/compaction-research.md`.

## The web admin (`.pi/extensions/mgm-admin/`)

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
| `mgm:connect` | `connect` | `state` (backends, models, key rejections), `reload` (the same `registerAll` `/setup` runs), `select` (the same switch-and-save `/connect` runs) |
| `mgm:index` | `mgm-codebase-index` | `status` (its `index_status` and `knowledge_base_list` tools), `update` / `rebuild` (`index_codebase`, started and left running) |

Everything else is plain imports of the owners' exported functions: `writeEnvValues` (the `.env`
write `/setup` now uses too), `loadEnv`, `testConnection`, `normalizeBaseUrl`, `cleanKey`; and for the
index `FIELDS`, `applyEdit`, `setReranking`, `applyEmbeddingChoice` (both now also used by the `/index`
dialog), `writeConfig` (0600 when the file holds a key), the model and dimension probes. Settings are
written to the user's index config, as the dialog does: a project config replaces whole top-level
blocks, so writing one field there would drop the user's other settings in that block. The page marks
the fields a project config overrides instead. The look is `mgm-context/report.ts`'s `THEME`.

**The request gate** (`server.ts`, in this order): `Host` must be `127.0.0.1:<port>` or
`localhost:<port>`; `Origin`, when present, must be the server itself, and `Sec-Fetch-Site` must not
be cross-site; the static shell is served without a token (it holds no data); every `/api/` request
needs the per-start token in `x-mgm-admin-token` (a header, never a cookie or query string, compared
in constant time); writes must be `application/json` and under 64 KB. Every response carries a CSP
that allows only same-origin script and style and no framing. Before a response leaves, it is checked
against every key-like value in the environment and withheld if one appears in full. The idle timer
resets only on requests without `x-mgm-poll: 1`, so a forgotten tab does not keep it running.

## Startup banner

`.pi/extensions/mgm-banner/` replaces pi's header with block-letter MGM, the provider indicator
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
pinned to 0.81–0.84, untested on 0.85), `@quintinshaw/pi-dynamic-workflows` (overlaps pi-subagents;
only for mass fan-out), `pi-provider-litellm` (see below). Add with `bin/mgm install -l npm:<pkg>`.

### Why not pi-provider-litellm?

It would replace the `litellm` provider in `connect`. Extras it brings: model metadata and pricing
from `/model/info`, native Anthropic `/v1/messages` transport for Claude deployments (better
thinking-block and cache handling), `/login litellm` SSO, session-id headers for log grouping, and
its own MCP + Skills discovery. The hand-written provider already does live discovery, thinking
mapping and works with every route including `local-qwen-mlx`. Switch if you want the native
Anthropic path or cost metadata; if so disable its MCP (`litellm.mcp.enabled: false`) to avoid
double registration with pi-mcp-adapter.

## Manage on the router

`~/code/openllm/litellm-config/teams/tools.json` owns the original `pi-agent` key (alias kept on the router) and the team's models and
MCP servers (`object_permission.mcp_servers`); apply with `./apply-teams.sh`.

## MCP servers and how each authenticates

| Server | Route | Auth |
|---|---|---|
| `ce_knowledge_base`, `headroom` | LiteLLM gateway `…/mcp/` with `x-mcp-servers` | the agent key; LiteLLM holds the upstream bearer token |
| `google_admin` | direct to the Cloud Run MCP | OAuth 2.1 (Google sign-in, PKCE, dynamic registration); run `/mcp-auth google_admin` once, tokens live in the macOS keychain |
| `augment_admin` | direct to `l.augment-code.support/mcp` | same, `/mcp-auth augment_admin` |

Why not everything through LiteLLM: the last two are registered there as `oauth_delegate`, which means
LiteLLM only forwards a token the client already obtained from the upstream's own OAuth server
(`x-mcp-<server>-authorization`). The client has to run that OAuth flow either way, so connecting
directly is simpler and avoids the per-server route restriction on the key. The router's `tools/list`
silently omits `oauth_delegate` servers when no delegated token is present, which is why only
`search_ce_knowledge_base` showed up.

## Loading the index package, and why it is pre-bundled

The package cannot be listed in `packages`: pi loads package extensions through jiti, which hands
the runtime a data: URL of the transpiled 1 MB entry, and pi's Bun-compiled binary rejects a
specifier that long (`ResolveMessage: NameTooLong`). Requiring the package's own CommonJS build
fails too, because its dependencies are ESM-only and Bun cannot `require(esm)`. So
`scripts/prebundle.sh` (run by `scripts/package.sh`, or `npm run build:index` in a checkout) uses
esbuild to inline every dependency into one CommonJS file inside the package's `dist/`, which
`require()` loads straight from disk; `mgm-codebase-index` loads that when present and falls back to
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
body is not in the corpus, and extensionless files such as `bin/mgm` are never walked at all.

## What a release bundle contains

**Not in bundles:** `open-codebase-index`. Its single-file extension trips a `NameTooLong` in the
module loader of pi's Bun-compiled binary (reproduced on pi 0.85.1 and 0.86.1); it loads fine in a
source install, where pi runs under Node. `scripts/package.sh` drops it from the bundle's package
list (`BUNDLE_EXCLUDE` to change), and its smoke test fails the build if any remaining extension
fails to load. `install.sh` puts the bundle under `~/.mgm/<version>` with a `current` symlink and
`mgm` in `~/.local/bin`. `GH_TOKEN` is needed while the repo is private. Windows is not built (the launcher
is a shell script). Why not compile mgm ourselves with Bun or Node SEA: pi already is a compiled
binary, and it must load extensions from a directory on disk, so a second compile step would add
nothing.
