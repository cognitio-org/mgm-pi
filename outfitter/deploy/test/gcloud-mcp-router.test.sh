#!/usr/bin/env bash
# gcloud-mcp-router.sh against a fake router (node http) and a fake gcloud that serves secrets from
# files. Checks: DRY_RUN calls nothing; a real run without CONFIRM=1 refuses before reading any
# secret; the first run POSTs an oauth2 authorization_code server with Google's endpoints, the
# cloud-platform scope and the client secret from Secret Manager; a rerun only shows it (no PUT);
# FORCE_PURGE=1 PUTs; neither the master key nor the client secret ever
# reaches stdout/stderr. No network, no GCP.
#   bash outfitter/deploy/test/gcloud-mcp-router.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../gcloud-mcp-router.sh"
WORK="$(mktemp -d)"
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export STATE="${WORK}/state"; mkdir -p "${STATE}/secrets"
printf '%s' "sk-master-TESTONLY" >"${STATE}/secrets/kernal-litellm-prod-master-key"
printf '%s' "GOCSPX-client-secret-TESTONLY" >"${STATE}/secrets/outfitter-gcloud-mcp-oauth-client-secret"
: >"${STATE}/gcloud-calls"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
d="${STATE}/secrets"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "secrets describe "*) [[ -f "${d}/$3" ]] || { echo "NOT_FOUND" >&2; exit 1; } ;;
  "secrets versions access latest "*) echo "access ${5#--secret=}" >>"${STATE}/gcloud-calls"; cat "${d}/${5#--secret=}" ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"

cat >"${WORK}/router.mjs" <<'JS'
import http from "node:http";
import fs from "node:fs";
let server = null;
const log = process.env.ROUTER_LOG;
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer sk-master-TESTONLY") return send(401, { error: "bad key" });
    fs.appendFileSync(log, `${req.method} ${req.url} ${body}\n`);
    if (req.url !== "/v1/mcp/server") return send(404, {});
    if (req.method !== "GET" && fs.existsSync(process.env.FAIL_FILE)) {
      // FastAPI/pydantic 422: the detail echoes the request body as `input`.
      return send(422, { detail: [{ type: "value_error", loc: ["body", "url"], msg: "bad url", input: JSON.parse(body) }] });
    }
    if (req.method === "GET") return send(200, server ? [{ ...server, credentials: { redacted: true } }] : []);
    if (req.method === "POST" || req.method === "PUT") { server = JSON.parse(body); return send(req.method === "POST" ? 200 : 202, server); }
    send(405, {});
  });
});
srv.listen(0, "127.0.0.1", () => { fs.writeFileSync(process.env.PORT_FILE, String(srv.address().port)); });
JS
export ROUTER_LOG="${WORK}/router.log" PORT_FILE="${WORK}/port" FAIL_FILE="${WORK}/fail422"
: >"${ROUTER_LOG}"
node "${WORK}/router.mjs" & ROUTER_PID=$!
trap 'kill ${ROUTER_PID} 2>/dev/null; rm -rf "${WORK}"' EXIT
for _ in $(seq 50); do [[ -s "${PORT_FILE}" ]] && break; sleep 0.1; done
export ROUTER_URL="http://127.0.0.1:$(cat "${PORT_FILE}")"
unset GITHUB_ACTIONS DRY_RUN CONFIRM FORCE_PURGE
export GCLOUD_MCP_OAUTH_CLIENT_ID=111111111111-abcdef0ghi.apps.googleusercontent.com

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "script exited non-zero"; }
  ! grep -qE 'sk-master|GOCSPX' "${WORK}/out" || { cat "${WORK}/out"; fail "a secret reached the output"; }; }
posts() { grep -c "^POST " "${ROUTER_LOG}" || true; }
puts() { grep -c "^PUT " "${ROUTER_LOG}" || true; }

# DRY_RUN: no client id needed, no router call, no secret read.
env -u GCLOUD_MCP_OAUTH_CLIENT_ID DRY_RUN=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "DRY_RUN failed"; }
[[ ! -s "${ROUTER_LOG}" ]] || fail "DRY_RUN called the router"
[[ ! -s "${STATE}/gcloud-calls" ]] || fail "DRY_RUN read a secret"
grep -q "/callback" "${WORK}/out" || fail "DRY_RUN doesn't print the redirect URI"

# No CONFIRM: refuses before any secret is read.
bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "ran without CONFIRM=1"
grep -q "CONFIRM=1 is required" "${WORK}/out" || fail "wrong refusal"
[[ ! -s "${STATE}/gcloud-calls" ]] || fail "read a secret without CONFIRM=1"
[[ ! -s "${ROUTER_LOG}" ]] || fail "called the router without CONFIRM=1"

# A plain-http router that isn't loopback is refused.
ROUTER_URL=http://router.example.com CONFIRM=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a non-https ROUTER_URL"
grep -q "must be https" "${WORK}/out" || fail "wrong refusal for http"

# A 422 that echoes the request (incl. the client secret) must not leak it.
touch "${FAIL_FILE}"
CONFIRM=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "422 didn't fail the run"
grep -q "HTTP 422: bad url" "${WORK}/out" || { cat "${WORK}/out"; fail "422 message missing"; }
! grep -qE 'sk-master|GOCSPX' "${WORK}/out" || { cat "${WORK}/out"; fail "a secret leaked through the 422 error"; }
rm -f "${FAIL_FILE}"; : >"${ROUTER_LOG}"

# First run registers.
CONFIRM=1 run
[[ "$(posts)" == 1 ]] || fail "expected one POST"
body="$(grep '^POST ' "${ROUTER_LOG}" | sed 's/^POST [^ ]* //')"
check() { jq -e "$1" <<<"${body}" >/dev/null || fail "payload: $2 ($1)"; }
check '.server_id == "gcloud" and .alias == "gcloud"' "id/alias"
check '.url == "https://cloudcli.googleapis.com/mcp" and .transport == "http"' "url/transport"
check '.auth_type == "oauth2" and .oauth2_flow == "authorization_code"' "auth"
check '.token_url == "https://oauth2.googleapis.com/token"' "token_url"
check '.credentials.scopes == ["https://www.googleapis.com/auth/cloud-platform"]' "scope"
check '.credentials.client_id == "111111111111-abcdef0ghi.apps.googleusercontent.com"' "client_id"
check '.credentials.client_secret == "GOCSPX-client-secret-TESTONLY"' "client_secret from Secret Manager"
check '.allow_all_keys == false' "allow_all_keys"
check '.authorization_url | contains("access_type=offline") and contains("prompt=consent") and startswith("https://accounts.google.com/o/oauth2/v2/auth?")' "authorization_url carries access_type and prompt"

# Rerun: shown, not edited.
CONFIRM=1 run
grep -q "already registered" "${WORK}/out" || fail "rerun didn't show the server"
[[ "$(posts)" == 1 && "$(puts)" == 0 ]] || fail "rerun wrote to the router"

# FORCE_PURGE=1: PUT.
CONFIRM=1 FORCE_PURGE=1 run
[[ "$(puts)" == 1 ]] || fail "FORCE_PURGE didn't PUT"
grep -q "purges every user" "${WORK}/out" || fail "no purge warning"

# FORCE_PURGE without CONFIRM still refuses.
FORCE_PURGE=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "FORCE_PURGE alone ran"
CONFIRM=1='[1]' bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a non-object"

echo "gcloud-mcp-router.test.sh: ok"
