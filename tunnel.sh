#!/usr/bin/env bash
# Expose LM Studio (MLX) through ngrok on a stable domain, gated by a bearer token.
# Reads .env: LOCAL_TUNNEL_TOKEN, TUNNEL_DOMAIN_LMSTUDIO. Inspector: http://localhost:4040
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
exec ngrok http 1234 --url "https://$TUNNEL_DOMAIN_LMSTUDIO" --host-header=localhost:1234 \
  --traffic-policy-file <(cat <<YAML
on_http_request:
  - expressions:
      - "!('authorization' in req.headers) || req.headers['authorization'][0] != 'Bearer ${LOCAL_TUNNEL_TOKEN}'"
    actions:
      - type: deny
        config: { status_code: 401 }
YAML
)
