# mgm

The **mgm** coding agent: a project-local build of [pi](https://github.com/earendil-works/pi)
with a `/connect` command that switches between three backends:

| Backend | What | Models |
|---|---|---|
| `lmstudio` | Local LM Studio (MLX) on `localhost:1234` | discovered live (`qwen/qwen3.6-35b-a3b`, ...) |
| `litellm` | Cloud router `litellm.augment-code.support` | discovered live, scoped to the agent key's team |
| `openrouter` | openrouter.ai | curated list, override with `OPENROUTER_MODELS` |

## Run (from any repo)

```bash
npm install                                   # once, in this folder
alias mgm=~/localllm/mgm/bin/mgm              # put in ~/.zshrc
cd ~/code/some-repo && mgm                    # interactive
mgm -p "explain this repo"                    # non-interactive
```

`bin/mgm` sets `PI_CODING_AGENT_DIR` to this folder's `.pi/`, so extensions, packages, settings and
sessions all live here instead of `~/.pi/agent` (which is left untouched), and it exports the
secrets from `~/localllm/.env` for packages that use `${VAR}`.

Inside pi:

```
/connect                         pick backend, then model
/connect litellm                 pick a model on the router
/connect lmstudio qwen/qwen3.6-35b-a3b
/model                           pi's own picker also lists all three providers
```

Model can also be given on the CLI: `pi --model litellm/claude-sonnet-5:high`.
The choice is saved to `.pi/settings.json` (`defaultProvider` / `defaultModel`) and reused next start.

Non-interactive: `npx pi -a -p --model lmstudio/qwen/qwen3.6-35b-a3b "prompt"` (`-a` trusts project files).

## Secrets

Read from `~/localllm/.env` (shared with the rest of the localllm project), then `./.env`:

- `LITELLM_AGENT_KEY` — the agent's own LiteLLM virtual key (its team decides which models and MCP servers appear). Falls back to `LITELLM_API_KEY` if unset.
- `OPENROUTER_API_KEY` — from openrouter.ai
- optional: `LMSTUDIO_BASE_URL`, `LITELLM_BASE_URL`, `OPENROUTER_MODELS`

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
| Cloud summarizer | `MGM_SUMMARY_MODEL` (default `litellm/claude-haiku-4-5`) writes the summary when it has credentials; otherwise the working model does | same |

`.pi/settings.json` sets `compaction.keepRecentTokens: 6000` / `reserveTokens: 8192` only so pi's own
preparation succeeds on small windows; the extension re-derives the real budgets from the model.
`/compaction` shows them; `/compaction now` compacts; `MGM_COMPACTION=off` disables the extension;
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

## Known issue: startup stalls while LM Studio is mid-generation

Deterministic repro: start any long generation against LM Studio, then launch mgm from any
directory with any model (even a cloud one). Startup performs its two discovery requests (LM
Studio `/v1/models`, router `/model/info`), both succeed, then pi stalls with no further network
activity until LM Studio's generation finishes. It reproduces with all packages removed, so it is
in pi itself or in this repo's extensions, not in an add-on. Not resolved yet. In practice it bites
when two clients share the local model (e.g. an interactive session on `litellm/local-qwen-mlx`
via the router plus a second `mgm` launch). Thinking off by default keeps generations short, so
the wait is seconds rather than minutes. If a launch sits silent, check `lms ps --json` for
`generating`/`processingPrompt` and wait or `lms unload --all`.

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
| `pi-lsp` | diagnostics, hover, definitions, references | `.pi/lsp.json` per language server |

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
