# mgm

The **mgm** coding agent: a project-local build of [pi](https://github.com/earendil-works/pi) 0.86.1
with a `/connect` command that switches between three backends:

| Backend | What | Models |
|---|---|---|
| `lmstudio` | Local LM Studio (MLX) on `localhost:1234` | discovered live (`qwen/qwen3.6-35b-a3b`, ...) |
| `litellm` | Cloud router `litellm.augment-code.support` | discovered live, scoped to the agent key's team |
| `openrouter` | openrouter.ai | curated list, override with `OPENROUTER_MODELS` |

## Quick start for a new user

1. Install a release (see *Releases and installing without Node*), or clone and `npm install` here.
2. Run `mgm` from any project directory. The first time, type `/setup`: it asks your name, the
   shared LiteLLM router key (ask Matthew), your own OpenRouter key, and optionally a local model
   server (LM Studio: it lists the models the server offers and you pick one). It writes `.env`
   next to the install and connects immediately, no restart. The router is the default backend
   (`litellm/claude-auto-llm`); LM Studio is only preloaded at start when you have made it your
   default with `/connect` (or set `MGM_PRELOAD_LMS=1`).
3. `/connect` picks a backend and model at any time; `/model` is pi's own picker; `/budget` shows
   what a session costs on the router.

The banner shows your block letters: **MGM** for Matthew, **MATEK** for Matej (recognised from
`MGM_USER`, git email, GitHub login or OS user), initials for anyone else, with an entrance
animation for recognised users (`MGM_NO_ANIMATION=1` skips it).

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

`/setup` writes them; or edit by hand (`.env.example` documents every key). Read from
`~/localllm/.env` (a source checkout), then the `.env` next to the agent dir (a release bundle):

- `LITELLM_AGENT_KEY` — the agent's own LiteLLM virtual key (its team decides which models and MCP servers appear). Falls back to `LITELLM_API_KEY` if unset.
- `OPENROUTER_API_KEY` — from openrouter.ai (starts with `sk-or-v1-`)
- optional: `LMSTUDIO_BASE_URL`, `LITELLM_BASE_URL`, `OPENROUTER_MODELS`

Keys are normalised before use (surrounding quotes, a pasted `Bearer `/`Token ` prefix and stray
whitespace are stripped) and checked against the provider at start-up and after `/setup`. A cloud
backend whose key is missing or rejected is hidden entirely: none of its models appear in `/model`
or `/connect`, and the banner/start-up notice says why (e.g. `openrouter rejected the key (401:
Missing Authentication header)`). OpenRouter's built-in pi provider is switched off in the same
case, so no OpenRouter model is ever offered unless OpenRouter is actually connected.

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

## Releases and installing without Node

Publishing a GitHub release tagged `vX.Y.Z` (semver; `v1.2.0-rc.1` style pre-releases allowed)
runs `.github/workflows/release.yml`: validate the tag, run the tests, then build on four runners
(darwin-arm64, darwin-x64, linux-x64, linux-arm64) and attach `mgm-<version>-<platform>.tar.gz`
with a `.sha256` and `install.sh`. Every push to `main` touching `mgm/` runs `ci.yml` (tests plus
an offline start of the agent).

A bundle is **pi's official standalone binary** (a Bun-compiled executable, checksum-verified
against pi's release) for the pi version pinned in `package.json`, plus this repo's `.pi/`
extensions, settings and MCP config, the extension packages installed from `.pi/npm`'s lockfile
with other platforms' native binaries removed, the launcher, docs and `.env.example`. Users need
no Node. We never modify pi; everything mgm adds is extensions, so upgrading pi is a version bump.

```bash
# release (maintainer)
gh release create v0.2.0 --title "mgm 0.2.0" --notes "..."          # → CI builds and attaches bundles
scripts/package.sh 0.2.0 darwin-arm64                               # the same build, locally → dist/

# install (user)
# while the repo is private, download through a logged-in gh (the curl form needs a public repo):
gh release download --repo mgmonteleone/mgm-pi --pattern install.sh --dir /tmp --clobber && bash /tmp/install.sh
cp ~/.mgm/current/.env.example ~/.mgm/current/.env   # add keys; kept across upgrades
mgm
```

**Not in bundles:** `open-codebase-index`. Its single-file extension trips a `NameTooLong` in the
module loader of pi's Bun-compiled binary (reproduced on pi 0.85.1 and 0.86.1); it loads fine in a
source install, where pi runs under Node. `scripts/package.sh` drops it from the bundle's package
list (`BUNDLE_EXCLUDE` to change), and its smoke test fails the build if any remaining extension
fails to load. `install.sh` puts the bundle under `~/.mgm/<version>` with a `current` symlink and
`mgm` in `~/.local/bin`. `GH_TOKEN` is needed while the repo is private. Windows is not built (the launcher
is a shell script). Why not compile mgm ourselves with Bun or Node SEA: pi already is a compiled
binary, and it must load extensions from a directory on disk, so a second compile step would add
nothing.

### Staying up to date

An installed bundle checks GitHub for a newer release once a day (extension `mgm-update`, cached in
`~/.mgm/.update-check.json`, via the `gh` CLI or `GH_TOKEN`). When one exists the start-up notice
and the status bar say so, e.g. `⬆ 0.1.5 available · /update`. Then either

- inside the agent: `/update` (or `/update check` to just look), then restart mgm; or
- from a shell: `mgm update` (`mgm update 0.1.5` for a specific version), `mgm version` to see what
  is installed.

Both run the release installer: the new bundle lands next to the old one under `~/.mgm`, `current`
moves to it, and the `.env` with your keys is carried over. Source checkouts are never nagged;
`git pull` is the update there. `MGM_NO_UPDATE_CHECK=1` disables the automatic check.

## Tests

```bash
npm test               # unit + extension harness tests (no services needed)
npm run test:coverage  # same, with per-file coverage
npm run test:e2e       # live runs against LM Studio, LiteLLM and OpenRouter (MGM_E2E=1)
```

`npm run test:live` runs `tests/live.test.ts` against the real LiteLLM router: model listing, a
minimal completion with spend headers, the agent answering and calling a tool through the router,
and one real compaction fold on the default summarizer. It uses the cheapest capable model
(`gpt-5.4-nano`), tiny token limits and a hard cost ceiling read from the router's own cost
headers; a run costs well under $0.01. It needs `LITELLM_AGENT_KEY` (and `MGM_LIVE=1`); in GitHub
it reads the `LITELLM_CI_KEY` repository secret, runs as a gate in the release workflow and on
demand from *Actions → mgm live tests*, and skips itself when the secret is absent. Set the secret
with `gh secret set LITELLM_CI_KEY --repo mgmonteleone/mgm-pi`, ideally with a dedicated router key
on a small budget.

`tests/*.test.ts` cover the pure libraries; `tests/extensions.test.ts` drives the real entry points
through a fake pi and context (`tests/harness.ts`): scripted dialog answers, stubbed summarizer,
temporary agent dir for settings persistence. `tests/resolve-pi.mjs` lets plain Node resolve pi's
nested `pi-ai` / `pi-tui` packages the way pi does for extensions. `MGM_NO_DISCOVERY=1` skips the
network model discovery (used by the tests; also handy offline).

## Voice input (pi-listen)

Hold **ctrl+shift+v** and talk; release to transcribe into the prompt. Release bundles ship a
shared `DEEPGRAM_API_KEY` in their `.env` (from the `DEEPGRAM_API_KEY` repo secret; locally from
`~/localllm/.env`), so pi-listen streams live transcription out of the box. Without a key, pi-listen
would default to Deepgram anyway and sit unconfigured, reading `~/.pi/agent/settings.json`;
`.pi/extensions/mgm-voice/` therefore seeds a fully local setup there the first time mgm starts,
if nothing is configured yet: backend `local`, model
`parakeet-v3` (pi-listen's recommended offline model, ~670 MB, downloaded on first use with a
progress bar), language from your locale. It never overrides an existing choice; `/voice-settings`
changes model, language or backend, `MGM_VOICE_MODEL` picks another default, `MGM_VOICE=off`
disables the seeding. Audio capture needs SoX (`brew install sox`) or ffmpeg; mgm and the installer
say so when neither is found.

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
