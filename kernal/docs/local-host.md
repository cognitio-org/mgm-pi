# Sharing your local models (`kernal local`)

`kernal local` runs a small background service that shares the model server on this machine (LM
Studio, Ollama, llama.cpp, mlx-lm or vLLM) with your Outfitter account, so cloud runs and your
team can use those models through the router as `local/<you>-<machine>/<model>`. `tunnel.sh` and
`keepalive.mjs` are gone (#387). The design is `outfitter/docs/specs/local-host.md` §4.

## Turning it on

```bash
kernal login                 # once per machine: the service uses this device's login
kernal local enable          # install + start the service (macOS LaunchAgent, Linux systemd user unit)
kernal local status          # what it is doing
```

`enable` does **not** turn sharing on. Sharing is the setting `localHost.shareModels`; `enable`
prints its current value and where it comes from. Turn it on in one of these places:

- the account page on the Outfitter web app (this device or every device), or `/admin` inside Kernal;
- `"localHost.shareModels": true` under `"values"` in `~/.kernal/config.local.json` (this machine only).

`/config` inside Kernal shows the value and its source. The service notices a change within 15
seconds, and refetches the central settings every 10 minutes (or at once on `kill -HUP <pid>`).

`kernal local enable --profile <name>` runs the service with that settings profile. Running
`enable` again rewrites the unit and restarts the service.

## What it does

Every 15 seconds it looks at which model servers answer on localhost (no network beyond this
machine). While sharing is on and a server answers, it keeps one tunnel open to that one server;
when nothing answers or sharing is off, it closes the tunnel (ngrok bills active endpoint hours).
It tells Outfitter about the machine and its models when something changes, and otherwise every 5
minutes while sharing, so the router's entries follow along. Nothing about individual requests is
reported.

- **Signed in**: the tunnel credentials come from Outfitter and are kept in memory only. No key is
  stored on the laptop, and the router master key is never needed.
- **Signed out**: no heartbeats. If `.env` still has the interim `NGROK_AUTHTOKEN`,
  `TUNNEL_DOMAIN_LMSTUDIO` and `LOCAL_TUNNEL_TOKEN`, the tunnel runs on those (the same interim
  credentials the removed `tunnel.sh` used), but the router gets no entries for it.
- **Sleep and wake**: after a wake the tunnel is restarted and Outfitter is told at once. Failures
  are retried with backoff (5 s, 10 s, 20 s ... up to 5 minutes).
- **Stop**: `kernal local disable`, or a SIGTERM/Ctrl-C, sends a last "stop" heartbeat so the
  router entries go at once rather than after the 16-minute stale window.

`tunnel.sh` and `keepalive.mjs` are gone. Do not start another tunnel on the same reserved domain
(ngrok refuses the second one with `ERR_NGROK_334`). The old `litellm/local-qwen-mlx` alias has
been removed from the router. Shares are `local/<you>-<machine>/<model>`.

## Commands

```
kernal local enable [--profile <name>]   install + start the service (idempotent; rewrites the unit)
kernal local disable                     stop + remove it (sends the "stop" heartbeat first)
kernal local status [--json]             service, sign-in, sharing, tunnel, models, last heartbeat
kernal local run                         the foreground loop (what the service runs; Ctrl-C stops it)
```

Exit codes: 0 done, 1 failed, 2 usage.

## Settings

| Variable (in `.env` or the environment) | Meaning |
|---|---|
| `KERNAL_LOCAL_HOST_SERVER` | The model server to share, as a root URL (`http://localhost:11434`). Default: the first that answers of LM Studio, Ollama, llama.cpp, mlx-lm, vLLM. |
| `KERNAL_LOCAL_TUNNEL` | `auto` (default), `ngrok` or `cloudflare`, for interim `.env` credentials. Outfitter's credentials are ngrok's, so a signed-in tunnel is always ngrok; `cloudflare` stays local-only (no router entries) until #386. |
| `KERNAL_LOCAL_NODE` | The Node binary to run the service with (recorded by `enable`). |

## Runtime

The service runs under Node 22.18 or later (from a source checkout, or `node` on PATH). A release
bundle without Node runs it with the bundled `pi` binary as Bun. `enable` refuses when neither is
available. `enable` installs Kernal's pinned, checksum-checked ngrok into `~/.kernal/bin` when
that copy is missing, including when some other `ngrok` is already on the shell's PATH. The
service looks there first and does not download. A LaunchAgent's PATH does not include Homebrew.

## Files

| Path | What |
|---|---|
| `~/Library/LaunchAgents/one.kernal.local-host.plist` | the macOS LaunchAgent |
| `~/.config/systemd/user/kernal-local-host.service` | the Linux systemd user unit (`loginctl enable-linger` keeps it running without a session) |
| `~/.kernal/local-host/state.json` | what the service is doing (no secrets); `status` reads it |
| `~/.kernal/local-host/run.lock` | the running loop's pid; a second `run` exits with "already running" |
| `~/.kernal/logs/local-host.log` | one line per event, redacted, rotated at 5 MiB keeping 3 |
| `~/.kernal/logs/local-host.out.log` | the process's own stdout/stderr (crashes only) |

`KERNAL_HOME_DIR` moves `~/.kernal`.
