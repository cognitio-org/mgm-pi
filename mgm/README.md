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
   (`litellm/gpt-5.4-nano`, the cheapest capable route; `/connect` or `/model` for a stronger one); LM Studio is only preloaded at start when you have made it your
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

**Extension packages** are a separate thing from the bundle. pi notices when one of the installed
packages has a new version and says so at start-up; update them with `/update extensions` in the
agent, or `mgm update --extensions` (also `--extension <name>` for one, `--models` to refresh pi's
model catalogs). `mgm update` with no flag is the bundle; `--all` and `--self` are refused so the
two never get confused.

In a release bundle a package update lives in that bundle only, and the next `mgm update` restores
the versions the release pinned. The durable path is this repo: run `mgm update --extensions` in a
checkout, commit the changed `.pi/npm/package.json` and `package-lock.json`, and the next release
ships them. pi's updater rewrites the lockfile from the installed tree, which drops entries nothing
needs (it no longer records pi's own dependency tree); `npm ci` for all four release targets still
resolves, and `scripts/package.sh` smoke-tests the result.

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

## Reporting problems (`/report`)

pi's own `/bug` uploads to the pi developers and is handled by the TUI before extensions see it,
so mgm adds `/report [description]` (extension `mgm-report`). It collects what pi's report has
(mgm and pi versions, OS, model, packages and extensions, the last provider error, recorded
crashes), asks whether to include a transcript tail (last 40 messages, tool output clipped), redacts
API keys and secret-looking tokens, writes a local copy under `.pi/bug-reports/`, and files a
GitHub issue in `mgmonteleone/mgm-pi` assigned to Matthew via the `gh` CLI (collaborators only).
After a failed model turn the agent points at `/report` once. `MGM_REPORT_REPO` /
`MGM_REPORT_ASSIGNEE` override the target; if `gh` is not logged in the report stays local and the
notice says where it is.

## Language servers (`.pi/agent/lsp.json`)

`pi-lsp` starts a language server after a `write` or `edit`, waits for its diagnostics and appends
them to the tool result, so the model sees a type error in the file it just wrote without running a
build. It also gives the model `lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`
and `lsp_symbols`. `.pi/agent/lsp.json` configures two servers:

| id | Files | Binary | Install it with |
|---|---|---|---|
| `typescript` | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `typescript-language-server --stdio` | `npm install -g typescript-language-server "typescript@5"` |
| `python` | `.py .pyi` | `pyright-langserver --stdio` | `npm install -g pyright` |

**Nothing is bundled.** Language servers belong to your toolchain, not to the agent, and both of
these want to be global so they work in every repo. Install the ones for the languages you actually
write, and skip the rest. **A server that is not installed
costs one line** on the write or edit that would have used it —
`⚠️ typescript: LSP binary not found: typescript-language-server` — and nothing else: no start-up
error, the tool call still succeeds, and pi-lsp backs off before trying again. Nothing at all
happens until a matching file is written, so an install with no language servers behaves exactly as
it did before.

`bin/mgm` points `PI_AGENT_DIR` (pi-lsp's own variable, not pi's) at this folder's `.pi/agent/`,
which is what makes that file pi-lsp's user-owned, auto-trusted config in whatever repo you run mgm.
A *project-local* `.pi/lsp.json` is a different thing: pi-lsp asks to trust it once per content hash
and refuses it outright in `-p` mode. Use one in a repo to override an entry by `id`
(`{"version": 1, "servers": [{"id": "python", "enabled": false}]}` switches one off there). The
config sits one level below `.pi/` precisely so that running mgm inside this folder does not find
the same file again as an untrusted project-local one.

Notes from setting this up:

- `typescript-language-server` needs **TypeScript 5**; `typescript@7` (the native port) has no
  `lib/tsserver.js` and the server exits with *Could not find a valid TypeScript installation*.
  Installed globally beside it, that copy is used in every repo, including repos with no
  `typescript` dependency of their own — like this one.
- The wait for diagnostics is 2.5 s for each server. A slow first edit of a session can still come
  back `✅ typescript: no diagnostics`; asking for `lsp_diagnostics` on the file a moment later
  returns what arrived late.
- Root markers are `tsconfig.json`/`jsconfig.json`/`package.json`/`.git` and the usual Python
  project files plus `.git`. `.git` is there so a stray script in a repo still gets a server.
  `node_modules`, `dist`, `build`, `*.min.js` and virtualenvs are excluded. Another language is one
  entry in this file, in the shape the `pi-lsp` README documents.
## Teleport

Move a pi session between machines, the way Claude Code's teleport does: push it from one checkout,
pull it into another. `.pi/extensions/teleport/lib.ts` defines a small `Store` interface
(`list`/`get`/`put`) and a `GitStore` implementation on top of it, so the store can later be swapped
for a cloud API ("Outfitter") without touching the commands in `.pi/extensions/teleport/index.ts`.

**What gets pushed.** `/teleport push` sends the *entire* session transcript -- every prompt, tool
call and tool result, which can include file contents, command output and anything pasted into the
chat -- to `MGM_TELEPORT_STORE`'s git remote, unencrypted and with no secret-pattern scan beforehand.
Make sure that remote is a **private**, access-controlled repo before you set it up; treat anything
teleported there the same as you would a checked-in secret.

```
/teleport                 interactive picker: pick a pushed session, then pull it
/teleport list            list sessions in the store
/teleport push [name]     push the current session
/teleport pull [id]       pull a session by id (prompts to pick one if omitted)
mgm --teleport <id>       headless pull + launch, from any shell (see below)
```

### Store layout

`GitStore` is a local clone directory — `MGM_TELEPORT_STORE`, default `~/.mgm-sessions` — that is
itself a git repo (`git remote add origin <your-private-repo>` once; it works local-only, with a
warning, if there's no remote or it's unreachable):

```
~/.mgm-sessions/
  index.json            # array of {id, name?, cwd, repo?, branch?, updatedAt, host}
  sessions/<id>.jsonl   # the session file, byte-for-byte
  sessions/<id>.json    # manifest: {id, name?, host, cwd, repo?: {remote, ownerRepo, branch, head}, pushedAt}
```

`push` first syncs the clone (`git pull --ff-only`, falling back to `git pull --rebase` if another
machine pushed in between), then writes those files, updates `index.json` from the now-synced state,
and does `git add`/`commit`/`push`. If `push` is rejected as non-fast-forward (another push landed
between the sync above and this one), it rebases once more and retries; if that still fails — including
being offline with no remote reachable — the commit stays local-only and `put()` throws, so `/teleport
push` reports a clear error instead of claiming success. `list`/`pull` do their own `git pull --ff-only`
first. Push also appends a `custom` session entry (`customType: "teleport"`, via `pi.appendEntry`)
recording the manifest, so `/session`-style tooling can see when and where a session was last
teleported.

### Requirements, mirrored from Claude Code's teleport

- **Clean tree.** `push` and `pull` both refuse (`commit or stash first`) if `git status --porcelain`
  is non-empty in the target checkout.
- **Same repo.** If the manifest has a `repo` (i.e. the source checkout had a git remote), `pull`
  compares its `ownerRepo` (parsed from `https://…`, `git@host:owner/repo.git`, and `ssh://` remotes)
  against the current checkout's `origin`. A mismatch refuses and names both repos.
- **Branch pushed.** `push` runs `git push -u origin <branch>` first when the branch has no upstream
  or is ahead of it, so the commit the session was working from is actually reachable. `pull` does
  `git fetch origin <branch> && git checkout <branch>` before importing.
- The session id is preserved across the hop (`SessionManager.forkFrom(tmpFile, cwd, undefined, {
  id })`); if a session with that id already exists locally, the interactive `/teleport pull` asks
  whether to overwrite it or fork under a new id, and the headless `mgm --teleport` always forks
  under a new id (the non-destructive default with no one there to ask).

### Model remap

Sessions record which provider/model they were using. `pickModelForHost` looks at the last
`model_change` on the imported session: if that provider is available on this host (has configured
auth), it's kept; otherwise the session falls back to `litellm/local-qwen-mlx`, which every `mgm`
install can reach. `/teleport pull` notifies which model it picked.

### What doesn't travel

Same caveats as any cross-machine handoff: environment secrets (`~/localllm/.env`, `LITELLM_AGENT_KEY`,
etc. — each machine needs its own), MCP OAuth tokens sitting in the macOS keychain (`/mcp-auth
<server>` again on the new machine), and anything that only exists in that machine's LM Studio
(local-only model weights, `lmstudio/...` sessions won't have a usable model there unless LM Studio
is also running with the same model loaded).

### Headless: `mgm --teleport <id>`

pi has no "run a slash command at startup" flag, so `bin/mgm` handles `--teleport` itself: before pi
starts, `.pi/extensions/teleport/cli.ts` does the store lookup, repo/branch checks, and
`SessionManager.forkFrom` import (headlessly — no interactive prompts, so an id collision always
forks under a new id), prints the resulting session file path, and `bin/mgm` execs
`pi -a --session <path> ...` pointed at it. Everything else about `mgm`'s argument handling is
unchanged.

### Auto-push

Off by default. Set `teleport.autoPush: true` in `.pi/settings.json` to push after every turn
(`agent_end`) when the tree is clean. It's silent about "not ready to push yet" (dirty tree, no repo,
ephemeral `--no-session`) and only notifies on a real failure; it never blocks or throws.
## Codebase search (`open-codebase-index`)

Semantic and keyword retrieval over the repo you are in. It is all model-facing: the package
registers tools, not slash commands, so you ask for it in words ("index this repo", "search the
codebase for where X happens") and the agent calls `index_codebase`, `index_status`,
`codebase_context`, `codebase_peek`, `codebase_search`, `implementation_lookup`, `find_similar`,
`call_graph`, `call_graph_path` or `pr_impact`. The package's `codebase-search` skill, which tells
the model to reach for those before grepping, is copied into `.pi/skills/` by `scripts/prebundle.sh`
(pi installs a package's skills only for packages it manages, and this one is loaded by
`.pi/extensions/mgm-codebase-index`).

`/index` is mgm's own panel over it: the chunk count and branch, where the store is, the embedding
model with whether the server answers and has it resident, the search settings and indexing flags,
which config file is in effect, the knowledge bases and the tool count. The picker under it runs the
same tools the model uses: update the index, rebuild from scratch, estimate first, health check,
metrics, recent log, add or remove a knowledge base. Escape leaves the panel up, `/index off` takes
it down, and the status bar keeps a `⌕ 190 chunks` (or `⌕ no index`) entry. Without the TUI, and for
scripts, `/index status | update | reindex | estimate | health | metrics | logs | bases` print text
instead. The command drives the package's own tools through a capture of `registerTool`, so there is
no second implementation of anything.

**Settings** are editable from the same picker, not just readable. The dialog lists every setting the
shipped package actually reads, with its current value: embedding server, embedding model,
dimensions, provider, index-automatically, watch-files, semantic-only, max results, min score,
fusion strategy and rerank top N. Choosing the model lists the embedding models the server reports
(LM Studio types them, so only embedding models are offered); choosing dimensions can measure them
by asking the server for one embedding and counting it, which is the only reliable source and the
difference between working search and silent nonsense. Values are validated before they are written,
and changing anything that alters how text is embedded (server, model, dimensions, provider) offers
the rebuild those changes require, or warns that search stays stale until you run one. Edits go to
whichever config file is in effect, and one entry copies the current settings into the project so a
repo can override your user defaults. **Reranking** runs on the LiteLLM router and nowhere else. The router carries `voyage/rerank-3` and
`voyage/rerank-3-lite`, and its `/v1/rerank` takes the Cohere-shaped request the package posts to
`<endpoint>/rerank`. So the dialog asks for one thing: switch *Reranking* on and pick a model from the
router's live list of rerank deployments. The endpoint and key come from `LITELLM_BASE_URL` and
`LITELLM_AGENT_KEY`, which the agent already has, and they are refreshed from the environment on
every start, so rotating the router key needs no visit here. Switching it off keeps the model for next
time. Without a router configured it says to run `/setup` instead of writing anything.

Two things it tells you when you turn it on: result snippets go to the router and its upstream
provider and are billed to that key, and the key ends up in the config file (written owner-only)
because the package reads `reranker.apiKey` from there and has no environment indirection. The key is
only ever shown as `set (…4321)`. Reranking is a query-time pass, so turning it on or off never
invalidates the index. The package also supports Cohere and Jina directly; those are not offered here
and can be set by hand in the config file, as can `ignore` globs and `scope`.

**What the tuning found** (numbers and method in `docs/index-retrieval.md`, rerun with
`node --import ./tests/resolve-pi.mjs scripts/index-eval.mjs`): reranking is the only lever that
matters, doubling top-three hits and tripling top-one on a twelve-question set. Keyword balance,
weighted fusion and the score floor changed nothing. The one tuning default worth shipping is
`search.rerankTopN: 100`, because the package reranks only `maxResults` candidates otherwise, so the
reranker could merely reorder what fusion had already chosen. `voyage/rerank-3` beats the lite model.
What is left is not tuning: shell scripts are chunked at function declarations only, so a script's
body is not in the corpus, and extensionless files such as `bin/mgm` are never walked at all.

**A trap worth knowing, because it made search useless here.** The package's directory walk skips any
path segment beginning with a dot *before* it looks at include or exclude rules, so nothing in
`.pi/`, `.github/` or any other dot-directory can be indexed by configuration. In this repo that is
the entire implementation: the first index of `~/localllm` held 23 files, all tests, docs and
scripts, and not one extension source, so searches for real code returned test files and README
prose. Adding `mgm/.pi/extensions` as a knowledge base (the only supported route into a
dot-directory) took it to 140 files and 1,615 chunks, and the same query then returned
`connect/index.ts` as the top hit at 96.9%. The panel now says so on its own: a `skipped` row lists
dot-directories that hold tracked source no knowledge base covers, with an action that adds one and
reindexes. Reranking cannot rescue a corpus that never contained the answer, which is why turning it
on before this was found changed nothing useful.

The index is per project, in `<project>/.codebase-index/`, and it is built on request, never on
start. Indexing needs the embedding model, so the local model server has to be up; it loads
`text-embedding-nomic-embed-text-v1.5` on the first request. To see where you stand, ask the agent
for the index status: it reports the chunk count and says `Codebase is not indexed` when there is
nothing yet. Embeddings come from your own model server, so indexing costs nothing
and never leaves the machine: `.pi/extensions/mgm-codebase-index` writes
`~/.config/codebase-index/config.json` on first run, pointing at `LMSTUDIO_BASE_URL` with
`text-embedding-nomic-embed-text-v1.5`. A project's own `.codebase-index/config.json` still wins,
and a config you have edited is never overwritten. `MGM_NO_CODEBASE_INDEX=1` turns it off.

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

Indexing ~50 files takes about half a minute. Tuning lives in that config file: `indexing.autoIndex`
(off here, so indexing stays an explicit request), `indexing.watchFiles`, `search.maxResults`,
`search.minScore`, and `knowledgeBases` to index extra directories such as pi's own docs.

One trap: running an installed bundle from inside this checkout loads both copies of the extensions
and pi refuses the duplicate tools. Run the installed `mgm` anywhere else, or use `bin/mgm` here.

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
