#!/usr/bin/env bash
# google-cloud-mcp.sh against a fake router (node http, with a server and a toolset store) and a fake
# gcloud that serves secrets from files. Checks: DRY_RUN reads nothing; a real run without CONFIRM=1
# refuses before reading any secret; a missing primary or a failed GET aborts before any write; the
# first run POSTs four secondaries with oauth_grant_server_id=gcloud and creates the toolset; the
# primary `gcloud` is never written; a rerun shows the servers and PUTs the toolset (no duplicate);
# FORCE_PURGE=1 PUTs the secondaries; ENABLE_APIS=1 enables four APIs in kernal-oauth; neither the
# master key nor the client secret ever reaches stdout/stderr, including a 422 that echoes the body.
# No network, no GCP.
#   bash outfitter/deploy/test/google-cloud-mcp.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../google-cloud-mcp.sh"
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
  "services enable "*) echo "$*" >>"${STATE}/enabled" ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"

cat >"${WORK}/router.mjs" <<'JS'
import http from "node:http";
import fs from "node:fs";
const log = process.env.ROUTER_LOG;
const servers = new Map();
const toolsets = new Map();
let n = 0;
const primarySid = fs.existsSync(process.env.UUID_PRIMARY) ? "uuid-1234" : "gcloud";
if (!fs.existsSync(process.env.NO_PRIMARY)) servers.set(primarySid, { server_id: primarySid, alias: "gcloud", url: "https://cloudcli.googleapis.com/mcp", auth_type: "oauth2" });
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer sk-master-TESTONLY") return send(401, { error: "bad key" });
    fs.appendFileSync(log, `${req.method} ${req.url} ${body}\n`);
    if (req.method === "GET" && fs.existsSync(process.env.FAIL_GET)) return send(500, { error: "boom" });
    if (req.method !== "GET" && fs.existsSync(process.env.FAIL_FILE)) {
      // FastAPI/pydantic 422: the detail echoes the request body as `input`.
      return send(422, { detail: [{ type: "value_error", loc: ["body", "url"], msg: "bad url", input: JSON.parse(body) }] });
    }
    if (req.url === "/v1/mcp/server") {
      if (req.method === "GET") return send(200, [...servers.values()].map((s) => ({ ...s, credentials: { redacted: true } })));
      const p = JSON.parse(body);
      servers.set(p.server_id, p);
      return send(req.method === "POST" ? 200 : 202, p);
    }
    if (req.url === "/v1/mcp/toolset") {
      if (req.method === "GET") return send(200, [...toolsets.values()]);
      const p = JSON.parse(body);
      if (req.method === "POST") { const t = { ...p, toolset_id: `ts-${++n}` }; toolsets.set(t.toolset_id, t); return send(200, t); }
      if (!toolsets.has(p.toolset_id)) return send(404, { error: "nope" });
      toolsets.set(p.toolset_id, p); return send(200, p);
    }
    send(404, {});
  });
});
srv.listen(0, "127.0.0.1", () => { fs.writeFileSync(process.env.PORT_FILE, String(srv.address().port)); });
JS
export ROUTER_LOG="${WORK}/router.log" PORT_FILE="${WORK}/port" FAIL_FILE="${WORK}/fail422" FAIL_GET="${WORK}/failget" NO_PRIMARY="${WORK}/noprimary" UUID_PRIMARY="${WORK}/uuidprimary"
: >"${ROUTER_LOG}"
ROUTER_PID=""
start_router() { rm -f "${PORT_FILE}"; node "${WORK}/router.mjs" & ROUTER_PID=$!
  for _ in $(seq 50); do [[ -s "${PORT_FILE}" ]] && break; sleep 0.1; done
  ROUTER_URL="http://127.0.0.1:$(cat "${PORT_FILE}")"; export ROUTER_URL; : >"${ROUTER_LOG}"; }
stop_router() { kill "${ROUTER_PID}" 2>/dev/null || true; wait "${ROUTER_PID}" 2>/dev/null || true; }
trap 'stop_router; rm -rf "${WORK}"' EXIT
unset GITHUB_ACTIONS DRY_RUN CONFIRM FORCE_PURGE ENABLE_APIS GOOGLE_CLOUD_FIRESTORE_TOOLS
export GCLOUD_MCP_OAUTH_CLIENT_ID=111111111111-abcdef0ghi.apps.googleusercontent.com

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "script exited non-zero"; }
  ! grep -qE 'sk-master|GOCSPX' "${WORK}/out" || { cat "${WORK}/out"; fail "a secret reached the output"; }; }
count() { grep -c "$1" "${ROUTER_LOG}" || true; }

start_router

# DRY_RUN: no client id needed, no router call, no secret read.
env -u GCLOUD_MCP_OAUTH_CLIENT_ID DRY_RUN=1 ENABLE_APIS=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "DRY_RUN failed"; }
[[ ! -s "${ROUTER_LOG}" ]] || fail "DRY_RUN called the router"
[[ ! -s "${STATE}/gcloud-calls" ]] || fail "DRY_RUN read a secret"
[[ ! -e "${STATE}/enabled" ]] || fail "DRY_RUN enabled an API"
for s in cloudrun cloudlogging cloudmonitoring firestore; do grep -q "server ${s} " "${WORK}/out" || fail "DRY_RUN plan lacks ${s}"; done
grep -q "services enable run.googleapis.com" "${WORK}/out" || fail "DRY_RUN plan lacks the API enables"
grep -q "firestore: no tools" "${WORK}/out" || fail "DRY_RUN doesn't say firestore has no tools yet"

# No CONFIRM: refuses before any secret is read.
bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "ran without CONFIRM=1"
grep -q "CONFIRM=1 is required" "${WORK}/out" || fail "wrong refusal"
[[ ! -s "${STATE}/gcloud-calls" && ! -s "${ROUTER_LOG}" ]] || fail "read a secret or called the router without CONFIRM=1"

# A plain-http router that isn't loopback is refused; so is a malformed firestore list.
ROUTER_URL=http://router.example.com CONFIRM=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a non-https ROUTER_URL"
grep -q "must be https" "${WORK}/out" || fail "wrong refusal for http"
GOOGLE_CLOUD_FIRESTORE_TOOLS='a b' DRY_RUN=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a bad firestore list"

# A failed GET aborts: no POST/PUT, no client secret read.
touch "${FAIL_GET}"
CONFIRM=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "a failed GET didn't fail the run"
grep -q "couldn't list the router's MCP servers" "${WORK}/out" || { cat "${WORK}/out"; fail "wrong message for a failed GET"; }
[[ "$(count '^POST \|^PUT ')" == 0 ]] || fail "wrote after a failed GET"
rm -f "${FAIL_GET}"
ROUTER_URL=http://127.0.0.1:1 CONFIRM=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "an unreachable router didn't fail the run"
grep -q "couldn't list the router's MCP servers" "${WORK}/out" || fail "wrong message for an unreachable router"
: >"${ROUTER_LOG}"

# A 422 that echoes the request (incl. the client secret) must not leak it.
touch "${FAIL_FILE}"
CONFIRM=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "422 didn't fail the run"
grep -q "HTTP 422: bad url" "${WORK}/out" || { cat "${WORK}/out"; fail "422 message missing"; }
! grep -qE 'sk-master|GOCSPX' "${WORK}/out" || { cat "${WORK}/out"; fail "a secret leaked through the 422 error"; }
rm -f "${FAIL_FILE}"; : >"${ROUTER_LOG}"

# First run: four secondaries, toolset created, toolset_id printed.
CONFIRM=1 ENABLE_APIS=1 GOOGLE_CLOUD_FIRESTORE_TOOLS="get_document,list_documents" run
[[ "$(count '^POST /v1/mcp/server ')" == 4 ]] || fail "expected four server POSTs"
[[ "$(count '^PUT ')" == 0 ]] || fail "first run PUT something"
! grep '^POST /v1/mcp/server ' "${ROUTER_LOG}" | grep -q '"server_id":"gcloud"' || fail "the primary gcloud was written"
for s in cloudrun cloudlogging cloudmonitoring firestore; do
  body="$(grep "^POST /v1/mcp/server {\"server_id\":\"${s}\"" "${ROUTER_LOG}" | sed 's/^POST [^ ]* //')"
  [[ -n "${body}" ]] || fail "no POST for ${s}"
  jq -e '.oauth_grant_server_id == "gcloud" and .auth_type == "oauth2" and .oauth2_flow == "authorization_code" and .transport == "http" and .allow_all_keys == false' <<<"${body}" >/dev/null || fail "${s}: payload"
  jq -e '.credentials.scopes == ["https://www.googleapis.com/auth/cloud-platform"] and .credentials.client_id == "111111111111-abcdef0ghi.apps.googleusercontent.com" and .credentials.client_secret == "GOCSPX-client-secret-TESTONLY"' <<<"${body}" >/dev/null || fail "${s}: credentials"
  jq -e '.token_url == "https://oauth2.googleapis.com/token" and (.authorization_url | startswith("https://accounts.google.com/o/oauth2/v2/auth?") and contains("access_type=offline") and contains("prompt=consent"))' <<<"${body}" >/dev/null || fail "${s}: endpoints"
done
for pair in cloudrun=https://run.googleapis.com/mcp cloudlogging=https://logging.googleapis.com/mcp cloudmonitoring=https://monitoring.googleapis.com/mcp firestore=https://firestore.googleapis.com/mcp; do
  grep "^POST /v1/mcp/server {\"server_id\":\"${pair%%=*}\"" "${ROUTER_LOG}" | grep -q "\"url\":\"${pair#*=}\"" || fail "wrong url for ${pair%%=*}"
done
[[ "$(count '^POST /v1/mcp/toolset ')" == 1 ]] || fail "expected one toolset POST"
tbody="$(grep '^POST /v1/mcp/toolset ' "${ROUTER_LOG}" | sed 's/^POST [^ ]* //')"
jq -e '.toolset_name == "google_cloud" and (.tools | length) == 16' <<<"${tbody}" >/dev/null || fail "toolset payload: $(jq -c . <<<"${tbody}")"
jq -e '[.tools[] | select(.server_id == "gcloud") | .tool_name] == ["run_gcloud_command","run_bq_command"]' <<<"${tbody}" >/dev/null || fail "gcloud tools"
jq -e '[.tools[] | select(.server_id == "firestore") | .tool_name] == ["get_document","list_documents"]' <<<"${tbody}" >/dev/null || fail "firestore tools"
jq -e '[.tools[] | select(.server_id == "cloudrun") | .tool_name] | index("deploy_service_from_image") != null' <<<"${tbody}" >/dev/null || fail "cloudrun deploy tool"
grep -q '^toolset_id=ts-1$' "${WORK}/out" || { cat "${WORK}/out"; fail "toolset_id not printed"; }
grep -q "OUTFITTER_GOOGLE_CLOUD_TOOLSET_ID=ts-1" "${WORK}/out" || fail "no Outfitter hint"
[[ "$(grep -c . "${STATE}/enabled")" == 4 ]] || fail "expected four API enables"
! grep -qv -e '--project=kernal-oauth' "${STATE}/enabled" || fail "an API was enabled outside kernal-oauth"
grep -q "services enable firestore.googleapis.com" "${STATE}/enabled" || fail "firestore API not enabled"

# Rerun: servers shown, not edited; toolset updated in place, not duplicated; no client secret read.
: >"${ROUTER_LOG}"; : >"${STATE}/gcloud-calls"
CONFIRM=1 run
grep -q "cloudrun is already registered" "${WORK}/out" || fail "rerun didn't show the servers"
[[ "$(count '^POST ')" == 0 ]] || fail "rerun POSTed"
[[ "$(count '^PUT /v1/mcp/server')" == 0 ]] || fail "rerun edited a server"
[[ "$(count '^PUT /v1/mcp/toolset ')" == 1 ]] || fail "rerun didn't PUT the toolset"
grep -q '"toolset_id":"ts-1"' "${ROUTER_LOG}" || fail "toolset PUT lacks the id"
grep -q '^toolset_id=ts-1$' "${WORK}/out" || fail "rerun lost the toolset_id"
! grep -q "client-secret" "${STATE}/gcloud-calls" || fail "rerun read the client secret for nothing"

# The rerun had GOOGLE_CLOUD_FIRESTORE_TOOLS unset: the firestore tools added earlier are kept.
grep '^PUT /v1/mcp/toolset ' "${ROUTER_LOG}" | sed 's/^PUT [^ ]* //' \
  | jq -e '[.tools[] | select(.server_id == "firestore") | .tool_name] == ["get_document","list_documents"] and (.tools | length) == 16' >/dev/null \
  || fail "a plain rerun dropped the firestore tools"
grep -q "keeping the toolset's existing firestore tools" "${WORK}/out" || fail "no note about kept firestore tools"
# toolset_id is printed before the verification read.
[[ "$(grep -n '^toolset_id=' "${WORK}/out" | cut -d: -f1)" -lt "$(grep -n '^Servers sharing' "${WORK}/out" | cut -d: -f1)" ]] || fail "toolset_id not printed before verification"

# Explicitly empty: exactly that, firestore tools removed.
: >"${ROUTER_LOG}"
CONFIRM=1 GOOGLE_CLOUD_FIRESTORE_TOOLS="" run
grep '^PUT /v1/mcp/toolset ' "${ROUTER_LOG}" | sed 's/^PUT [^ ]* //' \
  | jq -e '([.tools[] | select(.server_id == "firestore")] | length) == 0 and (.tools | length) == 14' >/dev/null \
  || fail "an explicit empty list didn't clear the firestore tools"

# FORCE_PURGE=1: the four secondaries are PUT; the primary never is.
: >"${ROUTER_LOG}"
CONFIRM=1 FORCE_PURGE=1 run
[[ "$(count '^PUT /v1/mcp/server ')" == 4 ]] || fail "FORCE_PURGE didn't PUT four servers"
! grep '^PUT /v1/mcp/server ' "${ROUTER_LOG}" | grep -q '"server_id":"gcloud"' || fail "FORCE_PURGE edited the primary"
! grep -q "purges every user" "${WORK}/out" || fail "wrongly warned that a secondary edit purges everyone"

# FORCE_PURGE without CONFIRM still refuses.
FORCE_PURGE=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "FORCE_PURGE alone ran"

# No primary registered: abort before any write.
stop_router; touch "${NO_PRIMARY}"; start_router
CONFIRM=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "ran without a primary"
grep -q "gcloud-mcp-router.sh first" "${WORK}/out" || { cat "${WORK}/out"; fail "wrong message for a missing primary"; }
[[ "$(count '^POST \|^PUT ')" == 0 ]] || fail "wrote without a primary"

# Primary registered with alias gcloud but a UUID server_id: the real id is used for the grant link
# and the toolset, never the alias.
stop_router; rm -f "${NO_PRIMARY}"; touch "${UUID_PRIMARY}"; start_router
CONFIRM=1 run
[[ "$(count '^POST /v1/mcp/server ')" == 4 ]] || fail "uuid primary: expected four POSTs"
grep '^POST /v1/mcp/server ' "${ROUTER_LOG}" | while read -r _ _ body; do
  jq -e '.oauth_grant_server_id == "uuid-1234"' <<<"${body}" >/dev/null || exit 1
done || fail "oauth_grant_server_id isn't the primary's real server_id"
grep '^POST /v1/mcp/toolset ' "${ROUTER_LOG}" | sed 's/^POST [^ ]* //' \
  | jq -e '[.tools[] | select(.server_id == "uuid-1234")] | length == 2' >/dev/null || fail "toolset gcloud tools don't use the real server_id"
! grep '^POST /v1/mcp/toolset ' "${ROUTER_LOG}" | grep -q '"server_id":"gcloud"' || fail "toolset used the alias"

echo "google-cloud-mcp.test.sh: ok"
