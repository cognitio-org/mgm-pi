# Outfitter sandbox image: the kernal coding agent (pi) plus agentd, run as a Cloud Run Job execution
# (E1.1). Build context is the REPO ROOT (this file COPYs both kernal/ and outfitter/), so build from
# the root with:
#
#   docker build -f outfitter/image/Dockerfile -t outfitter-agent .
#
# or use outfitter/image/build.sh, which does exactly that. See outfitter/README.md.
#
# No secrets are baked in: kernal/.pi/auth.json (OAuth tokens), kernal/.pi/sessions/ (local transcripts)
# and kernal/.pi/mcp-cache.json are intentionally NOT copied. Per-run secrets (GitHub token, LiteLLM
# key) arrive over the authenticated agentd<->api WebSocket link at runtime (protocol.md
# run.spec.secrets), never through the image or env baked at build time.
#
# Multi-stage (E1.5, docs/reports/image-trim.md): each `npm ci`/`npm install` + build runs in its
# own builder stage so devDependencies, TypeScript sources and npm's cache never reach the runtime
# stage; only the runtime stage's layers count toward the shipped image. Before this rewrite the
# security fix's `chown -R agent:agent /opt/kernal /opt/outfitter` ran as its own RUN after both trees
# were already populated, which -- because chown touches every file's metadata -- forced the
# overlay filesystem to copy every byte of both trees into one more layer on top of the layers that
# already held them (measured: +461 MB for that one RUN, see the report). `COPY --chown` sets
# ownership as part of the copy itself, so it never pays that doubling.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# Stage: kernal-builder -- installs kernal's own deps, then the packages
# kernal/.pi/settings.json lists (pi-mcp-adapter, pi-web-access, pi-memory, pi-subagents,
# open-codebase-index) from kernal/.pi/npm's COMMITTED lockfile. This replaces the old `pi update`
# step: `pi update` needs the pi CLI itself plus live npm registry access at build time and (see
# docs/reports/image-trim.md) was silently failing in this build environment the whole time
# (swallowed by `|| true`), leaving every image built from the old Dockerfile without any of these
# packages at all. `npm ci` against the lockfile kernal's maintainers already commit is reproducible,
# offline-friendly, and actually installs what settings.json asks for.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS kernal-builder
WORKDIR /opt/kernal
COPY kernal/package.json kernal/package-lock.json ./
RUN npm ci --omit=dev
COPY kernal/bin/ ./bin/
# MCP servers that sign in by interactive OAuth (google_admin, augment_admin) are dropped from the
# image's mcp.json: nobody can complete a browser sign-in in a sandbox and there is no keychain, so
# they failed on every start after two network probes, and pi-mcp-adapter holds the first prompt
# until its start-up connections settle (render-mcp.sh, docs/reports/startup-trim.md).
COPY kernal/.pi/mcp.json /tmp/mcp.full.json
COPY outfitter/image/render-mcp.sh /tmp/render-mcp.sh
RUN mkdir -p ./.pi && bash /tmp/render-mcp.sh /tmp/mcp.full.json /opt/kernal/.pi/mcp.json
COPY kernal/.pi/extensions/ ./.pi/extensions/
# Laptop-only kernal extensions stay out of the cloud image: kernal-voice (microphone; it also creates
# ~/.pi/agent at load and was the first thing to trip on the agent user's HOME) and kernal-update
# (checks GitHub releases at session start; a sandbox is replaced by redeploying the image), and
# kernal-admin (/admin serves a local web page for editing this machine's keys, model and index
# settings; in a sandbox nobody can open it, and a session's config comes from its guru instead),
# and kernal-codebase-index (drives open-codebase-index, which this image does not install -- see
# the npm uninstall below -- so it could only ever return early; it still cost a module load),
# and kernal-chrome. That extension talks to a unix socket the user's Chrome starts on the laptop
# (<kernal-home>/chrome.sock). A Drive has no Chrome and no native host, so its tools can only
# answer "not running". It also registers a tool named browser_capture, the same name as
# outfitter-browser.js, which is the capture tool a Drive actually uses (it asks the link API,
# and the user's Chrome takes the shot). pi refuses to start if both extensions are loaded.
# Keep outfitter-browser. Delete kernal-chrome.
# And kernal-html-preview (#132): it appends the HTML preview paragraph from the laptop's
# settings.json. In a Drive agentd appends it from the Tape instead (renderGuru), so loading it here
# could only add a second, possibly contradicting, paragraph. It also returns early under
# KERNAL_SANDBOX=1, for an image built without this line.
RUN rm -rf ./.pi/extensions/kernal-voice ./.pi/extensions/kernal-update ./.pi/extensions/kernal-admin \
           ./.pi/extensions/kernal-codebase-index ./.pi/extensions/kernal-chrome ./.pi/extensions/kernal-html-preview

# TUI/laptop-only packages (voice input, terminal footer, editor LSP) make no sense for a cloud
# guru with no terminal, no editor and no microphone attached; drop them from the image's
# settings.json only, derived from the real kernal/.pi/settings.json (see render-settings.sh) so the
# laptop install this repo ships is untouched and the two can't drift apart silently.
COPY kernal/.pi/settings.json /tmp/settings.full.json
COPY outfitter/image/render-settings.sh /tmp/render-settings.sh
RUN bash /tmp/render-settings.sh /tmp/settings.full.json /opt/kernal/.pi/settings.json

ENV PI_CODING_AGENT_DIR=/opt/kernal/.pi
COPY outfitter/image/strip-native-binaries.sh /tmp/strip-native-binaries.sh
WORKDIR /opt/kernal/.pi/npm
COPY kernal/.pi/npm/package.json kernal/.pi/npm/package-lock.json ./
# --legacy-peer-deps: these packages peer-depend on pi's own packages, which the pi binary/npm
# install under /opt/kernal provides at runtime (no copy needed) -- same flag scripts/package.sh uses
# for the identical lockfile, for the identical reason.
# recheck-jar is a JVM fallback for pi-mcp-adapter's ReDoS-safety check (`recheck`), only used when
# no native `recheck-<platform>` binary is available for the host -- one always is here (installed
# alongside it, see strip-native-binaries.sh), and this image has no `java` to run the jar with
# anyway, so it is 23 MB of dead weight.
RUN npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund --loglevel=error \
  && bash /tmp/strip-native-binaries.sh /opt/kernal/.pi/npm/node_modules "$(dpkg --print-architecture)" \
  # Uninstall (not rm -rf) so each excluded package's own dependency subtree goes with it. The list
  # follows render-settings.sh's default EXCLUDE, except voice: pi-listen is vendored (kernal/.pi/npm/
  # vendor, never copied into the image), so what's uninstalled here is its native dependency,
  # sherpa-onnx-node. The settings file only stops pi loading them.
  && npm uninstall --no-save --legacy-peer-deps --omit=dev --no-audit --no-fund --loglevel=error \
       pi-lsp pi-powerline-footer sherpa-onnx-node open-codebase-index \
  && rm -rf node_modules/recheck-jar

# pi-subagents and pi-mcp-adapter bundled (#142, #222): pi's loader evaluates each module one by
# one, and under gVisor that is a run of syscalls per module. pi-subagents' ~290 took 4-16 s of every
# sandbox start (85-90% of extension loading); pi-mcp-adapter's ~140 up to 1.7 s. Each bundle
# (<package>/bundle/) keeps every module's own import.meta.url, so their agents, prompts, runner
# scripts, keyring helper and worker resolve as before; the original files stay (some are spawned or
# loaded by path). pi-subagents is split so a subagent child process still loads only a tiny entry;
# pi-mcp-adapter is one bundle/index.ts, so jiti transpiles it with pi's aliases instead of first
# trying (and failing) a native import (bundle-pi-package.mjs, PACKAGES). esbuild is installed only
# for this step, in a throwaway directory, and never reaches the runtime image.
COPY outfitter/image/bundle-pi-package.mjs /tmp/bundle-pi-package.mjs
RUN mkdir /tmp/bundler \
  && npm install --prefix /tmp/bundler --no-save --no-audit --no-fund --loglevel=error esbuild@0.25.12 \
  && node /tmp/bundle-pi-package.mjs /opt/kernal/.pi/npm/node_modules/pi-subagents /tmp/bundler/node_modules/esbuild/lib/main.js \
  && node /tmp/bundle-pi-package.mjs /opt/kernal/.pi/npm/node_modules/pi-mcp-adapter /tmp/bundler/node_modules/esbuild/lib/main.js \
  && rm -rf /tmp/bundler /tmp/bundle-pi-package.mjs

# esbuild's per-platform optional deps (@esbuild/darwin-arm64, @esbuild/win32-x64, ...) are the
# single biggest offender in kernal's own node_modules too: `npm ci` installs every platform's binary
# (~285 MB across ~27 platforms for this one package) though only one will ever run here. Also drop
# the package's own docs/examples/changelog, never read at runtime.
RUN bash /tmp/strip-native-binaries.sh /opt/kernal/node_modules "$(dpkg --print-architecture)" \
  && rm -rf /opt/kernal/node_modules/@earendil-works/pi-coding-agent/docs \
            /opt/kernal/node_modules/@earendil-works/pi-coding-agent/examples \
            /opt/kernal/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md

# #266: pi's agent dir (.pi: settings, MCP config, extensions and their packages, and whatever pi
# writes at run time) moves out of the tree here, so the runtime stage can copy the rest of
# /opt/kernal root-owned and .pi alone agent-owned, each file still copied exactly once.
RUN mv /opt/kernal/.pi /opt/kernal-pi

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
# ngrok: the agent behind Drive previews (docs/specs/drive-previews.md, #217). agentd starts one per
# preview, binding an internal endpoint with the run's own ACL-restricted credential. From ngrok's
# signed apt repository: apt checks the repo's InRelease signature against ngrok's key (signed-by)
# and every package against the checksums in it. Pinned so a release can't change under a rebuild;
# bump NGROK_VERSION deliberately. Egress it needs (TCP 443 to ngrok's edge) is already allowed:
# deploy/gke/sandbox-template.yaml's egress rule for public addresses.
ARG NGROK_VERSION=3.39.11
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc -o /etc/apt/keyrings/ngrok.asc \
  && chmod go+r /etc/apt/keyrings/ngrok.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/ngrok.asc] https://ngrok-agent.s3.amazonaws.com bookworm main" \
       > /etc/apt/sources.list.d/ngrok.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh "ngrok=${NGROK_VERSION}" \
  && apt-get purge -y --auto-remove gnupg \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin agent

# Playwright's Chromium for the optional Tape check before checkpoint
# (guru.playwrightBeforeCheckpoint, default off). A fresh headless browser inside the Drive,
# not the user's Chrome and not the companion extension. kernal-chrome stays deleted in the
# builder stage above; this is a separate browser, used only when a guru turns the check on.
# The test runner is installed under /opt/outfitter/playwright and the browser under
# /opt/ms-playwright so a checkpoint does not download one. agentd shells out to the CLI.
# If the binary is missing at runtime the check records that and the checkpoint still runs.
# a+rX: agentd runs the browser as the unprivileged `agent` user, which must be able to
# execute a root-installed tree (755 files already would, this covers anything installed 700).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    OUTFITTER_PLAYWRIGHT_CLI=/opt/outfitter/playwright/node_modules/.bin/playwright
RUN mkdir -p /opt/outfitter/playwright \
  && printf '%s\n' '{"name":"outfitter-playwright","private":true}' > /opt/outfitter/playwright/package.json \
  && npm install --prefix /opt/outfitter/playwright playwright@1.57.0 --omit=dev --no-audit --no-fund --loglevel=error \
  && /opt/outfitter/playwright/node_modules/.bin/playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm \
  && chmod -R a+rX /opt/outfitter/playwright /opt/ms-playwright

# #266: code root runs is root's. agentd runs as root from /opt/outfitter/agentd and loads pi's own
# package from /opt/kernal/node_modules (session.ts's import, `pi --version` at boot), so neither
# tree may be writable by `agent`, the user the model's shell runs as. Only pi's agent dir is: pi
# (as `agent`) writes there, and root loads no code from it. Plain COPY is root-owned at no extra
# layer cost (the image-trim concern above).
COPY --from=kernal-builder /opt/kernal /opt/kernal
COPY --from=kernal-builder --chown=agent:agent /opt/kernal-pi /opt/kernal/.pi
COPY --from=agentd-builder /opt/outfitter/agentd /opt/outfitter/agentd

# session.ts dynamic-`import()`s @earendil-works/pi-coding-agent (SessionManager.forkFrom) at
# runtime instead of declaring it as an agentd dependency -- it's kernal's package, not agentd's, and
# only present in this image (see session.ts's comment). But Node's ESM resolver only walks up
# node_modules directories that are ANCESTORS of the importing file (dist/src/session.js under
# /opt/outfitter/agentd), and /opt/kernal is not an ancestor of /opt/outfitter, so the bare import
# would fail with ERR_MODULE_NOT_FOUND. Symlink it into agentd's own node_modules so resolution
# finds it, same as if it were a normal dependency.
RUN mkdir -p /opt/outfitter/agentd/node_modules/@earendil-works \
  && ln -s /opt/kernal/node_modules/@earendil-works/pi-coding-agent \
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

ENV PI_CODING_AGENT_DIR=/opt/kernal/.pi \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_BIN=/opt/kernal/node_modules/.bin/pi \
    WORKSPACE=/workspace \
    PI_RUN_AS_USER=agent \
    OUTFITTER_SPEND_EXTENSION=/opt/outfitter/agentd/dist/pi-extension/outfitter-spend.js \
    OUTFITTER_SPEND_FILE=/run/outfitter/spend.jsonl \
    OUTFITTER_MAIL_EXTENSION=/opt/outfitter/agentd/dist/pi-extension/outfitter-mail.js \
    OUTFITTER_BROWSER_EXTENSION=/opt/outfitter/agentd/dist/pi-extension/outfitter-browser.js \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    OUTFITTER_PLAYWRIGHT_CLI=/opt/outfitter/playwright/node_modules/.bin/playwright \
    KERNAL_NO_CODEBASE_INDEX=1 \
    KERNAL_SANDBOX=1 \
    PI_TIMING=1

# KERNAL_SANDBOX=1 is the one explicit "running in a cloud sandbox" signal (kernal's
# _shared/env.ts inSandbox()), set here and nowhere else so a laptop never sees it. With it kernal's
# extensions skip laptop-only start-up work: connect does not probe a local LM Studio or re-check the
# per-run LiteLLM key and fills its footer after pi is ready instead of before; teleport does not
# prefetch its git session store; see docs/reports/startup-trim.md.
#
# PI_TIMING=1 makes pi print its own start-up timings (each extension's import and factory time)
# to stderr once per start; agentd logs pi's stderr at DEBUG, so every wake's breakdown lands in
# Cloud Logging next to agentd's own `phase` lines. It costs one stderr write.
#
# KERNAL_NO_CODEBASE_INDEX=1: kept for older images' sake; the kernal-codebase-index extension itself
# is no longer copied in (kernal-builder stage above), since open-codebase-index is dropped on
# purpose (section 7, docs/reports/image-trim.md).
#
# kernal-report (kernal/.pi/extensions/kernal-report) is left in: at startup it only calls
# pi.registerCommand/pi.on, no network or `gh` call happens until a human actually runs /report
# inside a live session, which a headless Cloud Run Job execution never does. Its writes
# (`$PI_CODING_AGENT_DIR/bug-reports`, i.e. /opt/kernal/.pi/bug-reports) land under /opt/kernal/.pi,
# which is `COPY --chown=agent:agent` above -- writable by `agent`, the same user pi runs as -- so no
# extra directory or chmod is needed for it here. (Kernal's interactive /setup writes $PI_CODING_AGENT_DIR/../.env, i.e. the
# now root-owned /opt/kernal/.env; it needs a UI, so a Drive never runs it -- #266.) If /report is ever wired into the guru flow, gh
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
#
# Not closed by that split (finding #1, docs/reports/security-review-pr41.md): the GCE metadata
# server at 169.254.169.254 authenticates by network position, not by uid, so the `agent` user can
# still fetch the sandbox service account's identity token. Since agentd no longer leaks RUN_TOKEN/
# RUN_ID/OUTFITTER_API into pi's environment (pi.ts's baseEnvForPi), that token has no run to be
# used against -- but the reachability itself is worth removing where the platform allows it. The
# kernel can do it per-uid:
#
#   iptables -A OUTPUT -d 169.254.169.254 -m owner --uid-owner agent -j REJECT
#
# root (agentd, which needs the metadata server for getIdToken) keeps its access; everything the
# model runs loses it. Not applied here because a Cloud Run Jobs task container has no NET_ADMIN to
# install the rule with -- it belongs to a provider that can hold that capability (the GKE Agent
# Sandbox provider spec, docs/specs) or to a platform-level egress policy.

# Pre-compile every extension pi loads into jiti's file cache (/tmp/jiti), as `agent`, from the same
# paths and with the same --extension flags agentd uses, so a woken sandbox reads compiled modules
# instead of re-running Babel over ~100 of them on every start (prewarm-extensions.sh,
# docs/reports/startup-trim.md: the largest single item in pi's start-up). Must stay after every
# COPY/RUN that changes anything under /opt/kernal or the pi-extension files, and nothing may set
# TMPDIR for pi, or the cache is never found. Adds ~3 MB for /tmp/jiti, plus ~19 MB for the V8
# compile cache pi's CLI writes to /tmp/node-compile-cache (it calls module.enableCompileCache()).
COPY outfitter/image/prewarm-extensions.sh /tmp/prewarm-extensions.sh
RUN runuser -u agent -- bash /tmp/prewarm-extensions.sh "$PI_BIN" \
      --extension "$OUTFITTER_SPEND_EXTENSION" --extension "$OUTFITTER_MAIL_EXTENSION" \
      --extension "$OUTFITTER_BROWSER_EXTENSION" \
  && rm /tmp/prewarm-extensions.sh

WORKDIR /workspace

ENTRYPOINT ["node", "/opt/outfitter/agentd/dist/src/main.js"]
