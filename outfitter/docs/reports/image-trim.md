# Image trim (E1.5)

Trims the `outfitter-agent` sandbox image (`outfitter/image/Dockerfile`). Touches
`outfitter/image/{Dockerfile,build.sh}` (rewritten) and two new scripts,
`outfitter/image/{render-settings.sh,strip-native-binaries.sh}`. Does not touch
`packages/agentd/src` or `packages/api` beyond reading them; picks up the E2.11 spend-extension
follow-up from `docs/reports/cost-and-logs.md` ("Follow-up") along the way, per that report's
request.

**Result: 2.16 GB -> ~0.92-0.93 GB actual content (`du -sh /` inside the container), ~1.2-1.3 GB
by `docker images`. Below the 600 MB target -- see "Why 600 MB isn't reachable" for the honest
breakdown of what's left and why.**

## 1. Measuring the starting point

Built the pre-existing single-stage Dockerfile as-is (one change only, to get it to build at all:
`npm run build` in the agentd step failed because `postbuild` (`chmod +x dist/test/fake-pi.js`)
expects `test/` to exist, but the Dockerfile never copied it in -- swapped for `npx tsc -p
tsconfig.json` so the build actually runs; this bug predates this change and is fixed for real
below by not running `postbuild` in the image at all).

`docker images outfitter-agent:baseline` → **2.11 GB** (EPIC.md's earlier number, 2.16 GB, was a
slightly different prior build; same order of magnitude). `docker history --no-trunc`, by layer:

| Layer | Size |
|---|---|
| `RUN chown -R agent:agent /opt/mgm /opt/outfitter ...` | **461 MB** |
| `RUN npm ci` (mgm's own deps) | 593 MB |
| `RUN apt-get ... git ripgrep gh ...` | 159 MB |
| node:24-bookworm-slim base layers (node, yarn, debian) | ~380 MB |
| `RUN npm install` (agentd, incl. devDependencies) | 60 MB |
| `RUN pi update \|\| true` | 2 MB (!) |

Two findings before any trimming:

- **The `chown -R` layer is almost as big as the app content it's chowning.** Overlayfs treats a
  metadata-only change (ownership) as a full copy-up of every file whose owner changed, so running
  `chown -R` as its own `RUN` *after* `npm ci` and `pi update` had already populated `/opt/mgm` and
  `/opt/outfitter` doubled their cost: once for the layer that created the files, once more for the
  layer that only touched their owner. `COPY --chown` (used throughout the rewrite) sets ownership
  as part of the copy and never pays this.
- **`pi update || true` was silently failing the entire time.** `du -sh /opt/mgm/.pi/npm` inside
  the baseline container: `No such file or directory` -- the directory doesn't exist at all. Every
  image built from the old Dockerfile shipped **none** of settings.json's packages
  (pi-mcp-adapter, pi-web-access, pi-memory, pi-subagents, open-codebase-index, plus the
  TUI-only ones) -- `pi update` needs the pi CLI itself plus live npm registry access at *build*
  time, which this build environment doesn't reliably have, and the trailing `|| true` swallowed
  the failure completely. `docker run --entrypoint pi ... --version` still worked (pi itself is a
  normal `dependencies` entry, installed by the earlier `npm ci`), so this was invisible unless you
  went looking for the packages themselves. This is a correctness bug independent of image size:
  every deployed guru session so far has been running without any of its configured packages.

## 2. The rewrite

`outfitter/image/Dockerfile` is now three stages: `mgm-builder`, `agentd-builder`, `runtime`. Only
`COPY --from=<builder>` and apt packages land in `runtime`; nothing from a builder's own
`node_modules` devDependencies, npm cache, or TypeScript source ever reaches the shipped image.

- **`pi update` → `npm ci` against `mgm/.pi/npm`'s committed lockfile.** Reproducible, offline
  after the build context is fetched, and -- unlike `pi update` -- actually installs what
  `settings.json` asks for. Needed `--legacy-peer-deps` (same flag `mgm/scripts/package.sh` already
  uses for this exact lockfile, same reason: these packages peer-depend on pi's own packages,
  supplied by the sandbox's pi install, not published anywhere `npm` can resolve on its own) --
  plain `npm ci` refused with `EUSAGE`/"lock file out of sync" until that flag was added.
- **Image-only `settings.json`, derived from the real one.** `outfitter/image/render-settings.sh`
  filters `mgm/.pi/settings.json`'s `packages` array (same technique as `package.sh`'s
  `BUNDLE_EXCLUDE`, so it can't drift silently), dropping `pi-listen` (voice, needs a mic),
  `pi-powerline-footer` (renders into a terminal footer) and `pi-lsp` (editor-integration LSP) --
  none of which make sense for a guru with no terminal, editor or microphone. Their own
  `node_modules` entries are additionally `rm -rf`'d after `npm ci` (they were tiny, ~1.4 MB total,
  but this keeps the image's installed packages matching its activated ones). Kept exactly what the
  task named as needed: `pi-mcp-adapter`, `pi-web-access`, `pi-memory`, `pi-subagents`. Also kept
  `open-codebase-index` (semantic code search/call-graph/definition-lookup over MCP tools) -- it
  isn't TUI-bound and is arguably *more* useful headless than on a laptop, but see the size note
  below; it is the single largest thing left to cut if a future guru config doesn't need it.
- **`strip-native-binaries.sh`: delete every platform's native code except this build's own.**
  `npm ci` in this environment installs every optional-dependency platform regardless of the
  package-lock's `os`/`cpu` fields (observed directly: 26 platforms of `@esbuild/*` for one arm64
  build). Handles both conventions native npm packages use -- one package per platform (deletes the
  whole directory) and one package with `<name>.<platform>.node` files inside (deletes by
  filename). Run against both `mgm`'s own `node_modules` and `.pi/npm`'s.
    - `@esbuild/*` inside `@earendil-works/pi-coding-agent`: 285 MB → ~11 MB (one platform kept).
    - `open-codebase-index`'s bundled native addon (`native/codebase-index-native.*.node`, six
      platforms in one package -- exactly the situation `mgm/scripts/package.sh`'s own comment
      already flagged): 280 MB → ~47 MB.
    - Also caught `@napi-rs/canvas-<platform>`, `sherpa-onnx-<platform>`, `recheck-<platform>`, and
      pi-coding-agent's own nested `@esbuild` copy.
- **`recheck-jar` removed** (23 MB): a JVM fallback for `pi-mcp-adapter`'s ReDoS-safety check, only
  used when no native `recheck-<platform>` binary is present -- one always is here, and this image
  has no `java` to run the jar with regardless (`which java` → not found even before removing it),
  so it was pure dead weight.
- **Docs/examples/changelog dropped** from `@earendil-works/pi-coding-agent` (~5 MB) -- never read
  at runtime.
- **`COPY --chown` everywhere** instead of a trailing `chown -R` (see finding above; this alone is
  worth ~460 MB of layer bloat on its own, though most of that was double-counting content the
  other fixes above also shrink).
- **`gnupg` purged after fetching gh's apt key** (it, and its ~18 transitive packages, are only
  needed to import that one key); `git`, `ripgrep`, `ca-certificates`, `curl`, and `gh` itself kept
  exactly as before -- the task said to keep `gh` (E6 needs it later) and check whether an
  extension needs it now (none do yet; noted as a future revisit if E6 ends up not needing a local
  `gh` inside the sandbox at all).
- **`node:24-slim` vs `node:24-bookworm-slim`: no difference right now.** `docker images` for both
  tags: 351 MB each -- `node:24-slim` currently resolves to the same Debian bookworm base.
  `node:24-alpine` is 238 MB (113 MB smaller) but Alpine's musl libc doesn't run the `-gnu`
  glibc-linked native addons this image depends on (`@napi-rs/canvas-linux-x64-gnu`,
  `sherpa-onnx-linux-x64`, `codebase-index-native.linux-x64-gnu.node`, ...) without switching every
  one of those packages to a musl build if one even exists; not pursued given the size/risk
  tradeoff and the time budget for this pass. Kept `node:24-bookworm-slim`, pinned (an `ARG
  NODE_IMAGE` at the top of the Dockerfile makes revisiting this a one-line change).

## 3. E2.11 follow-up picked up here (per `docs/reports/cost-and-logs.md`)

The parallel cost/logs session added `packages/agentd/pi-extension/outfitter-spend.ts` (a pi
extension, loaded via `-e <path>`, that relays LiteLLM spend headers back to agentd as `spend`
frames) and flagged three things the Dockerfile/build-script owner (this session) still needed to
do, all done here:

- `agentd-builder` now also `COPY`s `outfitter/packages/agentd/pi-extension/` before `tsc` runs
  (`tsconfig.json`'s `include` already covered `pi-extension/**/*.ts`).
- `runtime`'s `ENV` gained `OUTFITTER_SPEND_EXTENSION=/opt/outfitter/agentd/dist/pi-extension/outfitter-spend.js`,
  matching where the builder stage emits it, so `main.ts`'s existing
  `process.env.OUTFITTER_SPEND_EXTENSION` read actually resolves to something.
- `runtime`'s `ENV` also gained `OUTFITTER_SPEND_FILE=/tmp/outfitter-spend.jsonl` -- a fixed path
  rather than a per-run generated one, because one Cloud Run Job execution runs exactly one guru
  turn end to end (E1.1: never two runs sharing a container instance). `/tmp` is mode 1777
  (world-writable, sticky bit) on this base image, so it needs no extra `chown` and is writable by
  both `pi` (runs as `agent`, writes the file) and `agentd` (runs as root, tails it).

## 4. Verification

- **Build succeeds**, both natively (`linux/arm64`, this Mac) and cross-built for `linux/amd64` via
  `docker buildx build --platform linux/amd64` (the actual Cloud Run Jobs target -- see the libmvec
  note below for why this distinction matters here).
- **`pi --version` as the `agent` user**: `su agent -s /bin/sh -c '/opt/mgm/node_modules/.bin/pi --version'`
  → `0.86.1`, exit 0, on both platforms.
- **Root/agent split still holds.** Ran the full agentd state machine inside a live container
  (`dev/fake-api.js` + `dist/src/main.js`, `PI_BIN` pointed at the compiled `fake-pi.js`, a
  repo-less `run.spec` with no `repo` key, prompt "reply with the single word pong") and inspected
  `/proc/<pid>/status` for both processes directly (no `ps` in this minimal image): `main.js`
  (agentd) → `Uid: 0` (root); the `pi`-standing-in `fake-pi.js` child → `Uid: 1001` (`agent`).
  Matches the documented contract exactly (finding #1, `docs/reports/security-review-pr1.md`).
- **agentd smoke against `dev/fake-api` passes inside the container**: full turn observed end to
  end over the frames the fake-api driver logs -- `hello` → `status: restoring/starting/idle` →
  `prompt` → `response`/`agent_start`/`status: running`/`message_update` (delta `"pong"`). Matches
  the README's documented flow.
- **`outfitter-spend` extension loads under real pi without error.** `fake-pi.js` doesn't load real
  pi extensions at all (it's a total stand-in, ignores `-e`), so it can't itself produce a `spend`
  frame; per the coordinator's fallback, verified the weaker but still meaningful claim instead:
  ```
  su agent -s /bin/sh -c \
    'OUTFITTER_SPEND_FILE=/tmp/spend.jsonl /opt/mgm/node_modules/.bin/pi \
       -e /opt/outfitter/agentd/dist/pi-extension/outfitter-spend.js \
       --provider litellm --model fake-model -p --no-session "hello"'
  ```
  → `Error: Unknown provider "litellm"` (expected -- no real LiteLLM connect config in this
  container) with **no** extension-load error before it, on `linux/amd64`. Every other loaded
  extension (the four kept `.pi/npm` packages, `open-codebase-index`, mgm's own `.pi/extensions`)
  also loaded cleanly in the same run. A genuine end-to-end `spend` up-frame needs a real LiteLLM
  call (out of reach here -- no live model), so this is as far as this pass verifies it; wiring a
  real LiteLLM key into a future smoke run is a good follow-up for whoever owns E2.7 deploy.
- **`libmvec.so.1` gotcha, arm64-build-only.** On the native `linux/arm64` build (this Mac),
  `open-codebase-index`'s native addon fails to load: `Error: libmvec.so.1: cannot open shared
  object file`. Root cause: `libmvec` (glibc's vectorized math library) was never built for aarch64
  upstream -- it's an x86_64-only component of glibc, present on every Debian amd64 system but on
  *no* Debian arm64 system, ever. Confirmed this is purely a local-arm64-dev-machine artifact, not
  an image bug: the identical addon (`codebase-index-native.linux-x64-gnu.node`, correctly selected
  by `strip-native-binaries.sh`) loads and `pi --help`/`pi -e ...` run cleanly on a `linux/amd64`
  build with no error at all. Cloud Run only runs amd64, so production is unaffected -- but anyone
  building this image on Apple Silicon for local testing needs to know `pi` itself won't fully
  start until they cross-build for `linux/amd64` (or accept that `open-codebase-index` specifically
  won't load on that build). `outfitter/image/build.sh` now defaults to `--platform linux/amd64`
  for this reason (override with `OUTFITTER_IMAGE_PLATFORM=linux/arm64` for a faster
  build-only/size-only check that doesn't need `pi` to actually run).

## 5. Before / after

| | Baseline (old Dockerfile, `pi update` silently broken) | Trimmed, `linux/arm64` (this Mac) | Trimmed, `linux/amd64` (Cloud Run target) |
|---|---|---|---|
| `docker images` size | 2.11 GB | 1.22 GB | 261 MB* |
| `du -sh /` (actual content) | 1.0 GB (packages missing!) | 921 MB | 932 MB |
| `.pi/npm` packages actually installed | **none** (bug) | pi-mcp-adapter, pi-web-access, pi-memory, pi-subagents, open-codebase-index | same |

\* The `docker images` number for the `amd64` build is not trustworthy -- built via `docker buildx
--load` under QEMU emulation on this arm64 machine, and its size accounting doesn't match `du -sh /`
run inside the same image (932 MB). `du -sh /` is the number to trust; it agrees within noise
between both platforms, as expected (same packages, same strip logic, different native binary
selected).

**~2.16 GB → ~0.92-0.93 GB actual content: roughly a 57% reduction**, with the pre-existing
`pi update` bug fixed as a side effect (the packages ship now, where they silently didn't before --
so this is a fair comparison of "what a correct build costs" vs "what an incomplete build cost",
not size-vs-size on identical functionality).

## 6. Why 600 MB isn't reachable (with everything currently kept)

Budget math, real `du -sh` content, `linux/amd64`:

| Component | Size | Notes |
|---|---|---|
| `node:24-bookworm-slim` base image | 351 MB | `docker images node:24-bookworm-slim` |
| apt additions (git, ripgrep, gh, ca-certificates, curl) | ~149 MB | `gh` alone: 38 MB installed + its deps |
| `mgm`'s own `node_modules` (`@earendil-works/pi-coding-agent`, post-strip) | ~150 MB | the pi CLI's own SDK deps: openai, @anthropic-ai, @google, @aws-sdk/@smithy, esbuild (1 platform), ... |
| `.pi/npm` packages (post-strip, TUI packages + recheck-jar dropped) | ~370-400 MB | dominated by `open-codebase-index` (~47 MB self + ~90 MB of its own deps: pdfjs-dist, tiktoken, @modelcontextprotocol/sdk) plus `pi-subagents`, `pi-web-access`, `pi-mcp-adapter`, `pi-memory`, and their own native deps (`@napi-rs/canvas`, `sherpa-onnx`, `recheck`) |

Base image + apt alone is already ~500 MB before a single line of application code -- that leaves
roughly 100 MB of headroom under a 600 MB target for *all* of mgm's own agent SDK plus every kept
`.pi/npm` package, which isn't realistic while keeping git+ripgrep+gh (explicitly requested), a full
Node runtime (not swappable for something smaller without breaking native addons -- see the Alpine
note above), and the four named-as-needed packages plus their own transitive weight (SDK clients for
every model provider pi supports, not something this pass can selectively strip without breaking
providers other gurus may want).

**Concretely, the only lever left that would meaningfully close the remaining ~300+ MB gap without
touching the four explicitly-required packages is `open-codebase-index`** (~140 MB including its
own dependency tree) -- not in the task's explicit exclude list, genuinely useful for a cloud coding
guru (semantic search/call-graph/definition-lookup), so left in rather than cut unilaterally for a
size target alone. `render-settings.sh`'s exclude list (default:
`pi-listen,pi-powerline-footer,pi-lsp`) is a one-line override
(`bash render-settings.sh src dest pi-listen,pi-powerline-footer,pi-lsp,open-codebase-index`) away
from also dropping it, and the same string should be added to the `rm -rf node_modules/...` line
right below it in the Dockerfile, if a future decision is to not ship it by default. Recommend this
be an explicit product call (does a cloud guru need codebase search out of the box, or is it opt-in
per guru config) rather than something folded into this size-only pass.

Other, smaller remaining levers, roughly in order of easiest-to-hardest:
- Drop `gh` if E6 ends up routing GitHub operations through the api's broker instead of a local
  `gh` inside the sandbox (~38-80 MB with its apt dependency chain).
- Move to `node:24-alpine` (~113 MB smaller base) if every native addon in the kept package set can
  be confirmed to have a musl-compatible build, or those addons can be dropped/replaced.
- Re-check whether `curl` is actually used at runtime (by an extension's shell-outs) versus only at
  build time (fetching gh's apt key) -- the existing Dockerfile comment says it's needed for
  runtime HTTPS egress, not verified independently in this pass; if untrue, it's a small removal.

## 7. Follow-up: `open-codebase-index` dropped from the cloud image

`open-codebase-index` points its embeddings at LM Studio on the laptop (`mgm/README.md`), so in a
cloud sandbox it is dead weight, and its native addon does not load on arm64 builds. It is now in
`render-settings.sh`'s default exclude list, and the Dockerfile uninstalls excluded packages with
`npm uninstall --no-save` (not `rm -rf`) so their dependency subtrees go too.

| | Trimmed (section 5) | Trimmed, index removed |
|---|---|---|
| `du -sh /` inside the container (linux/amd64) | 932 MB | **681 MB** |
| `.pi/npm/node_modules` entries | 237 | 166 |
| `pi --version` / `pi --help` as `agent` | ok | ok |

Overall: 2.16 GB → 681 MB of content (68% smaller). The 600 MB target is now within reach of the
next lever (`gh`, ~80 MB with its apt chain, only needed once E6 lands).

## 8. Image findings fixed (re-verified against the current tree)

Three findings against the trimmed image, plus a re-verification against `main` as it stands today
(after `mgm/.pi/extensions` picked up `mgm-codebase-index` and `mgm-report`, neither of which
existed when section 4 was last run).

1. **`mgm-codebase-index` / `mgm-report` at cloud startup.** `mgm-codebase-index` loads
   `open-codebase-index` from `.pi/npm` if present and returns silently if not -- this image already
   drops `open-codebase-index` on purpose (section 7), so the probe was already a harmless no-op,
   but the Dockerfile now sets `MGM_NO_CODEBASE_INDEX=1` to make that explicit instead of relying on
   the loader's own fallback. `mgm-report` only registers a command and an `agent_end` listener at
   load time -- no network or `gh` call happens until a human runs `/report` in a live session,
   which a headless Cloud Run Job execution never does -- so it's left in; its writes
   (`$PI_CODING_AGENT_DIR/bug-reports`, under `/opt/mgm/.pi`) already land somewhere `COPY
   --chown=agent:agent` made writable by `agent`, so no extra directory setup was needed.
2. **`strip-native-binaries.sh`'s `keep_re` only recognized the forward platform-name order**
   (`linux-x64`) even though `platform_re_rev` (used to detect *any* platform-tagged path) also
   matches the reversed order (`x64-linux`, e.g. napi-rs's arch-then-os convention). A package
   naming itself in the reversed order for this build's own platform would be recognized as "some
   platform" and then incorrectly deleted, because it never matched the forward-only `keep_re`.
   Fixed by adding `keep_re_rev` and checking both. New regression test,
   `outfitter/image/strip-native-binaries.test.sh`: builds a temp `node_modules` with a
   forward-order, a reversed-order, and two foreign-platform package directories and asserts the
   build's own platform survives in both orders while foreign platforms are removed. Passes:
   `strip-native-binaries.test.sh: PASS`.
3. **`OUTFITTER_SPEND_FILE` lived in `/tmp`** (mode 1777, world-writable). Moved to
   `/run/outfitter/spend.jsonl`, with `/run/outfitter` created in the Dockerfile via `install -d -m
   0750 -o root -g agent /run/outfitter`. This is deliberately *not* sufficient on its own: 0750
   gives `agent` only read+execute on the directory (via the `agent` group), not write, so `agent`
   cannot create the spend file itself -- confirmed by testing (`agent` writing to a file that
   doesn't yet exist under `/run/outfitter` fails with `EACCES`). agentd (which runs as root) needs
   to create `/run/outfitter/spend.jsonl` itself with mode `0660 root:agent` before spawning `pi`;
   once that file exists, `agent` can open and append to it (group `rw` on the *file* covers that,
   independent of the directory's own group permission) -- confirmed by pre-creating the file as
   root with `install -m 0660 -o root -g agent` and then writing to it as `agent`, which succeeds.
   That file-creation change belongs to agentd's own startup path, out of scope for this image-only
   pass, and is called out as a dependency in the Dockerfile comment. This also does **not** stop
   forgery by the model itself: `pi`, and everything the model's shell tool runs, also runs as
   `agent` (`PI_RUN_AS_USER=agent`), the same user that legitimately writes real spend records --
   closing that gap needs validation on the read side (agentd/api treating the file as untrusted
   model output), tracked separately.

**Re-verification, current tree, `linux/amd64`** (`docker buildx build --platform linux/amd64
--load -f outfitter/image/Dockerfile -t outfitter-agent:review .` from the repo root):

| Check | Result |
|---|---|
| Build | succeeds |
| `du -sh /` inside the container | **681 MB** (unchanged from section 7 -- none of these three fixes add or remove packages) |
| `pi --version` as `agent` (`su agent -s /bin/sh -c '/opt/mgm/node_modules/.bin/pi --version'`) | `0.86.1`, exit 0 |
| `pi --help` as `agent` | exit 0, no error lines |
| `pi -p --no-session "x"` as `agent` | fails on the provider only (`MCP: Failed to connect to litellm/google_admin/augment_admin` -- expected, no live credentials in this container; `Connection error.`), **zero** extension-load errors |
| mgm extensions present under `/opt/mgm/.pi/extensions` | `compaction`, `connect`, `mgm-banner`, `mgm-codebase-index`, `mgm-report`, `mgm-update`, `mgm-voice`, `teleport` -- all load without error per the check above |
| `open-codebase-index` in `.pi/npm/node_modules` | absent (dropped, as intended by section 7 and reinforced by `MGM_NO_CODEBASE_INDEX=1`) |
| `/run/outfitter` | `drwxr-x--- root agent`, matches `install -d -m 0750 -o root -g agent` |
| `strip-native-binaries.test.sh` | `PASS` |
