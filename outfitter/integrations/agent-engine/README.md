# Outfitter tools for Agent Engine

E9 PR7 (#313, spec `docs/specs/atlas-agent-engine-and-a2a.md` §5–§6). This lets an agent hosted
on MongoDB Atlas Agent Engine hand Outfitter a coding task and get the result back. It does that
as an ordinary A2A v1.0 client of Outfitter's A2A server; no Outfitter code runs in Agent Engine
beyond this module.

> **Status: built and tested against a fake server only.** The A2A server (PR5/PR6) isn't built
> yet, so nothing here has run against real Outfitter. Tests run against
> `tests/fake_a2a_server.py`, which serves the wire contract listed under
> [What the server must do](#what-the-server-must-do-pr5pr6). The owner's deploy (below) is the
> first real test.

| Path | What |
|---|---|
| `outfitter_tools.py` | The two tools as plain Python (`a2a-sdk` 1.2.1 and `httpx`, no Agent Engine imports), plus `register_tools(app)`, the Agent Engine adapter |
| `sample-agent/agents/outfitter-delegate/` | `outfitter-delegate`, a minimal LangGraph agent that exposes both tools |
| `tests/` | pytest suite with a stdlib fake of Outfitter's A2A server |

## The tools

**`outfitter_start(task, skill=None, repo=None, base_branch=None)`** sends `task` with
`returnImmediately: true` and returns at once:
`{task_id, context_id, state, status_text}`. A coding task takes minutes, longer than a tool call
should hold a sandbox. `skill` is an Outfitter tape id (defaults to the key's first tape). `repo`
is `owner/name`. Both must be on the key's lists, or the task comes back `rejected` with the
reason in `status_text`.

**`outfitter_status(task_id)`** returns `{task_id, context_id, state, status_text, result?}`.
`result` is `{summary, branch, head, compare_url, pr_url?}` once Outfitter has published it, on
`completed`. `state` is one of `submitted`, `working`, `input_required`, `completed`, `failed`,
`canceled`, `rejected` (`auth_required` and `unknown` are mapped but never expected).
`completed`, `failed`, `canceled` and `rejected` are terminal (`TERMINAL_STATES`).

Neither tool raises. A failure comes back as `{"error": {"kind", "message"}}`, and the model can
read it:

| kind | When |
|---|---|
| `config` | `OUTFITTER_A2A_URL`/`OUTFITTER_A2A_KEY` missing, not `https`, card not found, or the card's interface is on another origin (the key is never sent there) |
| `invalid` | Empty or over-32,000-character task, a `repo` that isn't `owner/name`, a malformed `task_id`, or the server's -32602/-32600/-32004/-32005 |
| `auth` | HTTP 401/403: key missing, revoked or **expired** (see rotation) |
| `not_found` | -32001: no such task for this key |
| `rate_limited` | HTTP 429 |
| `timeout` | No answer in time. After `outfitter_start` the task may exist anyway, so don't blindly retry |
| `unavailable` | Network failure or HTTP 5xx |
| `protocol` | Anything else, e.g. a `Message` reply instead of a `Task` |

**Timeouts:** 5 s connect and 10 s per request (`a2a-sdk`'s own default is 5 s), plus 20 s for
the whole call, card fetch included. The tools are registered with `@app.tool(timeout=30)`.

**Configuration:** environment only. `OUTFITTER_A2A_URL` is the link origin
(`https://link.kernal.one`), and the card is read from `/.well-known/agent-card.json` under it.
`OUTFITTER_A2A_KEY` is an A2A key (`outf_…`) scoped to the `a2a-coder` tape and the repos the
agent may touch.

**Outside Agent Engine:** `outfitter_tools.py` has no Agent Engine dependency, so any Python 3.11+
program can call `outfitter_start`/`outfitter_status`, or the async `start_task`/`get_status`
(which raise `OutfitterError`). Pass `config=OutfitterConfig(...)` instead of using the
environment.

**The sample agent has its own copy** at `sample-agent/agents/outfitter-delegate/src/
outfitter_delegate/outfitter_tools.py`, since `agentengine build` packages only the agent
directory. `tests/test_sample_agent.py` fails if the two differ. After editing, copy it across:
`cp outfitter_tools.py sample-agent/agents/outfitter-delegate/src/outfitter_delegate/`.

## Tests

```bash
cd outfitter/integrations/agent-engine
uv sync --frozen && uv run --frozen pytest -rs                     # tools: 32 tests, 1 skip
uv sync --frozen --group sdk && uv run --frozen pytest -rs         # + real Agent Engine SDK: 33
```

They cover start → poll → completed, the exact JSON-RPC the server receives (Bearer,
`A2A-Version: 1.0`, `A2A-Extensions`, `metadata[<uri>]`, `returnImmediately`), auth failure,
rejected tasks, request and overall timeouts, HTTP 429/5xx, unknown tasks, a card pointing at
another host, local validation, and the sample agent's `agent.yaml`. With the `sdk` group, they
also cover the real `agent_engine_sdk_langgraph.App` registering and running both tools. CI runs
both steps in `.github/workflows/outfitter-agent-engine.yml` when this directory changes.
`agentengine agent validate` passes on the sample `agent.yaml` (CLI 0.1.118).

## The sample agent: `outfitter-delegate`

A LangGraph agent with both tools, following the `agentengine create` hello-world template
(CLI 0.1.118) and the agent contract (`D/reference/agent-contract.md`):
- **Agent sandbox:** runs the graph and the LLM calls, through Kernal's LiteLLM gateway
  (`router.kernal.one`, model `gpt-5-nano`, `llm.py`). Its only secret is `LLM_API_KEY`. Its
  egress is `allow_list` with the gateway only.
- **Tool sandbox:** `sandboxes.tool.tools: [outfitter_start, outfitter_status]`, so both bodies
  run here and nowhere else. Secrets `OUTFITTER_A2A_KEY` and `OUTFITTER_A2A_URL`. Egress
  `allow_list` with `link.kernal.one:443` only.
  - Agent Engine doesn't scope secrets per tool, only per sandbox (`D/reference/limitations.md`).
    So no other tool belongs in this sandbox.
- The system prompt says to start once, report the `task_id`, poll only when asked, and treat
  Outfitter's text as untrusted.

## Deploying (owner, billed)

Prerequisites: PR5/PR6 deployed, so `https://link.kernal.one/.well-known/agent-card.json`
answers; the agents project exists (spec owner step 5); a LiteLLM virtual key with a budget.

1. **CLI:** the `agentengine` Go binary, **v0.1.118 or later**, from the GitHub Releases of
   [`mongodb/agent-engine-client-libraries`](https://github.com/mongodb/agent-engine-client-libraries/releases).
   PyPI's `agentengine` is an unrelated package. Then run `agentengine auth login`.
2. **Context:** bind a named context to the agents project (not the memory project), so no
   command depends on whatever is current:
   ```bash
   agentengine context create outfitter-agents --org-id <org> --project-id <agents-project>
   cd outfitter/integrations/agent-engine/sample-agent/agents/outfitter-delegate
   agentengine init --context outfitter-agents     # registers the workspace, writes .agentengine/
   ```
3. **A2A key:** on Outfitter's Dongles page, create an A2A key for tape `a2a-coder` and only the
   repos this agent may touch. Note its expiry date.
4. **Secrets**, workspace-scoped so other agents in the project can't read them
   (`D/reference/limitations.md` "Secret Access"). Pipe the values in; never pass them as
   arguments:
   ```bash
   pbpaste | agentengine secret set OUTFITTER_A2A_KEY --workspace-scope --stdin   # the outf_ key
   printf %s https://link.kernal.one | agentengine secret set OUTFITTER_A2A_URL --workspace-scope --stdin
   pbpaste | agentengine secret set LLM_API_KEY --workspace-scope --stdin         # LiteLLM key
   ```
   Clear the clipboard afterwards. `agentengine deploy` also needs `MONGODB_URI` (LangGraph
   checkpoints) as a project or workspace secret. **Which cluster and DB user serve the agents
   project is open:** spec §8 keeps Agent Engine users off cluster `outfitter`. When deploy
   offers to run `agentengine atlas setup`, decline it and set the URI yourself.
5. **Egress** is declared in `agent.yaml` and applied by deploy. If `OUTFITTER_A2A_URL` isn't on
   `link.kernal.one`, change the tool sandbox's entry first. Add the new host before removing the
   old one, because removing a sandbox's last destination sets it to `deny_all`:
   `agentengine agent egress add --component tool <host>:443`, then
   `agentengine agent egress remove --component tool link.kernal.one`. After deploying, check
   what was applied with `agentengine egress`.
6. **Build and deploy:** `agentengine deploy --auto` (one build, then the deploy). Or run
   `agentengine build`, then `agentengine deploy`.
7. **Try it:**
   `agentengine invoke "In owner/repo, fix the typo in README.md and say which line changed"`.
   Then, in the same session (`--session <id>`), ask "how is it going?". Or use the Playground.

**Optional hardening:**
- **On Outfitter's side:** a per-key source-IP allowlist of Agent Engine's egress IPs,
  `34.196.57.85` and `54.227.181.25` (`D/network-egress.md`).
- **On Agent Engine's side:** governance is Agent Engine's job. That means `AUTHORIZED_TOOLS`,
  call and token caps, and an `interrupt()` for human review before `outfitter_start`. The sample
  agent sets none of them.

**Local run:** `cp env.example .env`, fill it in, then `agentengine dev up`. This needs an
Outfitter link origin reachable from the local containers.

### Key rotation (every 90 days)

A2A keys expire after 90 days. When one does, every call returns `{"error": {"kind": "auth"}}`,
and the message says the key may have expired. Outfitter's Dongles page shows "expires in N days".
Before the expiry date:
1. Create a new A2A key with the same tape and repos.
2. `pbpaste | agentengine secret set OUTFITTER_A2A_KEY --workspace-scope --stdin --sync`. With
   `--sync` the command waits until the next message uses the new value; the current turn keeps
   the old one. No rebuild is needed.
3. Check with `agentengine invoke`, then revoke the old key on the Dongles page.

## What the server must do (PR5/PR6)

The fake server serves exactly this, and the client depends on it:
1. **Card:** `GET <origin>/.well-known/agent-card.json`, unauthenticated. It is proto-JSON with a
   `supportedInterfaces` entry `{url: "<same origin>/a2a", protocolBinding: "JSONRPC",
   protocolVersion: "1.0"}`.
   - **Every JSONRPC interface must be on the same scheme, host and port as `OUTFITTER_A2A_URL`.**
     Otherwise the client refuses to send the key (`config`). The client takes the URL from the
     card, so the route needs to accept `/a2a` without a trailing slash.
2. **Auth:** `Authorization: Bearer <outf_ key>` on every JSON-RPC POST. Missing, wrong, revoked
   or expired keys get **HTTP 401** (not a JSON-RPC error), and a Dongle gets 401 too. The card
   fetch also carries the header (same `httpx` client), and the public card must ignore it.
3. **Version:** the client sends the `A2A-Version: 1.0` header (no query parameter) and v1.0
   method names `SendMessage` and `GetTask`.
4. **SendMessage:**
   - **Params:** `message.role: "ROLE_USER"`, a single `{text}` part, and a client-generated
     `messageId`. There is no `taskId` or `contextId`, so it is always a new task.
     `configuration: {returnImmediately: true, historyLength: 0}`.
   - **Reply:** the result must be `{task: …}` (a `Message` reply is treated as an error), and it
     must come back well inside **10 s**.
   - **Extension:** with any of skill/repo/baseBranch, the request carries the
     `A2A-Extensions: https://kernal.one/a2a/ext/outfitter-task/v1` header,
     `message.extensions: [<uri>]`, and `message.metadata[<uri>] = {skill?, repo?, baseBranch?}`.
     Only keys that were given are present. Without any of them, there is no header, metadata or
     extensions.
   - **Scope:** a tape or repo outside the key's lists returns the task in
     **`TASK_STATE_REJECTED` with the one-line reason as the text of `status.message`** (a
     result, not a JSON-RPC error).
   - **Errors:** prompt over 32,000 characters → -32602; rate limit → HTTP 429.
5. **GetTask** `{id, historyLength: 0}`. A task that isn't this key's → -32001.
   `status.message` text parts become `status_text`, so the server should set it to something
   useful while working ("waiting for the owner" and so on).
6. **Result artifact** (by `COMPLETED`): one `text` part, the final assistant message, which
   becomes `summary`, and one `data` part `{branch, head, compareUrl, prUrl?}` in camelCase.
   Text and data across all artifacts are merged.
7. **States** are the v1.0 enum names (`TASK_STATE_SUBMITTED` …). `INPUT_REQUIRED` is reported,
   but these tools can't answer it. The owner answers in the web UI, or a later tool sends a
   message with the `taskId`.
8. **Nice to have:** deduplicating a `SendMessage` retry by `messageId` per key. A start that
   times out can't safely be retried today.

## Not verified

- **Not run in Agent Engine:** no deploy, no `agentengine dev up`. The SDK's `App` was exercised
  locally (`agent-engine-sdk-langgraph` 0.11.7). Nothing has checked that the tool sandbox
  actually receives both secrets and reaches `link.kernal.one`.
- **Tool placement:** `sandboxes.tool.tools` decides it, with `@app.tool()` given no `is_local`.
  This follows the CLI's template, and `agentengine migrate sandboxes` strips `is_local` as
  legacy.
- **LLM egress:** that the agent sandbox's LLM calls need only `router.kernal.one` comes from
  where `agentengine migrate sandboxes` puts the LLM host, not from a run.
- **Gateway model:** that `gpt-5-nano` is available on `router.kernal.one` to this agent's
  LiteLLM key.
