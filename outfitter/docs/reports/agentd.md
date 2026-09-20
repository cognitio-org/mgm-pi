# agentd / provider-local / image report

Scope: `packages/agentd`, `packages/provider-local`, `image/`, `README.md` (E1.1-E1.3). Does not
cover `packages/api` or `deploy/` (separate workstream, separate report:
`docs/reports/api.md`).

## 1. File tree

```
outfitter/
  README.md                      updated (see §2)
  image/
    Dockerfile                   fixed (see §4)
    build.sh
  packages/
    agentd/
      package.json
      tsconfig.json
      dev/fake-api.ts             dev-only stand-in for outfitter-api
      src/
        auth.ts                   GCE metadata identity token / OUTFITTER_DEV_TOKEN
        git.ts                    clone/commit/push/diff, token-URL rewrite + redaction
        guru.ts                   RunSpecGuru -> pi argv/env (pure, unit-tested)
        link.ts                   WebSocket client: seq/ack buffering, reconnect+backoff
        main.ts                   entry point, env wiring, SIGTERM registration
        pi.ts                     spawns `pi --mode rpc`, LF-only JSONL framing, session tailer
        protocol.ts                wire types mirroring docs/protocol.md
        run.ts                    RunController: the state machine, all down-message handlers
        session.ts                 session snapshot import via SessionManager.forkFrom
        workspace.ts               repo-less checkpoint/diff/restore (mtime snapshots, tar)
      test/
        fake-pi.ts, guru.test.ts, link.test.ts, pi.test.ts, run.test.ts
    provider-local/
      package.json, tsconfig.json
      src/
        index.ts, types.ts
        local-docker.ts            `docker run` provider (dev/prod-shaped)
        in-process.ts              spawns agentd as a plain child process (tests, no-Docker smoke)
      test/in-process.test.ts
```

## 2. README changes

`outfitter/README.md` already covered layout, host-against-fake-api, and the Docker build
command accurately. Two gaps found while running the smokes below were fixed, kept short:

- **`/workspace` path mismatch on host.** `run.spec.session.cwd` is always the literal string
  `"/workspace"` (protocol.md's `RunSpecSession.cwd` type), matching the sandbox image's real
  `WORKSPACE=/workspace`. On the host, `WORKSPACE` is whatever scratch directory you point it at,
  so a prompt telling the agent to write to an absolute `/workspace/...` path resolves against the
  host's real (nonexistent/unwritable) `/workspace`, not your scratch dir. Documented as a caveat
  with a pointer to testing inside the image instead.
- **Container against `dev/fake-api`.** Added the `host.docker.internal` + `WORKSPACE_SNAPSHOT_DIR`
  volume-mount recipe for driving a containerized agent against the host's fake-api with no real
  control plane — this is what made §3.4 (Docker smoke B) possible and wasn't documented before.

## 3. Test summary

`npm test` from `outfitter/` (this run, after the Dockerfile fix in §4 — no `src/` changes, so
counts are unchanged from before this session):

```
@outfitter/agentd:         30 tests, 30 pass, 0 fail
@outfitter/api:             33 tests, 33 pass, 0 fail   (another agent's workstream, unmodified)
@outfitter/provider-local:   2 tests, 2 pass, 0 fail
```

`@outfitter/agentd`'s 30 = renderGuru/renderModelArg (8) + Link (8) + JSONL framing/SessionTailer
(7) + RunController (7).

## 4. Bug found and fixed: image can't resolve `@earendil-works/pi-coding-agent`

`session.ts` dynamically `import()`s `@earendil-works/pi-coding-agent` at runtime (for
`SessionManager.forkFrom`) instead of declaring it as an `agentd` dependency, since it's mgm's
package and only present inside the sandbox image (deliberate, per the file's own comment).

But the import **could never succeed** as the image was laid out. Node's ESM resolver looks for a
bare specifier by walking up `node_modules` directories that are *ancestors of the importing
file*. The importing file is `/opt/outfitter/agentd/dist/src/session.js`; its ancestor chain is
`/opt/outfitter/agentd`, `/opt/outfitter`, `/opt`, `/` — none of which is `/opt/mgm`, where the
package actually lives (`/opt/mgm/node_modules/@earendil-works/pi-coding-agent`). Every session
restore (`begin()` calls `importSession` unconditionally, repo or repo-less) hit
`ERR_MODULE_NOT_FOUND` and the run died immediately after `run.spec`:

```
[driver] <- {"t":"status","state":"restoring"}
[driver] <- {"t":"bye","reason":"error","message":"Cannot find package '@earendil-works/pi-coding-agent'
  imported from /opt/outfitter/agentd/dist/src/session.js"}
```

`NODE_PATH` does not fix this (it's CJS-only, not consulted by the ESM resolver, and `agentd` is
`"type": "module"`). Fixed in `image/Dockerfile` by symlinking the package into agentd's own
`node_modules` right after both are built, so normal ancestor-walk resolution finds it:

```dockerfile
RUN mkdir -p /opt/outfitter/agentd/node_modules/@earendil-works \
  && ln -s /opt/mgm/node_modules/@earendil-works/pi-coding-agent \
       /opt/outfitter/agentd/node_modules/@earendil-works/pi-coding-agent
```

Verified fixed: after rebuilding, the same run.spec completes a full turn, checkpoint, and diff
inside the container (§3.4).

## 5. Smoke A — coding session (host, against `dev/fake-api`)

Host, real `pi` install: `PI_BIN=/Users/mgm/localllm/mgm/node_modules/.bin/pi`,
`PI_CODING_AGENT_DIR=/Users/mgm/localllm/mgm/.pi`. Repo: a throwaway local git repo (`git init`,
one commit) at `file://<scratch>/smoke-a-repo`, `guru.model: "litellm/local-qwen-mlx"`,
`secrets.litellmKey` = `LITELLM_AGENT_KEY` from `~/localllm/.env`. `litellm/local-qwen-mlx` was
reachable directly (`curl .../chat/completions` returned `"pong"` in 0.58s before running the
smoke), so the fallback to `litellm/claude-auto-llm` was not needed.

Driven with a small scriptable test harness (`node driver.mjs <run-spec> <port> <script.json>`,
not part of the package, not committed) instead of `dev/fake-api.js`, so a protocol-level `stop`
down-message could be sent after the reply — `dev/fake-api.js` only auto-sends one prompt on first
idle and has no way to script a follow-up message, which the checkpoint verification needs (see
§6). `RUN_ID=smoke-run-a4`, `WORKSPACE=<scratch>/smoke-a-workspace`.

Full captured exchange (every frame both directions; secrets redacted):

```
<- {"t":"hello","runId":"smoke-run-a4","sessionId":"","agentdVersion":"0.1.0","piVersion":"0.85.1","lastAckedSeq":0}
-> {"t":"run.spec","session":{"id":"smoke-a-1","name":"smoke A coding session","cwd":"/workspace"},
    "repo":{"cloneUrl":"file:///.../smoke-a-repo","branch":"outfitter/smoke-a-1","baseBranch":"main","createBranch":true},
    "guru":{"model":"litellm/local-qwen-mlx","thinking":"off"},"snapshot":{},
    "secrets":{"litellmKey":"<redacted>"},"idleStopSeconds":3600,"checkpointEvery":"turn"}
<- {"t":"status","state":"cloning"}
<- {"t":"status","state":"restoring"}
<- {"t":"status","state":"starting"}
<- {"t":"status","state":"idle"}
-> {"t":"prompt","text":"reply with the single word pong"}
<- {"t":"event","seq":1..16, ...}           # setStatus/setWidget UI events (powerline, budget, mcp, etc.), acked
<- {"t":"entry","seq":2,"entry":{"type":"model_change","provider":"litellm","modelId":"local-qwen-mlx"}}
<- {"t":"entry","seq":3,"entry":{"type":"thinking_level_change","thinkingLevel":"off"}}
<- {"t":"event","seq":17,"event":{"type":"agent_start"}}
<- {"t":"status","state":"running"}
<- {"t":"event","seq":18,"event":{"type":"turn_start"}}
<- {"t":"entry","seq":21,"entry":{"type":"message","message":{"role":"user","content":[{"type":"text","text":"reply with the single word pong"}]}}}
<- {"t":"event","seq":23..27, message_start/message_update(text_delta:"pong")/message_end}
<- {"t":"event","seq":29,"event":{"type":"turn_end", assistant message content: "pong"}}
<- {"t":"event","seq":32,"event":{"type":"agent_end", ...}}
<- {"t":"event","seq":33,"event":{"type":"agent_settled"}}
<- {"t":"status","state":"idle"}
-> {"t":"stop","reason":"smoke test explicit stop"}
<- {"t":"status","state":"checkpointing"}
<- {"t":"entry","seq":34,"entry":{"type":"message", assistant "pong"}}
<- {"t":"heartbeat","idleSeconds":0,"memMb":64}
<- {"t":"checkpoint","branch":"outfitter/smoke-a-1","head":"5341c50f9ddc99b3b62d4abaac07267d9c144714","pushed":true}
<- {"t":"status","state":"stopping"}
<- {"t":"bye","reason":"stop","message":"smoke test explicit stop"}
```

pi replied `pong` in one turn; `git log outfitter/smoke-a-1` on the origin repo shows the pushed
commit at that head. Process exited 0.

## 6. Smoke B — non-coding session, checkpoint + diff

No `repo` in `run.spec`; prompt `"write a haiku about tunnels into /workspace/haiku.txt"`, then a
`checkpoint` and `diff` down-message once idle, `WORKSPACE_SNAPSHOT_DIR` set to a scratch dir.

**Host run first** (`RUN_ID=smoke-run-b`): hit exactly the `/workspace` path-mismatch caveat now
documented in the README (§2) — real `/workspace` doesn't exist on this Mac (`WORKSPACE` was a
scratch dir), so the model's absolute-path `write` call failed:

```
<- {"t":"event","...,"type":"tool_execution_end","toolName":"write",
    "result":{"content":[{"type":"text","text":"ENOENT: no such file or directory, mkdir '/workspace'"}]},"isError":true}}
```

pi adapted (explored the filesystem, wrote to `/Users/mgm/localllm/mgm/workspace/haiku.txt`
instead — **a stray file this session could not remove**: the sandbox's destructive-action
classifier blocked `rm -rf`/`rmdir` on it; please delete
`/Users/mgm/localllm/mgm/workspace/` by hand). `checkpoint` still worked (`workspaceUrl` tarball
produced, containing nothing since nothing changed inside the real tracked `WORKSPACE`), but
`diff.result` correctly reported `"files":[]` — nothing changed in the tracked directory, which is
the right answer given where the file actually landed.

**Re-run inside the Docker image** (`RUN_ID=smoke-run-b-docker2`, after the Dockerfile fix in §4,
driver on the host at `host.docker.internal:8797`, `-v <scratch>/snapshots:/snapshots -e
WORKSPACE_SNAPSHOT_DIR=/snapshots`) — here `/workspace` is real, so this is the clean pass:

```
<- {"t":"hello","runId":"smoke-run-b-docker2",...}
-> {"t":"run.spec","session":{"id":"smoke-b-1","cwd":"/workspace"},
    "guru":{"model":"litellm/local-qwen-mlx","thinking":"off"},"snapshot":{},
    "secrets":{"litellmKey":"<redacted>"},"idleStopSeconds":3600,"checkpointEvery":"turn"}
<- {"t":"status","state":"restoring"}
<- {"t":"status","state":"starting"}
<- {"t":"status","state":"idle"}
-> {"t":"prompt","text":"write a haiku about tunnels into /workspace/haiku.txt"}
<- {"t":"status","state":"running"}
...
<- {"t":"event","...,"type":"tool_execution_end","toolName":"write",
    "result":{"content":[{"type":"text","text":"Successfully wrote to /workspace/haiku.txt"}]},"isError":false}}
<- {"t":"event","...,"type":"turn_end", assistant: haiku text + toolCall to write}
<- {"t":"event","...,"type":"agent_end"}}
<- {"t":"event","...,"type":"agent_settled"}}
<- {"t":"status","state":"idle"}
-> {"t":"checkpoint"}
-> {"t":"diff","reqId":"diff-1"}
<- {"t":"status","state":"checkpointing"}
<- {"t":"diff.result","reqId":"diff-1","files":["haiku.txt"]}
<- {"t":"checkpoint","workspaceUrl":"/snapshots/smoke-b-1-1789908718307.tar.gz"}
<- {"t":"status","state":"idle"}
```

Confirmed: `tar -tzf smoke-b-1-*.tar.gz` lists `./haiku.txt`; its content is the haiku pi wrote
("Dark passage ahead, / Stone walls echo footsteps, / Light at journey's end."). `diff.result`
correctly lists `["haiku.txt"]`.

Then `docker stop -t 12` (SIGTERM, the same path Cloud Run uses) on that same container produced a
second checkpoint and a clean shutdown:

```
<- {"t":"heartbeat","idleSeconds":14,"memMb":155}
<- {"t":"status","state":"checkpointing"}
<- {"t":"checkpoint","workspaceUrl":"/snapshots/smoke-b-1-1789908739806.tar.gz"}
<- {"t":"status","state":"stopping"}
<- {"t":"bye","reason":"sigterm"}
```

Container exit code 0, `FinishedAt` sane, no OOM.

## 7. Docker build and run

```
docker build -f outfitter/image/Dockerfile -t outfitter-agent .   # from the repo root
```

Builds successfully. Image size: **2.16 GB** (`docker images outfitter-agent`). Most of that is
`node:24-bookworm-slim` + apt packages (git, ripgrep, gh, ca-certificates) + the full `mgm/`
install including `pi update`'s npm packages (pi-mcp-adapter, pi-web-access, pi-subagents,
pi-powerline-footer, pi-memory, open-codebase-index, pi-lsp, @codexstar/pi-listen) — worth a
follow-up look at trimming (e.g. whether every mgm package listed in `settings.json` needs to ride
along in the agent image) but out of scope for this report.

```
docker run --entrypoint /opt/mgm/node_modules/.bin/pi outfitter-agent --version
```
→ `0.85.1`. Exit 0.

## 8. Deviations from `docs/protocol.md`

None found beyond the two already documented in source comments (`guru.packages` has no pi CLI
equivalent, rendered to `OUTFITTER_GURU_PACKAGES` env for a future settings-patch step; `ui_response`'s
generic `{id, value}` maps onto pi's tri-state `extension_ui_response` shape by type-sniffing
`value`). Every up/down message exercised in the smokes (`hello`, `status`, `entry`, `event`,
`heartbeat`, `checkpoint`, `bye`; `run.spec`, `prompt`, `stop`, `checkpoint`, `diff`) matched the
doc's shapes exactly.

One process-level anomaly worth recording even though it isn't a protocol deviation: sending a
single `kill -TERM` to the host `node packages/agentd/dist/src/main.js` process directly from this
sandboxed CLI session's Bash tool (not via `docker stop`, not via the Cloud Run path) reliably
truncated the shutdown sequence — `status: checkpointing` was sent and then the process vanished
(shell-reported exit code 143, "terminated by SIGTERM", not `process.exit(0)`), never reaching
`stopping`/`checkpoint`/`bye`. Traced with instrumented `dist/src/run.js` (reverted after, rebuilt
clean): execution reached `await Promise.race([this.checkpointNow(), delay(this.sigtermBudgetMs)])`
and never returned, well before the 8s budget could have elapsed. Ruled out as an agentd bug by two
independent checks: (a) a minimal standalone Node script with the identical
`process.once('SIGTERM', ...)` → async work → `process.exit(0)` pattern, run the same way, shut
down cleanly every time; (b) `docker stop` sending the *same* signal to the *same compiled code*
running as the container's PID 1 (§6, §7) worked exactly as protocol.md specifies —
`checkpointing` → `checkpoint` → `stopping` → `bye(sigterm)` → exit 0. Conclusion: this is an
artifact of this CLI's sandboxed process supervision around backgrounded shell commands, not a
defect in `RunController.handleSigterm`. Flagging it only because Cloud Run's SIGTERM path
(protocol.md's `sigtermBudgetMs` contract) is exactly what this would have cast doubt on if
left unmentioned — it's verified working via the container path instead.

## 9. Known gaps / follow-ups (not fixed here, out of scope for this pass)

- Image size (2.16 GB) — worth investigating whether the full mgm package set needs to ship in the
  agent image.
- `guru.packages` → `OUTFITTER_GURU_PACKAGES` is rendered but nothing on the agentd or image side
  consumes it yet (needs the api-side settings-patch step noted in `guru.ts`).
- Stray file from the host smoke B run needs manual cleanup:
  `/Users/mgm/localllm/mgm/workspace/` (this session's sandbox denied `rm -rf`/`rmdir` on it as an
  "Irreversible Local Destruction").
