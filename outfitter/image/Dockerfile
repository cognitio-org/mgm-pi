# Outfitter sandbox image: the mgm coding agent (pi) plus agentd, run as a Cloud Run Job execution
# (E1.1). Build context is the REPO ROOT (this file COPYs both mgm/ and outfitter/), so build from
# the root with:
#
#   docker build -f outfitter/image/Dockerfile -t outfitter-agent .
#
# or use outfitter/image/build.sh, which does exactly that. See outfitter/README.md.
#
# No secrets are baked in: mgm/.pi/auth.json (OAuth tokens), mgm/.pi/sessions/ (local transcripts)
# and mgm/.pi/mcp-cache.json are intentionally NOT copied. Per-run secrets (GitHub token, LiteLLM
# key) arrive over the authenticated agentd<->api WebSocket link at runtime (protocol.md
# run.spec.secrets), never through the image or env baked at build time.
#
# Multi-stage (E1.5, docs/reports/image-trim.md): each `npm ci`/`npm install` + build runs in its
# own builder stage so devDependencies, TypeScript sources and npm's cache never reach the runtime
# stage; only the runtime stage's layers count toward the shipped image. Before this rewrite the
# security fix's `chown -R agent:agent /opt/mgm /opt/outfitter` ran as its own RUN after both trees
# were already populated, which -- because chown touches every file's metadata -- forced the
# overlay filesystem to copy every byte of both trees into one more layer on top of the layers that
# already held them (measured: +461 MB for that one RUN, see the report). `COPY --chown` sets
# ownership as part of the copy itself, so it never pays that doubling.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# Stage: mgm-builder -- installs mgm's own deps, then the packages
# mgm/.pi/settings.json lists (pi-mcp-adapter, pi-web-access, pi-memory, pi-subagents,
# open-codebase-index) from mgm/.pi/npm's COMMITTED lockfile. This replaces the old `pi update`
# step: `pi update` needs the pi CLI itself plus live npm registry access at build time and (see
# docs/reports/image-trim.md) was silently failing in this build environment the whole time
# (swallowed by `|| true`), leaving every image built from the old Dockerfile without any of these
# packages at all. `npm ci` against the lockfile mgm's maintainers already commit is reproducible,
# offline-friendly, and actually installs what settings.json asks for.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS mgm-builder
WORKDIR /opt/mgm
COPY mgm/package.json mgm/package-lock.json ./
RUN npm ci --omit=dev
COPY mgm/bin/ ./bin/
COPY mgm/.pi/mcp.json ./.pi/mcp.json
COPY mgm/.pi/extensions/ ./.pi/extensions/
# Laptop-only mgm extensions stay out of the cloud image: mgm-voice (microphone; it also creates
# ~/.pi/agent at load and was the first thing to trip on the agent user's HOME) and mgm-update
# (checks GitHub releases at session start; a sandbox is replaced by redeploying the image).
RUN rm -rf ./.pi/extensions/mgm-voice ./.pi/extensions/mgm-update

# TUI/laptop-only packages (voice input, terminal footer, editor LSP) make no sense for a cloud
# guru with no terminal, no editor and no microphone attached; drop them from the image's
# settings.json only, derived from the real mgm/.pi/settings.json (see render-settings.sh) so the
# laptop install this repo ships is untouched and the two can't drift apart silently.
COPY mgm/.pi/settings.json /tmp/settings.full.json
COPY outfitter/image/render-settings.sh /tmp/render-settings.sh
RUN bash /tmp/render-settings.sh /tmp/settings.full.json /opt/mgm/.pi/settings.json

ENV PI_CODING_AGENT_DIR=/opt/mgm/.pi
COPY outfitter/image/strip-native-binaries.sh /tmp/strip-native-binaries.sh
WORKDIR /opt/mgm/.pi/npm
COPY mgm/.pi/npm/package.json mgm/.pi/npm/package-lock.json ./
# --legacy-peer-deps: these packages peer-depend on pi's own packages, which the pi binary/npm
# install under /opt/mgm provides at runtime (no copy needed) -- same flag scripts/package.sh uses
# for the identical lockfile, for the identical reason.
# recheck-jar is a JVM fallback for pi-mcp-adapter's ReDoS-safety check (`recheck`), only used when
# no native `recheck-<platform>` binary is available for the host -- one always is here (installed
# alongside it, see strip-native-binaries.sh), and this image has no `java` to run the jar with
# anyway, so it is 23 MB of dead weight.
RUN npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund --loglevel=error \
  && bash /tmp/strip-native-binaries.sh /opt/mgm/.pi/npm/node_modules "$(dpkg --print-architecture)" \
  # Uninstall (not rm -rf) so each excluded package's own dependency subtree goes with it. The list
  # must match render-settings.sh's default EXCLUDE; the settings file only stops pi loading them.
  && npm uninstall --no-save --legacy-peer-deps --omit=dev --no-audit --no-fund --loglevel=error \
       pi-lsp pi-powerline-footer @codexstar/pi-listen open-codebase-index \
  && rm -rf node_modules/recheck-jar

# esbuild's per-platform optional deps (@esbuild/darwin-arm64, @esbuild/win32-x64, ...) are the
# single biggest offender in mgm's own node_modules too: `npm ci` installs every platform's binary
# (~285 MB across ~27 platforms for this one package) though only one will ever run here. Also drop
# the package's own docs/examples/changelog, never read at runtime.
RUN bash /tmp/strip-native-binaries.sh /opt/mgm/node_modules "$(dpkg --print-architecture)" \
  && rm -rf /opt/mgm/node_modules/@earendil-works/pi-coding-agent/docs \
            /opt/mgm/node_modules/@earendil-works/pi-coding-agent/examples \
            /opt/mgm/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md

# ---------------------------------------------------------------------------
# Stage: agentd-builder -- compiles agentd to plain JS and keeps only its runtime dependency (ws).
# `npx tsc` directly (not `npm run build`) so this doesn't trip package.json's `postbuild` hook,
# which chmods a test fixture (dist/test/fake-pi.js) this stage never builds -- agentd's test/ and
# dev/ trees aren't part of the runtime image and are intentionally not copied in.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS agentd-builder
WORKDIR /opt/outfitter/agentd
COPY outfitter/packages/agentd/package.json ./
RUN npm install
COPY outfitter/packages/agentd/tsconfig.json ./
COPY outfitter/packages/agentd/src/ ./src/
# E2.11 (docs/reports/cost-and-logs.md "Follow-up"): pi-extension/outfitter-spend.ts is loaded by
# pi itself via `-e <path>` (renderGuru, guru.ts) to relay LiteLLM spend headers back to agentd as
# `spend` frames; tsconfig.json's `include` already covers pi-extension/**/*.ts, so building it here
# is just a matter of copying the source in before `tsc` runs.
COPY outfitter/packages/agentd/pi-extension/ ./pi-extension/
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage: runtime -- the image that actually ships. Only COPY --from=builder (never a builder's own
# devDependencies, npm cache, or TypeScript sources) plus the apt packages the sandbox needs live.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# git/ripgrep: tools the pi agent's bash/grep tools use. ca-certificates/curl: needed for HTTPS out
# (LiteLLM, GCE metadata server, GitHub) and to fetch gh's apt key. gh: PR workflows (E6) -- kept
# even though nothing uses it yet; it is the single largest apt package here (~38 MB installed) so
# it is worth revisiting if E6 ends up not needing it inside the sandbox (a guru could shell out to
# the api's own GitHub broker instead of a local gh install).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && apt-get purge -y --auto-remove gnupg \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin agent

COPY --from=mgm-builder --chown=agent:agent /opt/mgm /opt/mgm
COPY --from=agentd-builder --chown=agent:agent /opt/outfitter/agentd /opt/outfitter/agentd

# session.ts dynamic-`import()`s @earendil-works/pi-coding-agent (SessionManager.forkFrom) at
# runtime instead of declaring it as an agentd dependency -- it's mgm's package, not agentd's, and
# only present in this image (see session.ts's comment). But Node's ESM resolver only walks up
# node_modules directories that are ANCESTORS of the importing file (dist/src/session.js under
# /opt/outfitter/agentd), and /opt/mgm is not an ancestor of /opt/outfitter, so the bare import
# would fail with ERR_MODULE_NOT_FOUND. Symlink it into agentd's own node_modules so resolution
# finds it, same as if it were a normal dependency.
RUN mkdir -p /opt/outfitter/agentd/node_modules/@earendil-works \
  && ln -s /opt/mgm/node_modules/@earendil-works/pi-coding-agent \
       /opt/outfitter/agentd/node_modules/@earendil-works/pi-coding-agent \
  && mkdir -p /workspace && chown agent:agent /workspace

# /run/outfitter holds the per-run spend file (below). 0750 root:agent: root can create files in
# it; `agent` (the pi/model process's own user) can only traverse it (group r-x, no w), so `agent`
# cannot itself create the spend file here -- it can only write into a file that already exists.
# That means agentd (which runs as root -- see the two-users note below) must create
# /run/outfitter/spend.jsonl itself, as root, with mode 0660 root:agent, before it spawns `pi`;
# that file-side change is agentd's own responsibility (out of scope for this image-only pass) and
# is what actually lets `agent` write spend records at all. Verified here: with only this
# directory created and no pre-created file, `agent` gets EACCES trying to create the file itself
# -- expected until agentd's startup path does that. This directory alone is enough for `agent` to
# open an EXISTING file for append (group rw on the file, not the directory, covers that).
RUN install -d -m 0750 -o root -g agent /run/outfitter

ENV PI_CODING_AGENT_DIR=/opt/mgm/.pi \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_BIN=/opt/mgm/node_modules/.bin/pi \
    WORKSPACE=/workspace \
    PI_RUN_AS_USER=agent \
    OUTFITTER_SPEND_EXTENSION=/opt/outfitter/agentd/dist/pi-extension/outfitter-spend.js \
    OUTFITTER_SPEND_FILE=/run/outfitter/spend.jsonl \
    MGM_NO_CODEBASE_INDEX=1

# MGM_NO_CODEBASE_INDEX=1: mgm-codebase-index (mgm/.pi/extensions/mgm-codebase-index) loads
# open-codebase-index from .pi/npm if present and returns silently if not -- this image already
# drops open-codebase-index on purpose (section 7, docs/reports/image-trim.md), so the probe would
# always be a no-op anyway. Setting the flag makes that explicit and skips the probe entirely
# instead of relying on the loader's own fallback.
#
# mgm-report (mgm/.pi/extensions/mgm-report) is left in: at startup it only calls
# pi.registerCommand/pi.on, no network or `gh` call happens until a human actually runs /report
# inside a live session, which a headless Cloud Run Job execution never does. Its writes
# (`$PI_CODING_AGENT_DIR/bug-reports`, i.e. /opt/mgm/.pi/bug-reports) land under /opt/mgm, which is
# `COPY --chown=agent:agent` above -- already writable by `agent`, the same user pi runs as -- so no
# extra directory or chmod is needed for it here. If /report is ever wired into the guru flow, gh
# also needs to be authenticated inside the sandbox, which is out of scope for this trim.
#
# OUTFITTER_SPEND_FILE now lives under /run/outfitter (0750 root:agent, created above) instead of
# /tmp (mode 1777, world-writable): only root and `agent` can write there, so no other unprivileged
# user on the box can forge spend records. Note this does NOT stop the model's own shell tool from
# forging them -- pi (and everything it shells out to) also runs as `agent` (see PI_RUN_AS_USER
# below), so the same user that legitimately writes real spend records could in principle write fake
# ones too. Closing that gap needs validation on the read side (agentd/api treating the file as
# untrusted model output), which is tracked separately and does not land in this image-only pass.
# One Cloud Run Job execution runs exactly one guru turn end to end (E1.1), so a fixed path (not a
# per-run generated name) is safe -- there is never a second run sharing this container instance.

# Two Linux users on purpose (finding #1, docs/reports/security-review-pr1.md): the entrypoint
# (agentd, and therefore its `git` child) stays root; `pi` -- and, through it, every command the
# model's shell tool runs -- is spawned as the unprivileged `agent` user (agentd's run-as-user.ts,
# resolveRunAsUser/PI_RUN_AS_USER). Without this split, agentd and pi shared one Linux user, so any
# command the model ran could read the GitHub token straight out of agentd's own git child's
# environment via /proc/<pid>/environ (or, before that fix, its argv via /proc/<pid>/cmdline) for
# the lifetime of that git invocation. Running the entrypoint as root is what makes root's own
# /proc/<pid>/environ (kernel-restricted to uid 0) actually root-only; agentd chowns whatever git
# writes into /workspace back to `agent` afterward (run.ts's chownWorkspace) so pi never has to run
# as root to use its own working tree. WORKDIR is deliberately not switched to the `agent` user here.
WORKDIR /workspace

ENTRYPOINT ["node", "/opt/outfitter/agentd/dist/src/main.js"]
