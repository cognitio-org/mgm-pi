# Security Review — PR #41 follow-up: sandbox token isolation

**Scope:** the agentd ⇄ api trust boundary inside the sandbox — `packages/agentd/src/pi.ts`
(`baseEnvForPi`), `packages/agentd/src/main.ts`, `packages/api/src/agentlink.ts`
(`handleConnection` / `buildRunSpec`), and the sandbox image's two-user split
(`image/Dockerfile`, `packages/agentd/src/run-as-user.ts`).

**Origin:** found by the security review of
[PR #41](https://github.com/mgmonteleone/mgm-pi/pull/41) (see that PR's "Review record" comment).
The defect is **pre-existing** — it predates PR #41 and was not introduced by it.

**Risk Level:** CRITICAL (full compromise of the run's GitHub token and LiteLLM key by the model
itself, plus takeover of the run's control channel).

## Summary
- Critical Issues: 1 (fixed here)
- Hardening follow-ups: 2 (one done, one documented for the image — see §3)

---

## Critical Issues

### 1. pi's environment carried `RUN_TOKEN`, so the model could mint its own agent connection and read the run's secrets

**Severity:** CRITICAL
**Category:** A01 (Broken access control — trust-boundary bypass) / A02 (secrets exposure) /
A05 (security misconfiguration: denylist where an allowlist was required)

**Location (before the fix):**
- `packages/agentd/src/pi.ts` — `baseEnvForPi()` copied **all** of agentd's `process.env` minus
  `GIT_CONFIG_*`, and `spawnPi` spread that into the pi child's env.
- `packages/agentd/src/main.ts` — read `RUN_TOKEN` / `OUTFITTER_DEV_TOKEN` and left them in
  `process.env` for the life of the process.
- `packages/api/src/providers/cloudrun.ts:93-95` — sets `RUN_ID`, `RUN_TOKEN` and `OUTFITTER_API`
  as container-override env vars on the Cloud Run Job execution, i.e. on agentd's own env.
- `packages/api/src/agentlink.ts` — `handleConnection` accepted any connection presenting a valid
  run token, sent it `run.spec`, and overwrote `this.sockets` for that run.

**Why the sandbox is supposed to stop this:** finding #1 of `security-review-pr1.md` split the
image into two Linux users precisely so the model cannot reach agentd's credentials — agentd (and
its `git` children) run as root, `pi` and every command the model's shell tool runs are spawned as
the unprivileged `agent` user, so root's `/proc/<pid>/environ` is unreadable to the model.

**The hole:** that split is worthless if agentd *hands* the credentials to pi. `RUN_TOKEN`,
`RUN_ID` and `OUTFITTER_API` were copied straight into pi's environment, so a single `printenv` in
the model's shell yielded a complete run-takeover kit:

1. `curl -H 'Metadata-Flavor: Google' "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/identity?audience=$OUTFITTER_API"`
   — the sandbox's own service-account identity token. The metadata server authenticates by
   *network position*, not by uid, so the `agent` user gets the same token agentd would.
2. `wss://<api>/agent/ws?run=$RUN_ID` with that token as the bearer, then
   `{"t":"hello", "runToken":"$RUN_TOKEN", ...}`.
3. The api replies with `run.spec`, which carries `secrets.githubToken` and `secrets.litellmKey`
   (`agentlink.ts`'s `buildRunSpec`).

**Blast radius:** the session's GitHub token (push access to the repo the run is working in) and
the run's LiteLLM key, both exfiltrable anywhere the sandbox can reach. Step 2 also *replaced*
agentd in the api's socket map, so the model additionally owned the run's down-channel: it received
the prompts/mail/stop frames meant for agentd and could answer them, making the run's transcript
and state say whatever it liked. The attacker here is the model itself (or anything that gets it to
run a command — a prompt injection in a repo file, an issue body, a fetched page), which is exactly
the actor the two-user split exists to contain.

**Fix:**
1. **`pi.ts` — allowlist, not denylist.** `baseEnvForPi` now builds pi's environment from an
   explicit allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TZ`, `LANG`,
   `LANGUAGE`, `TMPDIR`, plus the `LC_*`, `PI_*`, `KERNAL_*`, `MGM_*` and `LITELLM_*` prefixes.
   `RUN_TOKEN`, `RUN_ID`, `OUTFITTER_API`, `OUTFITTER_DEV_TOKEN` and `NODE_OPTIONS` are
   additionally hard-blocked (`PI_ENV_NEVER`) so no future widening of the allowlist, and no
   operator passthrough, can re-admit them. A denylist fails open by construction — every env var
   agentd gains is exposed to the model until someone remembers to add it; an allowlist fails
   closed.
   Everything pi genuinely needs per run — the LiteLLM key and base URL, the session id, the spend
   file — is already passed explicitly by `run.ts` as an overlay and is unaffected.
   `OUTFITTER_PI_ENV_PASSTHROUGH` (read from agentd's own env, never from the run.spec) is the
   operator escape hatch for environments that need more through, e.g. `HTTPS_PROXY`.
2. **`main.ts` — delete the secrets from `process.env` after reading them.** `RUN_TOKEN` and
   `OUTFITTER_DEV_TOKEN` are read once into consts; they are now removed from `process.env`
   immediately, so every *other* child agentd spawns (`git` via `execFile`, `pi --version`, any
   future spawn site) can't inherit them by accident either.
3. **`agentlink.ts` — one live agent connection per run.** A valid run token is no longer enough on
   its own. A second `hello` for a run whose socket is open and was heard from within
   `AGENT_SOCKET_GRACE_MS` (default 60s = four of agentd's 15s heartbeats) is closed with `4429`
   *before any side effect*, and is never sent `run.spec`.

**Why the connection rule doesn't break agentd's reconnect:** agentd only ever reconnects after its
previous socket has closed — the 55-minute Cloud Run rotation calls `ws.close()` and reconnects
from the `close` handler (`link.ts`) — and a closed socket is out of the map by then. A socket that
is still OPEN but silent past the grace window is treated as a dead half-open connection (a
partitioned sandbox, a killed instance) and replaced, closed with `1001` (non-terminal: a live
agentd that lost the race reconnects rather than exiting), so a partition can't wedge the run until
TCP notices. That grace window is not a hole a live sandbox can slip through: it only opens once
agentd has stopped heartbeating, which means pi — the process the model lives in — isn't running.
`4429` is not in agentd's `TERMINAL_CLOSE_CODES`, so a refused connection retries with backoff.

**Limitation, stated plainly:** `AgentLink.sockets` is per-process, so the rule cannot see a socket
held by a *different* `outfitter-link` instance; a token leaked some other way could still be
presented to another instance and be answered with `run.spec`. Closing that would need the live
connection recorded in the shared store, with a fast-reconnect path that doesn't lock agentd out of
its own run. It is deliberately not attempted here: the rule is defense in depth, and the actual
isolation fix is that the model never sees `RUN_TOKEN` at all.

**Tests:**
- `packages/agentd/test/pi.test.ts` — `baseEnvForPi` against a realistic sandbox `process.env`
  (image ENV + Cloud Run's per-execution overrides): the takeover kit is absent, what pi needs is
  present, an unknown var is dropped rather than passed, `NODE_OPTIONS`/`GIT_CONFIG_*` are dropped,
  the passthrough can add but never re-add a blocked name; plus a `spawnPi` test asserting the
  child's actual env.
- `packages/api/test/agentlink.test.ts` — "one live agent connection per run": a second connection
  is refused `4429` and gets no `run.spec` while the first keeps working; agentd's own reconnect
  still gets `run.spec` once its previous socket closed; a socket silent past the grace window is
  replaced and closed `1001`.

---

## Hardening follow-ups

### 2. Done: `envInt` ignored the env it was passed

`config.ts`'s `envInt` read `process.env` directly while every other reader used the `env` argument
`loadConfig(env)` was called with, so any int-valued setting was unconfigurable in tests (and in any
other caller passing an explicit env). Fixed alongside the new `AGENT_SOCKET_GRACE_MS` setting,
which needs it.

### 3. Open: block the `agent` uid from the GCE metadata server (iptables owner match)

Step 1 of the exploit is the model's shell fetching an identity token from `169.254.169.254`. The
metadata server authenticates by network position, so *any* uid in the container can ask for the
sandbox service account's token — the token isolation above removes the audience/run the model
would use it against, but the token itself is still reachable, and it is also what an SSRF-style
prompt injection would reach for.

The kernel can enforce this per-uid. With `NET_ADMIN` in the sandbox container:

```
iptables -A OUTPUT -d 169.254.169.254 -m owner --uid-owner agent -j REJECT
```

agentd (root) keeps its metadata access, which it needs for `getIdToken`; everything the model runs
loses it. Not applied in this change: Cloud Run Jobs do not grant `NET_ADMIN` to the task container,
so this needs either a gVisor/sandbox-provider change (see `docs/specs`' GKE Agent Sandbox provider
spec, PR #33, where the pod *can* hold `NET_ADMIN`) or an equivalent egress policy at the platform
level. Recorded here so the GKE provider work picks it up rather than rediscovering it.

Note for whoever implements it: the same rule should cover `metadata.google.internal` (the DNS name
resolves to the same link-local address, so the `-d` match already covers it) and should be applied
before pi is first spawned, in the image's entrypoint or the pod's init container — not from agentd
itself, which would need `NET_ADMIN` it otherwise doesn't want.
