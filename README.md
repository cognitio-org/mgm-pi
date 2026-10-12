# localllm

Local LLM setup for this MacBook Pro (M4 Pro, 48 GB unified memory), plus the wiring that
exposes it to the cloud LiteLLM router.

## The kernal agent

The coding agent built on top of this setup lives in [`kernal/`](kernal/README.md): pi with kernal's
extensions (connections to LM Studio / the LiteLLM router / OpenRouter, budget tracking,
compaction tuned for local models, voice input, per-user banner) and a release pipeline that ships
self-contained bundles (`kernal/README.md` → *Releases*). Run `kernal login` once per machine (it
brings this device's own router key and your account's settings, so `.env` needs no keys), then run
it from any repo with `kernal`.

## Stack

- **LM Studio** (`brew install --cask lm-studio`) with the **MLX** backend. OpenAI-compatible
  server on `http://localhost:1234/v1`. CLI: `lms`.
- Model: `qwen/qwen3.6-35b-a3b` (Qwen 3.6 35B mixture-of-experts, 3B active, 4-bit MLX, 20 GB,
  vision, 256K context). Measured here: 73-82 tok/s, ~0.3 s to first token.

## Everyday commands

```bash
lms server start                                            # after a reboot
lms load qwen/qwen3.6-35b-a3b --ttl 86400 -y                # load (first request after load is slow: MLX compile)
lms ps                                                      # what's loaded
lms unload --all
lms get <hf-name> --mlx                                     # download another MLX model
```

In the app, Developer tab: enable "Run server on login" and just-in-time loading to skip the
first two commands.

## Test script

`chat.mjs` talks to any OpenAI-compatible endpoint. Configure `.env` (copy from `.env.example`).

```bash
node chat.mjs "explain unified memory"            # lmstudio (default)
node chat.mjs litellm "..."                       # cloud router
node chat.mjs openrouter "..."
```

## Model sizing for 48 GB

Q4 ≈ 0.6 GB per billion params plus context. Keep ~10 GB for macOS; ~35 GB is the comfortable
ceiling, and never keep two 30B-class models loaded at once (the machine swaps). MLX ignores
`--context-length` (this model always serves 183K); kernal declares a 128K window to the agent
(`LMSTUDIO_CONTEXT`) so budgets stay honest without touching the server.

Candidates: `qwen/qwen3.6-27b` coding variant (dense, stronger at code, slower), `gemma-4` 27B/31B,
`openai/gpt-oss-20b` (needs the bundled harmony runtime). Dense 70B is cloud territory.

## Thinking mode

Qwen 3.6 reasons by default and spends 400-1600 tokens on trivial prompts. Send
`"reasoning_effort": "none"` to turn it off (the LiteLLM deployment does this by default).

## Sharing the model (`kernal local`)

`kernal local enable` installs a background service that shares this machine's model server with
your Outfitter account. The router name is `local/<you>-<machine>/<model>` (for this laptop,
something like `local/mgm-matthews-macbook-pro/qwen/qwen3.6-35b-a3b`). `kernal local status` shows
the tunnel, the models, and the last heartbeat. Details: [`kernal/docs/local-host.md`](kernal/docs/local-host.md).

```bash
kernal login            # once per machine
kernal local enable     # install + start; turn on localHost.shareModels (the command says where)
kernal local status
```

Keep the laptop awake (`caffeinate -s`) while the model should be reachable.

`tunnel.sh`, `keepalive.mjs`, and `apply-local.sh` are gone. The service's guard proxy keeps long
streams alive, which is what `keepalive.mjs` used to do. The old `litellm/local-qwen-mlx` alias
has been removed from the router. Shares use the `local/...` names above.
