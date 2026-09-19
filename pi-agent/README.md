# pi-agent

[pi](https://github.com/earendil-works/pi) coding agent, project-local, with a `/connect`
command that switches between three backends:

| Backend | What | Models |
|---|---|---|
| `lmstudio` | Local LM Studio (MLX) on `localhost:1234` | discovered live (`qwen/qwen3.6-35b-a3b`, ...) |
| `litellm` | Cloud router `litellm.augment-code.support` | discovered live, scoped to the `pi-agent` key's team (`tools`) |
| `openrouter` | openrouter.ai | curated list, override with `OPENROUTER_MODELS` |

## Run (from any repo)

```bash
npm install                                   # once, in this folder
alias mgm=~/localllm/pi-agent/bin/mgm         # put in ~/.zshrc
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

`~/code/openllm/litellm-config/teams/tools.json` owns the `pi-agent` key and the team's models and
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
