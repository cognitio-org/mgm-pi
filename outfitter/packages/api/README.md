# @outfitter/api

The Outfitter control plane: REST + SSE for the browser, WebSocket ingress for `agentd`, run
lifecycle, the secrets broker, and the E2.8 laptop-model preflight. See `../../EPIC.md` for the
architecture and `../../docs/protocol.md` for the wire contract this package implements.
`docs/data-model.md` in this package documents the Atlas collections.

## Run locally

Everything has a dev-safe default, so the whole stack runs with no GCP project and no Mongo
cluster:

```bash
cd outfitter
npm install
MONGODB_URI=memory OUTFITTER_DEV=1 SANDBOX_PROVIDER=inprocess npm run dev --workspace=@outfitter/api
```

- `MONGODB_URI=memory` selects `MemoryStore` (in-process, nothing persists across restarts).
- `OUTFITTER_DEV=1` skips IAP/agent-token verification: every browser request is identified as
  `dev@localhost`, and agentd authenticates with the fixed `OUTFITTER_DEV_TOKEN` instead of a
  Google ID token.
- `SANDBOX_PROVIDER=inprocess` runs a run's `agentd` as a plain child process
  (`node "$AGENTD_MAIN"`) instead of a Cloud Run Job — set `AGENTD_MAIN` to
  `../agentd/dist/src/main.js` (build that package first) to actually exercise a run end to end.

Then, e.g.:

```bash
curl -s localhost:8080/api/gurus -X POST -H 'content-type: application/json' \
  -d '{"name":"dev guru","model":"litellm/local-qwen-mlx","fallbackModel":"litellm/claude-auto-llm"}'
curl -s localhost:8080/api/sessions -X POST -H 'content-type: application/json' \
  -d '{"guruId":"<id from above>","prompt":"hello"}'
```

## Tests

```bash
npm test              # from outfitter/, runs every workspace package
npm test --workspace=@outfitter/api   # just this package
```

Node's built-in test runner (`node --test test/`) against TypeScript source directly — no build
step, no test framework dependency. Every test builds an app with `MemoryStore` + `NoopProvider`
(`test/helpers.ts`'s `buildTestApp`), so nothing touches a real Mongo cluster, GCP, or the network;
`test/laptop.test.ts` stubs `fetch` instead of hitting a real ngrok tunnel.

## Env vars

| Var | Default | Used by |
|---|---|---|
| `MONGODB_URI` | `memory` | `store/index.ts` — `memory` selects `MemoryStore`; anything else is a `mongodb://`/`mongodb+srv://` URI for `MongoStore` |
| `OUTFITTER_DEV` | unset (`0`) | `auth.ts` — `1` skips IAP/agent-token verification |
| `OUTFITTER_DEV_TOKEN` | `dev-agent-token` | `auth.ts` — bearer token accepted from agentd in dev mode |
| `OUTFITTER_ORIGIN` | `http://localhost:8080` | `agentlink.ts` — this API's own URL; the agentd token audience |
| `AGENT_SA_EMAIL` | `""` | `auth.ts` — required email on agentd's Google ID token (prod only) |
| `IAP_AUDIENCE` | `""` | `auth.ts` — IAP resource's OAuth client id, required for browser auth (prod only) |
| `SANDBOX_PROVIDER` | `inprocess` | `providers/index.ts` — `inprocess` \| `docker` \| `cloudrun` |
| `AGENTD_MAIN` | unset | `providers/inprocess.ts` — path to agentd's built entrypoint (`inprocess`/`docker` provider only) |
| `CLOUDRUN_JOB` | `outfitter-agent` | `providers/cloudrun.ts` — Cloud Run Job name (`cloudrun` provider only) |
| `GCP_PROJECT` | `""` | `providers/cloudrun.ts`, `secrets.ts` |
| `GCP_REGION` | `us-central1` | `providers/cloudrun.ts` |
| `IDLE_STOP_SECONDS` | `600` | `agentlink.ts` — sent to agentd as `run.spec.idleStopSeconds` |
| `TUNNEL_DOMAIN_LMSTUDIO` | `""` | `laptop.ts` — laptop LM Studio's ngrok domain, e.g. `mgm-lmstudio.ngrok.app` (see `~/localllm/tunnel.sh`) |
| `LOCAL_TUNNEL_TOKEN` | `""` | `laptop.ts` — bearer token the tunnel's traffic policy requires |
| `LOCAL_MODELS` | `litellm/local-qwen-mlx` | `laptop.ts` — comma-separated model ids that require the laptop preflight before use |
| `DEFAULT_CLOUD_MODEL` | `litellm/claude-auto-llm` | `laptop.ts` — fallback when a guru has no `fallbackModel` of its own |
| `NGROK_WEBHOOK_SECRET` | `""` | `routes/hooks.ts` — HMAC-SHA256 shared secret for `POST /api/hooks/ngrok`; unset means every delivery is rejected |
| `PORT` | `8080` | `main.ts` |

`OUTFITTER_DEV_GITHUB_TOKEN` / `OUTFITTER_DEV_LITELLM_KEY` (read by `secrets.ts`'s
`MemorySecretsBroker`) round out local dev if a run actually needs to clone a private repo or call
a real LiteLLM key; both default to `""`, which works fine against a public repo and no LLM calls.

## Deploy order

See `../../deploy/README.md` for the full sequence and the manual Atlas/Secret Manager steps. In
short: `deploy/baseline.sh` (APIs, service accounts, budget) → Atlas + Secret Manager by hand →
`deploy/api.sh` (build + deploy this package, IAP on) → `deploy/agent-job.sh` (build + deploy the
sandbox image as a Cloud Run Job, needs this service's URL).
