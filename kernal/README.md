# kernal

The **kernal** coding agent: a project-local build of [pi](https://github.com/earendil-works/pi) 0.86.1
with a `/connect` command that switches between three backends:

| Backend | What | Models |
|---|---|---|
| `lmstudio` | Local LM Studio (MLX) on `localhost:1234` | discovered live (`qwen/qwen3.6-35b-a3b`, ...) |
| `litellm` | Cloud router `router.kernal.one` | discovered live, scoped to the agent key's team |
| `openrouter` | openrouter.ai | curated list you can add to (see *The OpenRouter list*), minus ids OpenRouter doesn't list |

Everything here is extensions and settings on top of pi; pi's own source is never modified. How the
pieces work inside, and why they are built that way, is in [docs/architecture.md](docs/architecture.md).

## Quick start for a new user

1. Install a release (see *Releases and installing without Node*), or clone and `npm install` here.
2. Run `kernal login` once on this machine (see *Sign in* below): you approve it in the web app,
   and this device gets its own router key, so no key needs pasting. Then run `kernal` from any
   project directory. Not signed in, or for a local model server, type `/setup`: it asks your
   name, a router key, your own OpenRouter key, and optionally a local model server (LM Studio: it
   lists the models the server offers and you pick one). It writes `.env` next to the install and
   connects immediately, no restart. The router is the default backend
   (`litellm/gpt-5.4-nano`, the cheapest capable route; `/connect` or `/model` for a stronger one); LM Studio is only preloaded at start when you have made it your
   default with `/connect` (or set `KERNAL_PRELOAD_LMS=1`).
3. `/connect` picks a backend and model at any time; `/model` is pi's own picker; `/budget` shows
   what a session costs on the router.

The banner shows your block letters: **MGM** for Matthew, **MATEK** for Matej (recognised from
`KERNAL_USER`, git email, GitHub login or OS user), initials for anyone else, with an entrance
animation for recognised users (`KERNAL_NO_ANIMATION=1` skips it).

## Sign in (`kernal login`)

```bash
kernal login                 # prints a URL and an XXXX-XXXX code; approve it at app.kernal.one/device
kernal whoami                # <email> on <api> (device <name>); --json for scripts
kernal logout                # signs this device out (also from the web app's Devices page)
```

One login per machine, kept in the OS keychain (`~/.kernal/auth` holds only an index). The login
brings this device's own router key, so router spend is tracked per person, and Kernal reads your
account's settings (web app → Account) at start-up; `/config` shows each value and where it came
from. `--profile <name>` picks one of your account's named profiles for that process.
`outfitter/docs/specs/central-auth.md` has the design.

**Moving off `.env` keys.** After signing in, `kernal login` offers, one key at a time, to upload
the personal keys in Kernal's `.env` (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`; not `DEEPGRAM_API_KEY`, which bundles ship as a shared voice key) to your account and then remove them from `.env`. It also
offers to remove a shared `LITELLM_AGENT_KEY` (once the device has its own key, which it would
otherwise override) and a leftover Dongle (`OUTFITTER_TOKEN`). Every answer defaults to no, nothing is asked
without a terminal, and the file is copied to `.env.bak-<time>` before the first change. Only
`~/localllm/.env` and the `.env` files next to the install are touched, never a project's own. Keys
left in `.env` keep working, with a deprecation warning.

**Keys exported by your shell.** A key variable in the shell's environment still wins over the
login: `LITELLM_AGENT_KEY` or `LITELLM_API_KEY` over this device's router key, and
`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `DEEPGRAM_API_KEY`
over your account's key for that provider. A long-lived terminal can still hold old keys after
`kernal login` removed them from `.env` (oh-my-zsh's `dotenv` plugin exports a `.env` when you `cd`
into its folder). Signed in, Kernal warns once per process when that happens, as a notice at start-up
or a stderr line without a UI: "LITELLM_AGENT_KEY from your shell overrides this device's own router
key (spend isn't attributed to you). Unset it, or open a new terminal." It warns only when the device
or account has a different key of its own; provider keys are checked once the account's keys arrive
(a moment after start). `/config` and `/admin` show such a value's source as `shell (<NAME>)`.
A value equal to one in a `.env` file Kernal reads counts as `.env`, not the shell (`bin/kernal`
exports those files, and they have their own deprecation warning); `bin/kernal` records which of
these variables the shell already had before it does (`KERNAL_SHELL_KEYS`).

**Dongles are retired.** `kernal login` is the only way to connect Kernal to Outfitter. Kernal no
longer reads `OUTFITTER_TOKEN`: one left in the environment or `.env` is ignored, with the one-line
notice "Dongles are retired; run kernal login". The web app no longer creates Dongles; existing ones
keep working for other clients until they expire or are revoked. A2A keys are unchanged.

### Centrally managed settings

Signed in, these come from your account (web app → Account, or `/admin` → Settings) and Kernal
applies them: `model.provider`, `model.default`, `model.thinking`, `compaction.summaryModel`,
`compaction.masking`, `memory.mode`, `voice.enabled`, `voice.language`. For each, the first of
these that sets it wins:

1. **this machine**: `~/.kernal/config.local.json` ("Only this machine" in `/connect` or `/admin`);
2. **your account**: the device, then the profile (`--profile`), then the account itself;
3. **what this machine set before**, shown as "(legacy)" in `/config`: `settings.json`'s
   `defaultProvider`/`defaultModel`/`defaultThinkingLevel` (only when they differ from what the
   release shipped, or in a source checkout from the committed `settings.json`),
   `kernal.compaction`, `kernal.memory`, pi-listen's `voice` settings (not the values Kernal wrote
   there itself: its voice seed, or a copy of the account's value) and `KERNAL_SUMMARY_MODEL`;
4. the fleet's value, then the default.

So a change on your account reaches a laptop that once ran `/connect`, while an explicit "only this
machine" choice still wins there. When a change takes effect:

- **compaction**: at once (start-up refresh, `/config reload`, an `/admin` save);
- **model and thinking**: at the next session (`/new` or the next start). A new, empty session
  switches once to that default at start; a running conversation never switches model, and
  `--model`/`--models`/`--provider`/`--thinking` on the command line still win;
- **voice**: written into pi-listen's settings, which it reads at the next session;
- **memory**: at the next start (`bin/kernal` reads the resolved value from
  `~/.kernal/config-cache/effective[.<profile>].json` before pi starts).

Signed in, `/connect` and the `/admin` Model page ask where a new default goes: "Save to my account
(profile X)" or "Only this machine" (both also update `settings.json`, pi's own default). Signed
out, or without a terminal, nothing changes: the choice goes to `settings.json` as before. In a
Drive the owner's settings arrive with the run (`KERNAL_RUN_SETTINGS`) and rank below the tape's
own choices.

A default set inside pi itself, Ctrl+S in the model picker ("set as default") or the default
thinking level, also goes to your account when you are signed in: the active profile, else the
account itself, so new sessions on every machine start with it. Kernal sees pi write it to
`settings.json` and saves it with the same versioned request as `/admin` (a conflict is retried
once). If this machine had pinned that key ("Only this machine"), the pin is removed so the new
default applies here too, and the notice says so. Choosing a model for this session only (Enter,
cycling) never touches the account. Signed out or in a Drive it stays in `settings.json`; if the
save fails (offline, expired sign-in), a notice says it was kept on this machine.

## Run (from any repo)

```bash
npm install                                   # once, in this folder
alias kernal=~/localllm/kernal/bin/kernal              # put in ~/.zshrc
cd ~/code/some-repo && kernal                    # interactive
kernal -p "explain this repo"                    # non-interactive
```

`bin/kernal` sets `PI_CODING_AGENT_DIR` to this folder's `.pi/`, so extensions, packages, settings and
sessions all live here instead of `~/.pi/agent` (which is left untouched), and it exports the
secrets from `~/localllm/.env` for packages that use `${VAR}`.

Inside pi:

```
/connect                         pick backend, then model
/connect litellm                 pick a model on the router
/connect lmstudio qwen/qwen3.6-35b-a3b
/connect openrouter              ... ends with "Browse all OpenRouter models…"
/model                           pi's own picker also lists all three providers
```

**The OpenRouter list.** Kernal ships a short curated list of OpenRouter models. You can add or
remove models on it:
- in `/connect openrouter`, choose *Browse all OpenRouter models…*, search OpenRouter's whole
  catalogue and pick a model. Kernal offers to add it to your account's list (every Kernal you
  sign in to) or to this machine's, then switches to it.
- on `/admin` → Model, each listed OpenRouter model has a × to remove it, and an *Add* box takes
  any id from the catalogue. Changes are saved to your account or to this machine.

The lists are central settings (`openrouter.models.*`; `/config` shows them).
- The fleet can add models for everyone or hide them; a hidden model can't be added back.
- Your account's changes and this machine's changes add up. Where they disagree, the nearer one
  wins: a profile over your user list, this machine over both.
- Ids are checked against OpenRouter's catalogue. A listed model OpenRouter later drops shows on
  `/admin` under *Not on OpenRouter*, where you can remove it.
- `OPENROUTER_MODELS` in `.env` still replaces the whole list, but the fleet's hidden models stay hidden.

Model can also be given on the CLI: `pi --model litellm/claude-sonnet-5:high`.
The choice is saved to `.pi/settings.json` (`defaultProvider` / `defaultModel`) and reused next start.

Non-interactive: `npx pi -a -p --model lmstudio/qwen/qwen3.6-35b-a3b "prompt"` (`-a` trusts project files).

## Secrets

Signed in with `kernal login`, the router key is this device's own (from the keychain) and your
personal provider keys come from your account, so `.env` needs none of them; keys still in `.env`
win over the account's, with a deprecation warning. Otherwise `/setup` writes them; or edit by hand
(`.env.example` documents every key). Read from `~/localllm/.env` (a source checkout), then the
`.env` next to the agent dir (a release bundle):

- `LITELLM_AGENT_KEY` — a hand-issued LiteLLM virtual key (its team decides which models and MCP servers appear), for a machine that is not signed in. Falls back to `LITELLM_API_KEY` if unset. Shared keys are being retired: their spend has no owner.
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
runs `.github/workflows/release.yml`: validate the tag, run the tests, then build on three runners
(darwin-arm64, linux-x64, linux-arm64) and attach `kernal-<version>-<platform>.tar.gz`
with a `.sha256` and `install.sh`. Every push to `main` touching `kernal/` runs `ci.yml` (tests plus
an offline start of the agent).

A bundle is **pi's official standalone binary** (a Bun-compiled executable, checksum-verified
against pi's release) for the pi version pinned in `package.json`, plus this repo's `.pi/`
extensions, settings and MCP config, the extension packages installed from `.pi/npm`'s lockfile
with other platforms' native binaries removed, the launcher, docs and `.env.example`. Users need
no Node. We never modify pi; everything kernal adds is extensions, so upgrading pi is a version bump.

```bash
# release (maintainer)
gh release create v0.2.0 --title "kernal 0.2.0" --notes "..."          # → CI builds and attaches bundles
scripts/package.sh 0.2.0 darwin-arm64                               # the same build, locally → dist/

# install (user)
# while the repo is private, download through a logged-in gh (the curl form needs a public repo):
gh release download --repo cognitio-org/mgm-pi --pattern install.sh --dir /tmp --clobber && bash /tmp/install.sh
cp ~/.kernal/current/.env.example ~/.kernal/current/.env   # add keys; kept across upgrades
kernal
```

**State that is yours, not a version's.** A bundle lives in `~/.kernal/kernal-<version>-<platform>`, so
`PI_CODING_AGENT_DIR` moves on every upgrade. Session history, credentials, trust decisions and caches
therefore live in `~/.kernal/state` and are symlinked into the bundle, which is what makes
`kernal --session <id>` keep working after an upgrade: pi only searches the current agent dir, so before
this they looked deleted. Your own subagents (`.pi/agents`) live there too. The installer gathers state
left inside older bundles once. `KERNAL_STATE` moves the directory.

**Settings survive an upgrade.** `settings.json` is both the release's defaults and where your choices
are saved (default model, subagent models, `/settings`, installed packages), so it is neither linked
nor copied forward whole. Each bundle ships a pristine `settings.shipped.json`; on upgrade the installer
compares your `settings.json` with the old one to find what *you* changed, and applies only that over
the new release's settings. A default model you chose stays chosen; a default the release changed and
you never touched arrives. Your previous file is kept as `~/.kernal/state/settings.previous.json`.

### Staying up to date

An installed bundle checks GitHub for a newer release once a day (extension `kernal-update`, cached in
`~/.kernal/.update-check.json`, via the `gh` CLI or `GH_TOKEN`). When one exists the start-up notice
and the status bar say so, e.g. `⬆ 0.1.5 available · /update`. Then either

- inside the agent: `/update` (or `/update check` to just look), then restart kernal; or
- from a shell: `kernal update` (`kernal update 0.1.5` for a specific version), `kernal version` to see what
  is installed.

Both run the release installer: the new bundle lands next to the old one under `~/.kernal`, `current`
moves to it, and the `.env` with your keys is carried over. Source checkouts are never nagged;
`git pull` is the update there. `KERNAL_NO_UPDATE_CHECK=1` disables the automatic check.

**Old versions are removed.** Each release is its own ~450 MB directory. Once an upgrade has
succeeded, the installer keeps the new version and the one it replaced (so you can go back one step:
`ln -sfn ~/.kernal/kernal-<old>-<platform> ~/.kernal/current`) and removes older ones.
`KERNAL_KEEP_VERSIONS=3` keeps more. Only directories named exactly `kernal-<version>-<platform>` are
ever removed, never `state/`, `.env` or anything else; versions are ordered by semver (0.1.10 is
newer than 0.1.9); and if anything under `~/.kernal` looks unexpected (a stray `kernal-*` name, a
symlink, a `current` that does not resolve) nothing is removed and the installer says why. To
reclaim space without upgrading: `kernal prune` (`--dry-run` to see what would go first).

**The pre-rename `~/.mgm`.** The 0.2.0 migration copied everything to `~/.kernal` and left `~/.mgm`
alone, with its old release bundles (often several GB). Nothing removes it automatically: its bundles
hold old sessions and keys. `kernal prune --legacy` lists exactly which bundles it would delete, and
what each holds, and deletes nothing; `kernal prune --legacy --yes` deletes those bundles only
(`state/`, `MOVED`, `current` and anything else stay). Either way it refuses unless the migration
ran and every session file in `~/.mgm` is byte-identical in `~/.kernal/state/sessions`, and it names
any that are not.

**Extension packages** are a separate thing from the bundle. pi notices when one of the installed
packages has a new version and says so at start-up; update them with `/update extensions` in the
agent, or `kernal update --extensions` (also `--extension <name>` for one, `--models` to refresh pi's
model catalogs). `kernal update` with no flag is the bundle; `--all` and `--self` are refused so the
two never get confused.

In a release bundle a package update lives in that bundle only, and the next `kernal update` restores
the versions the release pinned. The durable path is this repo: run `kernal update --extensions` in a
checkout, commit the changed `.pi/npm/package.json` and `package-lock.json`, and the next release
ships them. pi's updater rewrites the lockfile from the installed tree, which drops entries nothing
needs (it no longer records pi's own dependency tree); `npm ci` for all four release targets still
resolves, and `scripts/package.sh` smoke-tests the result.


**Nothing in an installed release asks you to run pi's own updater.** A release pins pi and every
extension package to the versions its release gate tested: pi's version comes from the bundle, and
each package is listed as `npm:<name>@<exact version>`. pi skips pinned packages in its startup
*Package Updates Available* notice and in `pi update --extensions`, and the launcher sets
`PI_SKIP_VERSION_CHECK=1` in a bundle, so pi's *New version available, run pi update* notice goes too.
Both were wrong advice there: `pi` is not the command you run, and the bundle would ignore it anyway.
In an installed release, pi and the packages update with Kernal itself, through `/update` or
`kernal update`; `kernal update --extensions` says so rather than silently doing nothing.

A source checkout keeps both notices, because there they are a maintainer's signal that a newer pi or
package is out. `kernal update --extensions` there updates `.pi/npm` and its lockfile, which the next
release then ships pinned. Dependabot (`.github/dependabot.yml`) opens weekly pull requests for pi
and for the packages, so new versions arrive through CI and the live gate rather than as a notice.
## Codebase search (`open-codebase-index`)

Semantic and keyword retrieval over the repo you are in. It is all model-facing: the package
registers tools, not slash commands, so you ask for it in words ("index this repo", "search the
codebase for where X happens") and the agent calls `index_codebase`, `index_status`,
`codebase_context`, `codebase_peek`, `codebase_search`, `implementation_lookup`, `find_similar`,
`call_graph`, `call_graph_path` or `pr_impact`. The package's `codebase-search` skill, which tells
the model to reach for those before grepping, is copied into `.pi/skills/` by `scripts/prebundle.sh`
(pi installs a package's skills only for packages it manages, and this one is loaded by
`.pi/extensions/kernal-codebase-index`).

**While a run is going you can see it.** Indexing a large repository takes minutes, and the package
reports progress only when asked, so a run the model started used to look like nothing happening.
The status bar now ticks `⌕ embedding 27% · 128/478 files` and the panel shows a bar, whether the run
came from the picker or from the model calling the tool itself. The indexer's own percentage is per
batch and jumps backwards, so the bar is driven by the file count, which only goes up.

`/index` is kernal's own panel over it: the chunk count and branch, where the store is, the embedding
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
prose. Adding `kernal/.pi/extensions` as a knowledge base (the only supported route into a
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
and never leaves the machine: `.pi/extensions/kernal-codebase-index` writes
`~/.config/codebase-index/config.json` on first run, pointing at `LMSTUDIO_BASE_URL` with
`text-embedding-nomic-embed-text-v1.5`. A project's own `.codebase-index/config.json` still wins,
and a config you have edited is never overwritten. `KERNAL_NO_CODEBASE_INDEX=1` turns it off.

Loading this package at all needs a pre-bundling step, for reasons in
[docs/architecture.md](docs/architecture.md). Indexing ~50 files takes about half a minute. Tuning lives in that config file: `indexing.autoIndex`
(off here, so indexing stays an explicit request), `indexing.watchFiles`, `search.maxResults`,
`search.minScore`, and `knowledgeBases` to index extra directories such as pi's own docs.

One trap: running an installed bundle from inside this checkout loads both copies of the extensions
and pi refuses the duplicate tools. Run the installed `kernal` anywhere else, or use `bin/kernal` here.

## Web admin (`/admin`)

`/admin` opens a local web page for the things that are awkward in a terminal: what the agent is
running, the connections and keys, the model, the codebase index settings and the subagent models.
It is served by the running agent itself, so it sees exactly what the session sees, and it goes away
with it.

- **Overview**: the model and provider in use, thinking level, how full the context window is, index
  state, whether each backend is reachable, and the kernal and pi versions.
- **Connections**: router URL and key, OpenRouter key, local server URL and default local model, your
  name. Keys are only ever shown as `set (…1234)`; *Replace* takes a new one, *Remove* deletes it.
  *Test connection* tries the values in the form before you save them and reports reachable,
  unreachable or the provider's own refusal (`401: User not found.`). Saving writes the same `.env`
  `/setup` writes and re-registers the providers at once, no restart (your name reaches the banner at
  the next start).
- **Model**: every model the connected backends offer, filterable. Picking one switches the session
  and saves it as the default, like `/connect`.
- **Codebase index**: status with *Update* and *Rebuild*, and every setting the `/index` dialog edits,
  with the same validation: the embedding model picker over the local server and the router (picking
  one sets endpoint, model, dimensions and, for the router, the key together), *Measure* for the
  dimension count, search and indexing settings, and reranking on or off with a model from the
  router. It says when a change needs a rebuild, and that the indexer reads its settings at start, so
  saved changes reach search after a restart. When the repository has its own
  `.codebase-index/config.json`, the fields it overrides say so.
- **Subagents**: every agent pi-subagents finds, with its source (builtin, package, user, project)
  and the model it resolves to; the default subagent model and per-agent model and thinking overrides,
  picked from the live model list. Builtin and package agents are read-only; **Customise** makes an
  editable same-name copy that wins over them. User and project agents can be created, edited and
  deleted in an editor that keeps the file Markdown: the frontmatter as form fields (tools as a
  multi-select of real tool names), the prompt in a monospace editor with a toolbar, shortcuts, a live
  preview and a token estimate. Every write goes through pi-subagents' own handlers, and afterwards
  the package re-discovers the agent; if what it resolves differs from what was saved, the change is
  rolled back and the reason shown.
- **GitHub**: the GitHub CLI kernal uses and where it came from, the account it is signed in as with
  the token's scopes, whether `git push` over https uses that login, and this repository with its
  branch and pull request. An Install button fetches `gh`; the sign-in and `setup-git` commands are
  shown with a copy button, because kernal cannot answer gh's questions for you. The commit trailer
  and pull request footer are edited here.
- **Command-line agents**: the agents that run Claude Code, Codex or Cursor. One tile per tool,
  installed or not (with the install command when it is not), and which of its agents are read-only
  and which write files. Those agents are labelled with the tool's own model, and a model or
  thinking override for one is refused, because the tool never receives it.

`/admin index` (or `connections`, `model`, `subagents`, `github`) opens straight at that page, `/admin status`
says where it is, `/admin stop` stops it.

**Security.** The server listens on 127.0.0.1 only, on a port the system picks, and makes a new
random token each time it starts. The token travels in the URL's `#fragment`, which browsers never
send to a server, and the page sends it back in a header on every API call; a request without it is
refused, as is any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS
rebinding) or whose `Origin` is another site. Writes must be JSON, which a cross-site form cannot
send. Keys go into the page masked and never come back out; a response that would carry one in full
is withheld. The server stops when kernal exits, on `/admin stop`, and after 15 minutes without use
(`KERNAL_ADMIN_IDLE_MINUTES`; an open tab's background refresh does not count as use).
`KERNAL_NO_BROWSER=1` prints the link instead of opening it.

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

It also says what a compaction would reclaim and where the trigger sits, since kernal's compaction knows
what it would mask first. `/context off` hides the panel.

`/context export` writes a **self-contained HTML report** and opens it in your browser: one file with
inline SVG (a proportional bar and a donut), a legend, the largest tool schemas, and the Mermaid
source in a fold for pasting into a document. No scripts, no fonts, no network, so it still works
offline and can be mailed to someone. Reports go to `~/.kernal/reports` (`KERNAL_REPORT_DIR` to move them,
`KERNAL_NO_BROWSER=1` to write without opening).

The model can make pages too: the `html_report` tool takes a title and Markdown (plus optional bar or
donut data) and returns a path. Its schema costs 142 tokens on every request, against roughly 1,900
output tokens each time a model would otherwise hand-write a page, so it pays for itself in any
session that produces a report and is deliberately small. It writes only into the reports directory,
never opens a browser unless asked, and escapes everything, so file contents and model text cannot
introduce markup. Its description tells the model to use it only when you asked for something to look
at, because a tool for making web pages invites web pages nobody wanted.

The report builder is deliberately generic — `htmlReport`, `svgBar`, `svgDonut`, `legend`, `table`
from `.pi/extensions/kernal-context/report.ts` — so any extension can turn what it knows into a page you
can look at. Mermaid renders nowhere in a terminal; pi's own toolkit can display images in Kitty,
iTerm2, Ghostty, WezTerm and Warp, but rendering Mermaid to an image needs a headless browser, which
is not worth a few hundred megabytes for a picture a good text layout beats.

## Git and GitHub (`kernal-github`)

The agent gets one `git` tool, and you get three commands. The design, including the cloud and
teleport halves still to come, is `docs/git-github-spec.md`; this is phase 1 of it.

**`/github setup`** does the whole setup: it finds the GitHub CLI, installs it if it is missing, and
tells you how to sign in.

| Step | What happens |
|---|---|
| Find `gh` | `PATH` first, so your own install wins, then kernal's own copy |
| Install it | The official release for this platform, checked against its published `gh_<version>_checksums.txt`, unpacked into `~/.kernal/bin` (a checkout: the git-ignored `.pi/bin`). No admin rights, no Homebrew, nothing bundled in releases |
| Sign in | `gh auth login --web --git-protocol https --scopes workflow`, which you paste into a terminal: `gh`'s login is an interactive prompt and pi cannot hand the terminal to a child process. `GH_TOKEN` or `GITHUB_TOKEN` works instead |
| Connect git | `gh auth setup-git`, shown before it runs, because it writes a credential helper for github.com into your global git config |

`/github` on its own reports the account, the token's scopes, whether git uses that login, this
repository, and the commit attribution. Both people use their own GitHub account; nothing is issued
centrally. github.com over https only: SSH remotes and GitHub Enterprise are out of scope.

**`/git`** is the one answer to "where am I?": branch and remote, what is ahead or behind, what
changed, the last commit, and this branch's pull request with its review state, unresolved threads
and checks. **`/commit [message]`** commits: with a message it commits everything that changed; with
no message it asks the agent to read the diff, stage what belongs together and write the message.

The **`git` tool** gives the model the same thing in one call (`status`), plus `diff`, `log`,
`commit`, `push`, `pull`, `branch` and `stash`. It exists because the shell version of those is five
commands and a guess at the output. What it guarantees:

- a commit message goes in on stdin, so quotes, newlines and a leading dash survive intact;
- staging is by name; `all: true` is a deliberate choice, not the default;
- hooks are never skipped, and a hook that refuses a commit comes back with its output and the
  advice to make a new commit rather than amend one that never happened;
- a push sends the exact commit that was just read, as `<sha>:refs/heads/<branch>`, and sets the
  upstream itself on a first push (git silently declines to do that for a commit id);
- a push is never forced: `forceWithLease` is a separate choice and still refuses if someone else
  pushed;
- a rejected push and a conflicted pull come back as what happened and what to do next, never as a
  half-finished state.

The model also follows a short rule block: commit and push only when asked, never rewrite published
history, never change git config, stage by name, never commit secrets, never revert work it did not
do. The shell still works; the tool is the easier path, not a fence.

**Attribution** is on by default: a `Co-Authored-By: Kernal <noreply@kernal.invalid>` trailer on
commits, and "Opened with Kernal" on pull requests. Set `github.attribution.commit` or
`github.attribution.pr` in `settings.json` to change the text, or to an empty string to turn it off.
The address is a reserved `.invalid` domain: a `users.noreply.github.com` one would credit whichever
GitHub account owns that name. In an Outfitter cloud run the commit is the Outfitter bot's, and the
session's person is credited with `Co-authored-by` and `On-behalf-of` trailers.

## Background jobs (`kernal-background`)

pi's `bash` tool holds the turn until a command exits. For a dev server, a watcher, a long test run or
a pass over a big file, the agent uses the `background` tool instead: `run` starts the command and
returns at once with an id (`bg1`, `bg2`, ...), `list` shows the session's jobs, `logs` reads the end
of one's output, and `kill` stops it. When a job ends (it exits, fails, hits its deadline or is
stopped) the agent gets one message with the status and the last lines of output, so it never has to
poll. You can see and stop them yourself with `/jobs` and `/jobs kill bg1`; the footer shows how many
are running.

- **server** jobs run until stopped, the session ends, or a hard cap (`KERNAL_BG_SERVER_MAX_HOURS`,
  default 12). **batch** jobs have a deadline (default 30 minutes, at most 24 hours).
- Each job runs in its own process group. Stopping it stops everything it started; anything it left
  running when its command exited is stopped and reported; and every job is stopped when the session
  ends or pi exits, even if pi is killed (a watchdog in the job's group notices within seconds).
  A process that detaches itself (`setsid`, a double fork) leaves the group and can't be followed.
- Output (stdout and stderr, in order) goes to a private log under the system temp directory, capped
  at 10 MB per job. stdin stays open and empty, so a command that prompts waits: give it its
  non-interactive flag.
- Background jobs need an interactive or RPC session; `kernal -p` refuses them, because a print run's
  jobs would stop the moment it ends.
- A job runs as you, with your credentials. It is not a sandbox.
- On a Drive (Outfitter) the same tool works, but a job doesn't keep the Drive awake and dies with the
  sandbox.

**Previews.** When a server should be seen, the agent starts it with its `port` and then calls
`preview` with the job id. On the desktop that is just `http://localhost:<port>`. In a Drive it is a
private `https://<id>.kernal.run` link that only people with access to the session can open (Google
sign-in); agentd runs the tunnel and the Outfitter api issues the link
(`outfitter/docs/specs/drive-previews.md`). A public share link, which expires, is the person's to
make from the session page, never the agent's. A preview closes when its job ends,
and the end-of-job message says so.

**VS Code.** In a Drive whose Tape has "VS Code in the browser", ask the agent to open VS Code and it
calls `vscode`: about half a minute later the floppy's owner gets an **Open VS Code** chip in the
chat (only they and sysops can open it). The agent never sees the link
(`outfitter/docs/specs/browser-ide.md`). On the desktop there's no such tool: you already have
your editor.

## Subagents (`pi-subagents`)

Delegation to focused child sessions, which the model uses when your wording invites it: "use
reviewer on this diff", "ask oracle whether this plan is wrong", "run reviewers for correctness,
tests and cleanup in parallel". Nothing runs on its own. Built-in roles are `scout` (recon),
`researcher`, `evidence-auditor`, `worker` (implements), `reviewer`, `oracle` (second opinion, never
edits) and `delegate`. `/subagents-fleet` shows running work, `/subagents-doctor` checks the setup,
`/subagents-guide <topic>` is the installed documentation.

Children would inherit the chat model, the cheapest route on the router, so `.pi/settings.json` sets
their models, by what each role is for:

| role | model | why |
|---|---|---|
| scout, researcher, delegate, evidence-auditor | `litellm/gemini-3.8-flash` | fast, cheap, 1M context for reading a lot |
| worker, reviewer | `litellm/claude-sonnet-5` | writing and judging code |
| oracle | `litellm/claude-opus-5-high` | rare, and its whole value is judgement |

Agents are Markdown with YAML frontmatter (`name`, `description`, `tools`, `model`, `thinking`,
…), the same format as Claude Code's, but found in `.pi/agents/` (project) and
`$PI_CODING_AGENT_DIR/agents/` (user: `~/.kernal/state/agents` for an install, the git-ignored
`kernal/.pi/agents` in a checkout) rather than `.claude/agents/`; `/admin subagents` edits them; `subagents.agentScanDirs` can add that directory as an extra
root. A model set in settings under `subagents.agentOverrides.<name>.model` beats the agent file's
frontmatter, which beats `subagents.defaultModel`, which beats the chat model. Foreground children
do not load the parent's extensions, so a `researcher` needs web access granted to it explicitly.

### Command-line agents: Claude Code, Codex and Cursor as subagents

Six builtin agents do not run a model through Kernal at all. They hand the task, with the agent's
prompt, to another coding tool installed on this machine and bring its answer back:

| agent | runs | may change files |
|---|---|---|
| `claude-code`, `claude-code-writer` | Claude Code (`claude`) | only the `-writer` one |
| `codex-exec`, `codex-exec-writer` | Codex (`codex`) | only the `-writer` one |
| `cursor-agent`, `cursor-agent-writer` | Cursor (`cursor-agent`) | only the `-writer` one |

Ask for one by name: "ask claude-code to review this diff", "have codex-exec-writer fix the failing
test". The tool uses its own login, its own model and the tools its adapter allows, so Kernal's
subagent models do not apply; sign in to the tool once in a terminal first. The runs are
asynchronous: the agent starts one and checks on it. pi-subagents prints the router model next to
these agents anyway, so the `kernal-subagents` extension corrects the `subagent` tool's list and
detail output to say whose model runs them, and `/admin subagents` shows them in their own section.

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

`bin/kernal` points `PI_AGENT_DIR` (pi-lsp's own variable, not pi's) at this folder's `.pi/agent/`,
which is what makes that file pi-lsp's user-owned, auto-trusted config in whatever repo you run kernal.
A *project-local* `.pi/lsp.json` is a different thing: pi-lsp asks to trust it once per content hash
and refuses it outright in `-p` mode. Use one in a repo to override an entry by `id`
(`{"version": 1, "servers": [{"id": "python", "enabled": false}]}` switches one off there). The
config sits one level below `.pi/` precisely so that running kernal inside this folder does not find
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

Voice comes from **pi-listen**, vendored in this repo at `.pi/npm/vendor/pi-listen` as Kernal's own
fork of 7.2.2 (MIT). Upstream has been unmaintained since May 2026, so fixes land here;
`VENDORED.md` there lists what's changed (#250).

**Hold Space** for a moment and talk; let go to transcribe into the prompt (a quick tap still types
a space). Or press **ctrl+shift+v** to start and again to stop; that shortcut needs a terminal that
reports ctrl+shift+letter, through the Kitty keyboard protocol or modifyOtherKeys (Ghostty, Kitty,
WezTerm, iTerm2 with CSI u turned on). In Terminal.app it arrives as plain ctrl+v, so use Space
there. **Esc** cancels a recording and puts back what you'd typed. `/voice-settings` changes the
backend, model and language, and `/voice-help` (F1) lists the keys.

Release bundles ship a shared `DEEPGRAM_API_KEY` in their `.env` (from the `DEEPGRAM_API_KEY` repo
secret; locally from `~/localllm/.env`), so pi-listen streams live transcription through Deepgram
out of the box. Without a key, pi-listen would default to Deepgram anyway and sit unconfigured,
reading `~/.pi/agent/settings.json`; `.pi/extensions/kernal-voice/` therefore seeds a fully local
setup there the first time kernal starts, if nothing is configured yet: backend `local`, model
`parakeet-v3` (pi-listen's recommended offline model, ~670 MB, downloaded on first use with a
progress bar), language from your locale. That seed only stands in for a key: once a Deepgram key
is available, kernal takes its own seed back out and says so, and voice streams live; if the key
goes away again (a checkout with no `.env`), the seed goes back rather than leaving a keyless
Deepgram. kernal tracks this in `~/.pi/agent/kernal-voice-seed.json`; a seed from before that file
counts as kernal's only if pi-listen completed its setup on its own and the model was never
downloaded. It never overrides a choice of yours: another backend or model, a Deepgram setup, or
voice turned off. (Settings can't tell a deliberate re-pick of the very same local model from the
seed; re-pick another model, or set `KERNAL_VOICE=off`, to keep a local setup with a key around.) `KERNAL_VOICE_MODEL` picks another
default model, `KERNAL_VOICE=off` leaves pi-listen's settings alone. Audio capture needs SoX
(`brew install sox`) or ffmpeg; kernal and the installer say so when neither is found.

## Share local models (`kernal local`)

`kernal local enable` installs a background service (a LaunchAgent on macOS, a systemd user unit
on Linux) that shares this machine's model server (LM Studio, Ollama, llama.cpp, mlx-lm, vLLM) with
your Outfitter account through a tunnel, so cloud runs can use those models as
`local/<you>-<machine>/<model>`. It needs `kernal login` and the `localHost.shareModels` setting
turned on; `enable` prints that setting and where to change it. `kernal local status` shows the
tunnel, models and last heartbeat; `kernal local disable` removes the service. `tunnel.sh` and
`keepalive.mjs` are gone. `litellm/local-qwen-mlx` remains an alias for the old single model.
Details: [docs/local-host.md](docs/local-host.md).

## Reporting problems (`/report`)

pi's own `/bug` uploads to the pi developers and is handled by the TUI before extensions see it,
so kernal adds `/report [description]` (extension `kernal-report`). It collects what pi's report has
(kernal and pi versions, OS, model, packages and extensions, the last provider error, recorded
crashes), asks whether to include a transcript tail (last 40 messages, tool output clipped), redacts
API keys and secret-looking tokens, writes a local copy under `.pi/bug-reports/`, and files a
GitHub issue in `cognitio-org/mgm-pi` assigned to Matthew via the `gh` CLI (collaborators only).
After a failed model turn the agent points at `/report` once. `KERNAL_REPORT_REPO` /
`KERNAL_REPORT_ASSIGNEE` override the target; if `gh` is not logged in the report stays local and the
notice says where it is.

### Error reports to Sentry (`/sentry`)

Off unless Outfitter turns it on. An Outfitter operator switches Sentry on or off for every machine
at once, under Settings → Telemetry in the web app, and sets the DSN and trace sample rate there too.
Kernal reads that setting with your login (`kernal login`). Signed out, nothing is sent. A change reaches the laptop by its next start, or during a session once the
background check finishes. When on, Kernal sends failed agent runs, uncaught crashes in `-p` mode,
and a sample of agent-run and tool timings. Tool timings carry the tool name only, never its
arguments or output, unless the fleet turns on prompts and outputs (below). Every event leaves without your hostname, and with your home directory written
as `~`.

`/sentry` shows whether it is on and who decided. `/sentry off` stops it on this laptop
(`telemetry.sentry.enabled: false` in `~/.kernal/config.local.json`, the same place `/admin`'s
"Only this machine" saves, so either one undoes the other) and stops Kernal asking Outfitter at all.
`/sentry on` returns to Outfitter's setting; it cannot turn Sentry on if Outfitter has it off. An
older `kernal.sentry: false` in settings.json still counts as off, and `/sentry on` (or clearing it
in `/admin`) removes it too. Details: `docs/reports/sentry-integration-plan.md`.

Three more signals (#424), each off unless an operator turns it on for the fleet
(`telemetry.sentry.*` in the central settings, shown by `/config`), and all off whenever Sentry
itself is off:

- **Agent monitoring** (`agentTraces`): the run, each model call and each tool call become Sentry's AI
  agent spans (`gen_ai.invoke_agent`, `gen_ai.chat`, `gen_ai.execute_tool`) in place of the plain
  timings, with the model, provider, input/output/cached tokens, cost (when pi has a price for the
  model), finish reason, time to first chunk, and each tool's name and outcome.
- **Prompts and outputs** (`agentContent`, needs agent monitoring): the prompt, the conversation sent
  with each model call, the model's replies, and tool arguments and results, on those spans. Every
  field is redacted first (`_shared/redact.ts`: Outfitter Dongles and device tokens, provider keys,
  `KEY=value` pairs and similar), then cut to 8 KB, and one run records at most 256 KB. The system
  prompt is never recorded.
- **Metrics** (`metrics`): counters for agent runs, tool calls (by tool), model calls (by model),
  input and output tokens, spend and errors, sent without your hostname.

`/sentry agent off`, `/sentry content off` and `/sentry metrics off` turn one off on this laptop
(`telemetry.sentry.agentTraces`, `agentContent` or `metrics: false` in `~/.kernal/config.local.json`,
again shared with `/admin`); `… on` follows Outfitter again. A local `on` never turns a signal on:
only the fleet does. The fleet's `telemetry.sentry.logs` and
`telemetry.sentry.profilesSampleRate` never apply to Kernal: a laptop sends no logs, and pi's
Bun-compiled binary can't load Sentry's native profiler. No request Kernal makes, LLM calls
included, carries Sentry trace headers.

## Teleport

Move a pi session between machines, the way Claude Code's teleport does: push it from one checkout,
pull it into another. `.pi/extensions/teleport/lib.ts` defines a small `Store` interface
(`list`/`get`/`put`) and a `GitStore` implementation on top of it. `.pi/extensions/teleport/
outfitter-store.ts` implements the same interface against the Outfitter cloud API instead;
`store-factory.ts` picks between them (see "Outfitter store" below), and `index.ts` (the pi extension,
which also serves `kernal --teleport`) doesn't know which one it's talking to.

**What gets pushed.** `/teleport push` sends the *entire* session transcript -- every prompt, tool
call and tool result, which can include file contents, command output and anything pasted into the
chat -- to `KERNAL_TELEPORT_STORE`'s git remote, unencrypted and with no secret-pattern scan beforehand.
Make sure that remote is a **private**, access-controlled repo before you set it up; treat anything
teleported there the same as you would a checked-in secret.

```
/teleport                 interactive picker: pick a pushed session, then pull it
/teleport list            list sessions in the store
/teleport push [name]     push the current session
/teleport pull [id]       pull a session by id (prompts to pick one if omitted)
kernal --teleport <id>    pull + launch, from any shell (see below)
```

### Store layout

`GitStore` is a local clone directory — `KERNAL_TELEPORT_STORE`, default `~/.kernal-sessions` — that is
itself a git repo (`git remote add origin <your-private-repo>` once; it works local-only, with a
warning, if there's no remote or it's unreachable):

```
~/.kernal-sessions/
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

- **Clean tree.** `pull` refuses (`commit or stash first`) if `git status --porcelain` is non-empty.
  `push` from the TUI offers to commit those changes through the shared git module and then push the
  branch. Declining leaves the tree alone. A headless push, and `teleport.autoPush`, still refuse
  without asking.
- **Same repo.** If the manifest has a `repo` (i.e. the source checkout had a git remote), `pull`
  compares its `ownerRepo` (parsed from `https://…`, `git@host:owner/repo.git`, and `ssh://` remotes)
  against the current checkout's `origin`. A mismatch refuses and names both repos.
- **Branch pushed.** `push` runs `git push -u origin <branch>` first when the branch has no upstream
  or is ahead of it, so the commit the session was working from is actually reachable. `pull` does
  `git fetch origin <branch> && git checkout <branch>` before importing.
- The session id is preserved across the hop (`SessionManager.forkFrom(tmpFile, cwd, undefined, {
  id })`); if a session with that id already exists locally, the interactive `/teleport pull` asks
  whether to overwrite it or fork under a new id; without a UI (`kernal --teleport <id> -p ...`) it
  always forks under a new id (the non-destructive default with no one there to ask).

### Model remap

Sessions record which provider/model they were using. `pickModelForHost` looks at the last
`model_change` on the imported session: if that provider is available on this host (has configured
auth), it's kept; otherwise the session falls back to `litellm/local-qwen-mlx` (the legacy alias;
shared models are `local/<you>-<machine>/<model>`). `/teleport pull` notifies which model it picked.

### What doesn't travel

Same caveats as any cross-machine handoff: environment secrets (`~/localllm/.env`, `LITELLM_AGENT_KEY`,
etc. — each machine needs its own), MCP OAuth tokens sitting in the macOS keychain (`/mcp-auth
<server>` again on the new machine), and anything that only exists in that machine's LM Studio
(local-only model weights, `lmstudio/...` sessions won't have a usable model there unless LM Studio
is also running with the same model loaded).

### Outfitter store

Set `KERNAL_TELEPORT_STORE=outfitter` to talk to the Outfitter cloud API instead of a local git clone.
`OUTFITTER_API` must point at the Outfitter **link** service (e.g.
`https://outfitter-link-hqt4zwr5za-uc.a.run.app`), not the browser-facing `outfitter-api` service --
the link service has no IAP session at all and is the one that accepts personal API tokens (see
"Auth" below and `outfitter/docs/protocol.md`'s "Two origins"). This is the "cloud → laptop" half of
teleport: `list`/`/teleport list` shows every session on that Outfitter deployment, and
`pull`/`kernal --teleport <id>` fetches one down. Pushing (`put`) works too --
`PUT /api/sessions/:id/import` creates the session server-side if it doesn't already exist there, so
pushing a laptop-only session id is fine.

**Auth: `kernal login`.** Sent as `Authorization: Bearer <access token>`, refreshed as needed; set
only `KERNAL_TELEPORT_STORE=outfitter` (and `OUTFITTER_API` for an Outfitter other than
`https://link.kernal.one`). Dongles (`OUTFITTER_TOKEN`) are retired and no longer read.

Neither token nor anything derived from it is ever written to disk by this module. A 401 from the
API means the login was rejected (signed out, revoked) -- run `kernal login` again. A 403
means that account isn't allowed to use this Outfitter deployment at all.

An earlier version of this store also tried an `OUTFITTER_IAP_CLIENT_ID` mode (minting a Google
identity token via `gcloud auth print-identity-token` and sending it the way IAP verifies browser
traffic). That was verified NOT working against a real deployed API on 2026-09-21 (critic review,
`outfitter/docs/reports/critic-review-pr15.md`): `gcloud auth print-identity-token` cannot mint a
token audienced to Google's IAP OAuth client for a user account, and IAP enabled directly on a
Cloud Run service uses that Google-managed OAuth client, whose credentials are never available for
programmatic access at all. It has been removed entirely, replaced by personal API tokens on a
separate, non-IAP link service (E4.1b) -- not left in as a fallback.

**Stop-before-pull.** `pull`/`kernal --teleport <id>` first checks whether the session has an active
cloud run (queued/provisioning/running/idle/stopping); if it does, it calls `POST
/api/sessions/:id/stop` and polls `GET /api/sessions/:id` (its `runState` field) until the run is no
longer active, so the exported transcript is complete, up to a 90s timeout with a clear error. Pass
`--force` (`kernal --teleport <id> --force` or `/teleport pull <id> --force`) to skip the wait and pull
whatever has been persisted so far -- the transcript tail may then be missing.

### Headless: `kernal --teleport <id>`

`bin/kernal` starts pi with `/teleport pull <id> [--force]` as its first message. pi runs a first
message that names an extension command as that command once the session is up, so the pull is the
same one `/teleport pull` does: store lookup, repo/branch checks, `SessionManager.forkFrom` import,
model remap, then a switch to the imported session. Any other pi arguments are passed on (a later
message runs in the imported session); `@file` arguments are refused, because pi would put the file
text in front of the command. With a UI, errors show in it and you stay in a fresh session. Without
one (`-p`, `--mode json`) messages go to stderr, an id collision imports under a new id, and a
failure exits 1 before any prompt runs.

It used to run a node script before pi started. Release bundles ship pi as a compiled binary, not
the npm package, so that script could not import `SessionManager` there (#426).

### Auto-push

Off by default. Set `teleport.autoPush: true` in `.pi/settings.json` to push after every turn
(`agent_end`) when the tree is clean. It's silent about "not ready to push yet" (dirty tree, no repo,
ephemeral `--no-session`) and only notifies on a real failure; it never blocks or throws.


## Outfitter admin tools

Signed in with `kernal login`, Kernal
can administer Outfitter itself: build and save a tape, manage environments, find and read past
sessions. In a Drive whose tape has **Admin tools** turned on, the same tools work through agentd.
The design is in `outfitter/docs/specs/sysop-tools.md`.

| Tool | Does |
|---|---|
| `outfitter_tapes` | list, get, meta (models, thinking levels, env limits), create, update, delete |
| `outfitter_environments` | list, get, create, update |
| `outfitter_sessions` | list, get |
| `session_search` | search Outfitter's sessions (keywords; `mode: hybrid` for meaning) and this laptop's own |
| `session_transcript` | read a session compactly: outline, `around` a hit, pages |

- The `outfitter-admin` skill (`kernal/skills`) walks through building a tape, debugging a Drive, and
  drafting a tape from past sessions. pi loads it only when it is needed.
- Deletes, and changes to a tape that has admin tools, ask you first in the terminal. In a Drive
  they wait for the owner's approval on the floppy page.
- Kernal reads the token once and removes it from the environment, so the agent's shell can't use
  it to skip that question.
- `/sessions sync <id>` or `/sessions sync --since 7d` uploads local sessions to Outfitter so its
  semantic search finds them too; `KERNAL_SESSION_SYNC=1` does it after every turn. Nothing is
  uploaded otherwise.

### Agent Engine memory (shared with your Drives)

Signed in the same way, Kernal uses your Outfitter's Agent Engine memory, the memory your Drives
use. A fact saved on the laptop is recalled in a Drive, and the other way round. It is yours alone,
except memories you save as shared. The design is §3.5 of
`outfitter/docs/specs/atlas-agent-engine-and-a2a.md`.

| `/memory …` | Does |
|---|---|
| `auto` (the default when signed in) | the `memory` tool, plus memories recalled before each prompt (3 s at most, skipped on any error) |
| `tool` | the `memory` tool only, no recall cost per prompt |
| `off` | neither; pi-memory comes back |
| `record on` / `record off` | opt in or out of recording this laptop's prompts and Kernal's final answers (redacted, never tool output). Off by default |
| `import [--dry-run]` | bring pi-memory's `MEMORY.md` notes over as private memories: listed first, saved on your yes; importing again updates them rather than doubling them |
| `status` (or nothing) | what is on |

- Settings live under `kernal` in `.pi/settings.json` (`memory`, `memoryRecord`) and apply at the next
  start.
- While memory is on, pi-memory is off: its tools, its prompt block and its exit summary.
  `bin/kernal` handles the last two before pi starts. Kernal offers the import once.
- The repo for a session comes from the working directory's GitHub `origin`. It only narrows which
  of your memories are recalled.
- A shared save (the team sees it in their prompts) waits for your yes in the Outfitter web app:
  the approval widget in the corner of any page shows the exact text, with Approve and Deny.
  - Kernal waits up to 10 minutes, and Esc stops the wait.
  - In print mode it doesn't wait. It answers with the pending approval id. The same save with that
    `approvalId` runs it once you approve, but only in the same session (`kernal -c -p`): the
    approval is bound to the session it came from.
  - It's not a terminal confirm because the agent's shell runs as you and could answer that itself.
- Needs an Outfitter release with E9.9. An older one answers "works only in a Drive", Kernal says
  so once, and recall is skipped.

## HTML previews: what the model is told

Outfitter's transcript can preview an ` ```html ` fence. By default that preview is sealed: inline CSS
only, no remote stylesheets, scripts, images, or fonts. kernal tells the model which kind of page to
write, so a page doesn't come out blank. Every turn, exactly one of these two paragraphs is appended to
pi's system prompt (`.pi/extensions/kernal-html-preview`; the text lives in
`.pi/extensions/_shared/html-preview-prompt.ts`).

Off by default. Set `kernal.allowExternalHtmlResources: true` in `.pi/settings.json` to switch from the
first paragraph to the second. It is read when kernal starts, so restart after changing it.

Sealed (the default):

> When you write HTML for the person to read in the transcript, put it in a ```html fence. Use only CSS
> written inside the document. Do not link stylesheets, scripts, images, or fonts. The preview blocks
> those until the person allows them. The preview cannot see this page or the session.

External (`kernal.allowExternalHtmlResources: true`):

> When you write HTML for the person to read in the transcript, put it in a ```html fence. External CSS
> and JavaScript are allowed: you may link http and https stylesheets, scripts, images, and fonts. The
> preview still cannot see this page or the session.

The paragraph goes in after anything `--append-system-prompt`, `~/.pi/agent/APPEND_SYSTEM.md`, or a
trusted project's `.pi/APPEND_SYSTEM.md` adds. kernal never reads or writes those files. For a plain pi
that doesn't run this extension, pasting the external paragraph into `APPEND_SYSTEM.md` by hand gives
the same instruction. If you paste it there and also turn the setting on, the model sees the paragraph
twice, which does no harm.

In an Outfitter Drive this extension is left out of the image. There, the Tape's **Allow external CSS
and JS in HTML previews** option picks the paragraph, and agentd appends it.

## Known issue: startup stalls while LM Studio is mid-generation

Deterministic repro: start any long generation against LM Studio, then launch kernal from any
directory with any model (even a cloud one). Startup performs its two discovery requests (LM
Studio `/v1/models`, router `/model/info`), both succeed, then pi stalls with no further network
activity until LM Studio's generation finishes. It reproduces with all packages removed, so it is
in pi itself or in this repo's extensions, not in an add-on. Not resolved yet. In practice it bites
when two clients share the local model (e.g. an interactive session on `local/<you>-<machine>/<model>`,
or the `litellm/local-qwen-mlx` alias, plus a second `kernal` launch). Thinking off by default keeps generations short, so
the wait is seconds rather than minutes. If a launch sits silent, check `lms ps --json` for
`generating`/`processingPrompt` and wait or `lms unload --all`.

## Tests

```bash
npm test               # unit + extension harness tests (no services needed)
npm run test:coverage  # same, with per-file coverage
npm run test:e2e       # live runs against LM Studio, LiteLLM and OpenRouter (KERNAL_E2E=1)
```

`npm run test:live` runs `tests/live.test.ts` against the real LiteLLM router: model listing, a
minimal completion with spend headers, the agent answering and calling a tool through the router,
and one real compaction fold on the default summarizer. It uses the cheapest capable model
(`gpt-5.4-nano`), tiny token limits and a hard cost ceiling read from the router's own cost
headers; a run costs well under $0.01. It needs `LITELLM_AGENT_KEY` (and `KERNAL_LIVE=1`); in GitHub
it reads the `LITELLM_CI_KEY` repository secret, runs as a gate in the release workflow and on
demand from *Actions → kernal live tests*, and skips itself when the secret is absent. Set the secret
with `gh secret set LITELLM_CI_KEY --repo cognitio-org/mgm-pi`, ideally with a dedicated router key
on a small budget.

`tests/*.test.ts` cover the pure libraries; `tests/extensions.test.ts` drives the real entry points
through a fake pi and context (`tests/harness.ts`): scripted dialog answers, stubbed summarizer,
temporary agent dir for settings persistence. `tests/resolve-pi.mjs` lets plain Node resolve pi's
nested `pi-ai` / `pi-tui` packages the way pi does for extensions. `KERNAL_NO_DISCOVERY=1` skips the
network model discovery (used by the tests; also handy offline). `KERNAL_SANDBOX=1` is set only by
Outfitter's cloud sandbox image: it skips the local-server probe and the key re-check at start-up,
fills the budget footer after pi is ready rather than before, and skips teleport's store prefetch
(see `outfitter/docs/reports/startup-trim.md`). Never set it on a laptop.

### Tests never see your real login (#433)

A signed-in laptop runs `npm test` the same as CI: no manual `HOME=` needed. `tests/resolve-pi.mjs`
imports `tests/isolate.mjs` first, in every test file's process, which:

- points `HOME` (and `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`) at a
  fresh temporary directory, removed when the process exits. Everything Kernal derives from the home
  lands there: `~/.kernal/auth`, `config.local.json`, `config-cache`, `reports`, `bin`,
  `~/.pi/agent` (pi-listen's voice settings), `~/.config/codebase-index`, `~/.kernal-sessions`,
  `~/localllm/.env`;
- drops inherited `KERNAL_*` / `MGM_*`, `PI_*`, `OUTFITTER_*` and `SENTRY_*` variables (except
  `KERNAL_LIVE*`, `KERNAL_E2E` and `KERNAL_TEST_*`), so overrides like `KERNAL_HOME_DIR`,
  `KERNAL_AUTH_DIR` or `PI_CODING_AGENT_DIR` from your shell cannot point a test at real state;
- sets `KERNAL_AUTH_BACKEND=file`, and `KERNAL_TEST_NO_KEYCHAIN=1`, which makes the real
  `security` / `secret-tool` runner (`_shared/keychain.ts`) fail as if the tool were missing. No
  test can read or write the `kernal-outfitter` Keychain items; a test of the keychain backends
  passes a fake runner.

These are only starting values: a test that sets its own `HOME`, `KERNAL_AUTH_DIR`,
`PI_CODING_AGENT_DIR` and so on still gets them. `tests/home-guard.mjs` runs as the runner's
`--test-global-setup`: it snapshots the direct entries of the real `~/.kernal` (and its `auth`,
`config-cache`, `reports`, `bin`), `~/.pi/agent`, `~/.kernal-sessions` and `~/.config/codebase-index`
before the run and fails it, naming the paths, if any were created, removed or modified (entries a
Kernal running in another shell touches itself, such as sessions and installed bundles, are not
watched). `tests/real-home-guard.test.ts` checks the isolation and the snapshot mid-run.
`npm run test:e2e` (`KERNAL_E2E=1`) opts out, since it uses the real keys in `~/localllm/.env` on
purpose, and so does a non-test script that borrows the resolver (`scripts/index-eval.mjs`).
Run a single file with the same flags, e.g.
`node --test-global-setup=./tests/home-guard.mjs --import ./tests/resolve-pi.mjs --test tests/sentry.test.ts`.

## Where the rest is

- [docs/architecture.md](docs/architecture.md) — how the connection, budget, compaction, banner, MCP
  and router pieces work, and the decisions behind them.
- [docs/index-retrieval.md](docs/index-retrieval.md) — what was measured when tuning codebase search,
  including the configurations that changed nothing.
- [docs/compaction-research.md](docs/compaction-research.md) — the reading behind the compaction design.
- [docs/summarizer-benchmark.md](docs/summarizer-benchmark.md) — why the default summariser is what it is.
- [docs/index-questions.json](docs/index-questions.json) — the retrieval question set, rerun with
  `node --import ./tests/resolve-pi.mjs scripts/index-eval.mjs`.
