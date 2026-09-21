# mgm

The **mgm** coding agent: a project-local build of [pi](https://github.com/earendil-works/pi) 0.86.1
with a `/connect` command that switches between three backends:

| Backend | What | Models |
|---|---|---|
| `lmstudio` | Local LM Studio (MLX) on `localhost:1234` | discovered live (`qwen/qwen3.6-35b-a3b`, ...) |
| `litellm` | Cloud router `litellm.augment-code.support` | discovered live, scoped to the agent key's team |
| `openrouter` | openrouter.ai | curated list, override with `OPENROUTER_MODELS` |

Everything here is extensions and settings on top of pi; pi's own source is never modified. How the
pieces work inside, and why they are built that way, is in [docs/architecture.md](docs/architecture.md).

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

**State that is yours, not a version's.** A bundle lives in `~/.mgm/mgm-<version>-<platform>`, so
`PI_CODING_AGENT_DIR` moves on every upgrade. Session history, credentials, trust decisions and caches
therefore live in `~/.mgm/state` and are symlinked into the bundle, which is what makes
`mgm --session <id>` keep working after an upgrade: pi only searches the current agent dir, so before
this they looked deleted. The installer gathers state left inside older bundles once.
`MGM_STATE` moves the directory.

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

## Codebase search (`open-codebase-index`)

Semantic and keyword retrieval over the repo you are in. It is all model-facing: the package
registers tools, not slash commands, so you ask for it in words ("index this repo", "search the
codebase for where X happens") and the agent calls `index_codebase`, `index_status`,
`codebase_context`, `codebase_peek`, `codebase_search`, `implementation_lookup`, `find_similar`,
`call_graph`, `call_graph_path` or `pr_impact`. The package's `codebase-search` skill, which tells
the model to reach for those before grepping, is copied into `.pi/skills/` by `scripts/prebundle.sh`
(pi installs a package's skills only for packages it manages, and this one is loaded by
`.pi/extensions/mgm-codebase-index`).

**While a run is going you can see it.** Indexing a large repository takes minutes, and the package
reports progress only when asked, so a run the model started used to look like nothing happening.
The status bar now ticks `⌕ embedding 27% · 128/478 files` and the panel shows a bar, whether the run
came from the picker or from the model calling the tool itself. The indexer's own percentage is per
batch and jumps backwards, so the bar is driven by the file count, which only goes up.

`/index` is mgm's own panel over it: the chunk count and branch, where the store is, the embedding
model with whether the server answers and has it resident, the search settings and indexing flags,
which config file is in effect, the knowledge bases and the tool count. The picker under it runs the
same tools the model uses: update the index, rebuild from scratch, estimate first, health check,
metrics, recent log, add or remove a knowledge base. Escape leaves the panel up, `/index off` takes
it down, and the status bar keeps a `⌕ 190 chunks` (or `⌕ no index`) entry. Without the TUI, and for
scripts, `/index status | update | reindex | estimate | health | metrics | logs | bases` print text
instead. The command drives the package's own tools through a capture of `registerTool`, so there is
no second implementation of anything.

**Embeddings can come from the local server or the router.** The model picker lists both: what your
local server reports as an embedding model, and the router's embedding deployments (ten of them,
including `voyage/voyage-code-4`, which is trained for code). Picking one writes the endpoint, the
dimension count and, for a router model, the key — together, because a model with the wrong endpoint
or the wrong dimension count fails in ways that are hard to read. The router declares its vector
sizes, so nothing is measured; a local model is measured by asking it for one embedding, and is
refused rather than saved if it cannot answer.

One trap the panel now names outright: `embeddingProvider` must be `custom` for your endpoint to be
used at all. On anything else the indexer hunts for ollama, openai or google credentials and ignores
the endpoint, failing with *No embedding-capable provider found* while the panel shows a perfectly
reachable server. A `problem` row says so, and picking a model always sets the provider that uses it.

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

Retrieval was tuned by measurement: reranking is the only lever that moved it, and
`search.rerankTopN: 100` is the one default worth shipping. The whole table, including the several
settings that changed nothing, is in [docs/index-retrieval.md](docs/index-retrieval.md).

**The agent's own documentation** can be indexed too, from the same picker: *Index the agent's own
documentation*. pi ships its docs on disk in both layouts (`pi/docs` in a bundle,
`node_modules/@earendil-works/pi-coding-agent/docs` in a checkout), so questions about hooks,
settings and the extension API come from the index instead of grep. It is opt-in because it is about
2.7 MB of Markdown and a minute of local embedding. A bundle's path carries its version, so the entry
is re-pointed rather than left dangling after an upgrade: the panel shows a `stale kb` row for a
knowledge base that has vanished from disk, and the same action drops the old entry and adds the
current one.

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

Loading this package at all needs a pre-bundling step, for reasons in
[docs/architecture.md](docs/architecture.md). Indexing ~50 files takes about half a minute. Tuning lives in that config file: `indexing.autoIndex`
(off here, so indexing stays an explicit request), `indexing.watchFiles`, `search.maxResults`,
`search.minScore`, and `knowledgeBases` to index extra directories such as pi's own docs.

One trap: running an installed bundle from inside this checkout loads both copies of the extensions
and pi refuses the duplicate tools. Run the installed `mgm` anywhere else, or use `bin/mgm` here.

## Context window (`/context`)

What is actually in the window, measured from the request pi sends rather than guessed from the
transcript: the system prompt, every tool schema, your messages, replies, thinking, tool output and
images, with the free space and a one-line verdict. Tool output is usually the surprise.

```
█████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
61,500 of 128,000 tokens 48% used
■ system prompt      5,501   4.3%     ■ tool output       48,317    38%
■ tool schemas       4,716   3.7%     □ free              66,500
```

It also says what a compaction would reclaim and where the trigger sits, since mgm's compaction knows
what it would mask first. `/context off` hides the panel.

`/context export` writes a **self-contained HTML report** and opens it in your browser: one file with
inline SVG (a proportional bar and a donut), a legend, the largest tool schemas, and the Mermaid
source in a fold for pasting into a document. No scripts, no fonts, no network, so it still works
offline and can be mailed to someone. Reports go to `~/.mgm/reports` (`MGM_REPORT_DIR` to move them,
`MGM_NO_BROWSER=1` to write without opening).

The model can make pages too: the `html_report` tool takes a title and Markdown (plus optional bar or
donut data) and returns a path. Its schema costs 142 tokens on every request, against roughly 1,900
output tokens each time a model would otherwise hand-write a page, so it pays for itself in any
session that produces a report and is deliberately small. It writes only into the reports directory,
never opens a browser unless asked, and escapes everything, so file contents and model text cannot
introduce markup. Its description tells the model to use it only when you asked for something to look
at, because a tool for making web pages invites web pages nobody wanted.

The report builder is deliberately generic — `htmlReport`, `svgBar`, `svgDonut`, `legend`, `table`
from `.pi/extensions/mgm-context/report.ts` — so any extension can turn what it knows into a page you
can look at. Mermaid renders nowhere in a terminal; pi's own toolkit can display images in Kitty,
iTerm2, Ghostty, WezTerm and Warp, but rendering Mermaid to an image needs a headless browser, which
is not worth a few hundred megabytes for a picture a good text layout beats.

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

## Where the rest is

- [docs/architecture.md](docs/architecture.md) — how the connection, budget, compaction, banner, MCP
  and router pieces work, and the decisions behind them.
- [docs/index-retrieval.md](docs/index-retrieval.md) — what was measured when tuning codebase search,
  including the configurations that changed nothing.
- [docs/compaction-research.md](docs/compaction-research.md) — the reading behind the compaction design.
- [docs/summarizer-benchmark.md](docs/summarizer-benchmark.md) — why the default summariser is what it is.
- [docs/index-questions.json](docs/index-questions.json) — the retrieval question set, rerun with
  `node --import ./tests/resolve-pi.mjs scripts/index-eval.mjs`.
