#!/usr/bin/env bash
# Expose LM Studio (MLX) through ngrok on a stable domain, gated by a bearer token.
# Reads .env: LOCAL_TUNNEL_TOKEN, TUNNEL_DOMAIN_LMSTUDIO. Inspector: http://localhost:4040
#
# ngrok drops a stream that has carried no data for 300 s, and LM Studio sends a tool call's
# arguments in one chunk at the end, so a long tool call used to die at five minutes
# (mgmonteleone/openllm#10). ngrok therefore points at keepalive.mjs (port 1235), which forwards to
# LM Studio (1234) and keeps silent streams alive with SSE comments.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a

node keepalive.mjs &
shim=$!
trap 'kill "$shim" 2>/dev/null' EXIT
# Wait for the shim to listen, so ngrok's first request doesn't meet a closed port.
for _ in $(seq 50); do
  (exec 3<>/dev/tcp/127.0.0.1/1235) 2>/dev/null && break
  kill -0 "$shim" 2>/dev/null || { echo "keepalive.mjs failed to start" >&2; exit 1; }
  sleep 0.1
done
# Something else already on 1235 answers the probe while the shim dies of EADDRINUSE.
sleep 0.3
kill -0 "$shim" 2>/dev/null || { echo "keepalive.mjs exited (port 1235 in use?)" >&2; exit 1; }

ngrok http 1235 --url "https://$TUNNEL_DOMAIN_LMSTUDIO" --host-header=localhost:1234 \
  --traffic-policy-file <(cat <<YAML
on_http_request:
  - expressions:
      - "!('authorization' in req.headers) || req.headers['authorization'][0] != 'Bearer ${LOCAL_TUNNEL_TOKEN}'"
    actions:
      - type: deny
        config: { status_code: 401 }
YAML
)
