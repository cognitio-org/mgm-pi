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
FROM node:24-bookworm-slim

# git/ripgrep: tools the pi agent's bash/grep tools use. ca-certificates/curl: needed for HTTPS out
# (LiteLLM, GCE metadata server, GitHub) and to fetch gh's apt key. gh: PR workflows (E6).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin agent

# ---- mgm (the pi build): /opt/mgm ----
WORKDIR /opt/mgm
COPY mgm/package.json mgm/package-lock.json ./
RUN npm ci
COPY mgm/bin/ ./bin/
COPY mgm/.pi/settings.json ./.pi/settings.json
COPY mgm/.pi/mcp.json ./.pi/mcp.json
COPY mgm/.pi/extensions/ ./.pi/extensions/

# mgm/.pi/npm (settings.json's `packages`, e.g. pi-mcp-adapter, pi-memory) is host-installed on the
# host's OS/arch and is NOT copied here -- it contains platform-specific native binaries (macOS
# builds on a dev laptop) that would not run under Linux. `pi update` reinstalls every package in
# settings.json fresh, for this image's platform. This is the one step in the image that needs
# network access, and it happens at build time only (PI_OFFLINE is set below for the runtime env,
# not this RUN step).
ENV PI_CODING_AGENT_DIR=/opt/mgm/.pi
RUN /opt/mgm/node_modules/.bin/pi update || true

# ---- agentd: /opt/outfitter/agentd ----
WORKDIR /opt/outfitter/agentd
COPY outfitter/packages/agentd/package.json ./
RUN npm install
COPY outfitter/packages/agentd/tsconfig.json ./
COPY outfitter/packages/agentd/src/ ./src/
RUN npm run build && npm prune --omit=dev

# session.ts dynamic-`import()`s @earendil-works/pi-coding-agent (SessionManager.forkFrom) at
# runtime instead of declaring it as an agentd dependency -- it's mgm's package, not agentd's, and
# only present in this image (see session.ts's comment). But Node's ESM resolver only walks up
# node_modules directories that are ANCESTORS of the importing file (dist/src/session.js under
# /opt/outfitter/agentd), and /opt/mgm is not an ancestor of /opt/outfitter, so the bare import
# would fail with ERR_MODULE_NOT_FOUND. Symlink it into agentd's own node_modules so resolution
# finds it, same as if it were a normal dependency.
RUN mkdir -p /opt/outfitter/agentd/node_modules/@earendil-works \
  && ln -s /opt/mgm/node_modules/@earendil-works/pi-coding-agent \
       /opt/outfitter/agentd/node_modules/@earendil-works/pi-coding-agent

RUN chown -R agent:agent /opt/mgm /opt/outfitter \
  && mkdir -p /workspace && chown agent:agent /workspace

ENV PI_CODING_AGENT_DIR=/opt/mgm/.pi \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_BIN=/opt/mgm/node_modules/.bin/pi \
    WORKSPACE=/workspace

USER agent
WORKDIR /workspace

ENTRYPOINT ["node", "/opt/outfitter/agentd/dist/src/main.js"]
