# Outfitter

Self-hosted cloud agent fleet: `agentd` runs `pi` (the kernal coding agent) inside a sandbox and talks
to an `outfitter-api` control plane over WebSocket. See `EPIC.md` for the full plan and
`docs/protocol.md` for the wire contract this package implements.

## Layout

```
outfitter/
  EPIC.md                    epic plan (architecture, cost model, roadmap)
  docs/
    protocol.md               agentd <-> api wire contract (the source of truth)
    reports/agentd.md          build/test/e2e report for the agentd side (E1.1-E1.3)
  image/
    Dockerfile                 the outfitter-agent sandbox image (kernal + agentd)
    build.sh                   docker build wrapper (repo root as context)
  packages/
    agentd/                    TypeScript daemon: dials the api, clones/restores a workspace,
                                runs `pi --mode rpc`, streams events, checkpoints
    provider-local/             SandboxProvider: LocalDockerProvider (dev) + InProcessProvider (tests)
    api/                        control-plane API (separate workstream; not covered here)
```

## Run agentd locally

Two ways: inside the Docker image (closest to production), or directly on the host against a real
pi install (fastest iteration).

### Against `dev/fake-api`, on the host

`packages/agentd/dev/fake-api.ts` is a ~100-line WebSocket server standing in for `outfitter-api`: it
serves a `run.spec` from a JSON file and prints every frame agentd sends. Useful for driving a full
turn end to end without any GCP setup.

```bash
cd outfitter
npm install
npm run build --workspace=@outfitter/agentd

# 1. write a run-spec.json (see packages/agentd/src/protocol.ts for the RunSpec shape); a minimal
#    repo-having one:
cat > /tmp/run-spec.json <<'EOF'
{
  "session": { "id": "dev-sess-1", "name": "dev smoke", "cwd": "/workspace" },
  "repo": { "cloneUrl": "file:///path/to/a/local/git/repo", "branch": "outfitter/dev-sess-1", "baseBranch": "main", "createBranch": true },
  "guru": { "model": "litellm/local-qwen-mlx", "thinking": "off" },
  "snapshot": {},
  "secrets": { "litellmKey": "<your LITELLM_AGENT_KEY from ~/localllm/.env>" },
  "idleStopSeconds": 3600,
  "checkpointEvery": "turn",
  "prompt": "reply with the single word pong"
}
EOF
# (repo-less sessions: omit "repo", optionally add "workspace": { "snapshotUrl": "<tar.gz path or URL>" })

# 2. start the fake api
node packages/agentd/dist/dev/fake-api.js /tmp/run-spec.json 8787

# 3. in another shell, run agentd against it, pointed at a real pi install
OUTFITTER_API=http://localhost:8787 \
RUN_ID=dev-run-1 \
OUTFITTER_DEV_TOKEN=dev-token \
WORKSPACE=/tmp/outfitter-dev-workspace \
PI_BIN=/path/to/kernal/node_modules/.bin/pi \
PI_CODING_AGENT_DIR=/path/to/a/pi/config/dir \
node packages/agentd/dist/src/main.js
```

`fake-api` sends `run.spec` on `hello`, acks every `entry`/`event` frame, and -- once agentd reports
its first `idle` status -- sends the JSON file's `prompt` field down as a `prompt` message, so a whole
turn runs without touching a real outfitter-api. See `docs/reports/agentd.md` for a captured run.

`PI_CODING_AGENT_DIR` needs a `settings.json` and an `extensions/connect` (kernal's LiteLLM/LM Studio
provider extension) to resolve `litellm/...` model ids; point it at a real kernal `.pi/` directory, or a
trimmed copy of one.

Host testing has one gap: `run.spec.session.cwd` is always the literal string `"/workspace"` (that's
what the sandbox image sets `WORKSPACE` to), but on the host `WORKSPACE` is whatever scratch directory
you pointed it at. A repo-less prompt that tells the agent to write to an absolute `/workspace/...`
path will hit the host's real (usually nonexistent, unwritable) `/workspace` instead of your scratch
dir. Prompts using relative paths are unaffected; for absolute-`/workspace` prompts, test inside the
image instead (below), where `/workspace` is real.

### Inside the image

```bash
./image/build.sh   # docker build -f image/Dockerfile -t outfitter-agent . (from the repo root)

docker run --rm \
  -e OUTFITTER_API=https://your-api \
  -e RUN_ID=<run-id> \
  -e OUTFITTER_DEV_TOKEN=<dev-token>   # local dev only; real runs use the GCE metadata identity token
  outfitter-agent
```

`WORKSPACE`, `PI_BIN`, and `PI_CODING_AGENT_DIR` are already set correctly inside the image (see
`image/Dockerfile`). `LocalDockerProvider` in `packages/provider-local` runs exactly this `docker run`
shape for local development against a real control plane.

To drive a containerized agent against `dev/fake-api` (no real control plane needed, and `/workspace`
is real), run the fake api on the host and point the container at it via Docker Desktop's host
gateway, mounting a directory for `WORKSPACE_SNAPSHOT_DIR` if you want to inspect repo-less checkpoint
tarballs:

```bash
node packages/agentd/dist/dev/fake-api.js /tmp/run-spec.json 8787   # on the host, as above

docker run --rm \
  -e OUTFITTER_API=http://host.docker.internal:8787 \
  -e RUN_ID=dev-run-1 \
  -e OUTFITTER_DEV_TOKEN=dev-token \
  -e WORKSPACE_SNAPSHOT_DIR=/snapshots -v /tmp/outfitter-snapshots:/snapshots \
  outfitter-agent
```

## Tests

```bash
npm test    # from outfitter/, runs every workspace package's `test` script
```

`packages/agentd`'s tests build with `tsc` then run with node's built-in test runner
(`node --test dist/test/`); no test framework dependency. The run-state-machine tests spawn a tiny
fake `pi` process (`packages/agentd/test/fake-pi.ts`) that speaks a subset of `docs/rpc.md`'s RPC
protocol instead of a real pi install.
