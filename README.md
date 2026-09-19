# localllm

Local LLM setup for this MacBook Pro (M4 Pro, 48 GB unified memory), plus the wiring that
exposes it to the cloud LiteLLM router.

## Stack

- **LM Studio** (`brew install --cask lm-studio`) with the **MLX** backend. OpenAI-compatible
  server on `http://localhost:1234/v1`. CLI: `lms`.
- Model: `qwen/qwen3.6-35b-a3b` (Qwen 3.6 35B mixture-of-experts, 3B active, 4-bit MLX, 20 GB,
  vision, 256K context). Measured here: 73-82 tok/s, ~0.3 s to first token.

## Everyday commands

```bash
lms server start                                            # after a reboot
lms load qwen/qwen3.6-35b-a3b --context-length 32768 -y     # load (first request after load is slow: MLX compile)
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
ceiling, and never keep two 30B-class models loaded at once (the machine swaps). Set context to
32K on load; this model's default is 183K and inflates memory.

Candidates: `qwen/qwen3.6-27b` coding variant (dense, stronger at code, slower), `gemma-4` 27B/31B,
`openai/gpt-oss-20b` (needs the bundled harmony runtime). Dense 70B is cloud territory.

## Thinking mode

Qwen 3.6 reasons by default and spends 400-1600 tokens on trivial prompts. Send
`"reasoning_effort": "none"` to turn it off (the LiteLLM deployment does this by default).

## Exposing the model to the cloud LiteLLM router

LiteLLM (`litellm.augment-code.support`, GCP Cloud Run) reaches the laptop through ngrok on a
stable domain (`TUNNEL_DOMAIN_LMSTUDIO` in `.env`, Hobbyist plan). A bearer token
(`LOCAL_TUNNEL_TOKEN`) is enforced by an ngrok traffic policy, so unauthenticated requests never
reach the laptop. The router model is `local-qwen-mlx`; its payload lives in
`~/code/openllm/litellm-config/deployments/local-qwen-mlx.json`.

```bash
./tunnel.sh                                                   # leave running
cd ~/code/openllm/litellm-config && LITELLM_MASTER_KEY=... ./apply-local.sh   # only if URL/token change
```

Keep the laptop awake (`caffeinate -s`) while the model should be reachable.
