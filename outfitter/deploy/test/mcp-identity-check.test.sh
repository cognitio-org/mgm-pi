#!/usr/bin/env bash
# mcp-identity-check.sh against a fake router (node http) and a fake gcloud. Checks: DRY_RUN reads no
# secret; clean rows pass; each broken invariant is reported by user id and fails the run; paging
# reaches every user; the admin key never reaches the output. Also: config.env keeps the shared
# run-key fallback off (MO-7). No network, no GCP.
#   bash outfitter/deploy/test/mcp-identity-check.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../mcp-identity-check.sh"
WORK="$(mktemp -d)"
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export STATE="${WORK}/state"; mkdir -p "${STATE}/secrets"
printf '%s' "sk-admin-TESTONLY" >"${STATE}/secrets/outfitter-litellm-admin"
: >"${STATE}/gcloud-calls"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "secrets versions access latest "*) echo "access" >>"${STATE}/gcloud-calls"; cat "${STATE}/secrets/${5#--secret=}" ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"

cat >"${WORK}/router.mjs" <<'JS'
import http from "node:http";
import fs from "node:fs";
const srv = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.headers.authorization !== "Bearer sk-admin-TESTONLY") return send(401, { error: "bad key" });
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/user/list") return send(404, {});
  const users = JSON.parse(fs.readFileSync(process.env.USERS_FILE, "utf8"));
  const page = Number(url.searchParams.get("page")), size = Number(url.searchParams.get("page_size"));
  send(200, { users: users.slice((page - 1) * size, page * size), total: users.length, page });
});
srv.listen(0, "127.0.0.1", () => { fs.writeFileSync(process.env.PORT_FILE, String(srv.address().port)); });
JS
export PORT_FILE="${WORK}/port" USERS_FILE="${WORK}/users.json"
echo '[]' >"${USERS_FILE}"
node "${WORK}/router.mjs" & ROUTER_PID=$!
trap 'kill ${ROUTER_PID} 2>/dev/null; rm -rf "${WORK}"' EXIT
for _ in $(seq 50); do [[ -s "${PORT_FILE}" ]] && break; sleep 0.1; done
export ROUTER_URL="http://127.0.0.1:$(cat "${PORT_FILE}")" CLOUDSDK_CORE_ACCOUNT="owner@test"
unset GITHUB_ACTIONS DRY_RUN PROJECT

fail() { echo "FAIL: $*" >&2; exit 1; }
uid() { printf 'outfitter-user:%s' "$1" | sha256sum | cut -c1-24 | sed 's/^/u_/'; }
run() { set +e; PAGE_SIZE=2 bash "${SCRIPT}" >"${WORK}/out" 2>&1; echo $? >"${WORK}/rc"; set -e; ! grep -q 'sk-admin' "${WORK}/out" || fail "the key reached the output"; }

DRY_RUN=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "dry run failed"; }
[[ ! -s "${STATE}/gcloud-calls" ]] || fail "dry run read a secret"

A="$(uid a@example.com)"
cat >"${USERS_FILE}" <<JSON
[
  {"user_id": "accounts.google.com:1", "user_email": "a@example.com"},
  {"user_id": "${A}", "user_email": null, "metadata": {"source": "outfitter", "email": "A@example.com "}},
  {"user_id": "svc", "user_email": null, "metadata": {}}
]
JSON
run
[[ "$(cat "${WORK}/rc")" == 0 ]] || { cat "${WORK}/out"; fail "clean rows failed"; }
grep -q "checked 1 outfitter user(s) of 3: 0 violation(s)" "${WORK}/out" || { cat "${WORK}/out"; fail "paging missed users"; }

cat >"${USERS_FILE}" <<JSON
[
  {"user_id": "u_wronghash00000000000000", "user_email": null, "metadata": {"source": "outfitter", "email": "b@example.com"}},
  {"user_id": "u_noemail", "user_email": null, "metadata": {"source": "outfitter"}},
  {"user_id": "$(uid c@example.com)", "user_email": "c@example.com", "metadata": {"source": "outfitter", "email": "c@example.com"}},
  {"user_id": "$(uid d@example.com)", "user_email": null, "metadata": {"source": "outfitter", "email": "d@example.com"}},
  {"user_id": "iap-d1", "user_email": "d@example.com"},
  {"user_id": "iap-d2", "user_email": "D@example.com"}
]
JSON
run
[[ "$(cat "${WORK}/rc")" == 1 ]] || { cat "${WORK}/out"; fail "violations didn't fail the run"; }
grep -q "VIOLATION u_wronghash00000000000000: user_id is not userIdFor" "${WORK}/out" || fail "wrong hash not reported"
grep -q "VIOLATION u_noemail: metadata.email is missing" "${WORK}/out" || fail "missing email not reported"
grep -q "VIOLATION $(uid c@example.com): user_email is set" "${WORK}/out" || fail "user_email on outfitter row not reported"
grep -q "VIOLATION $(uid d@example.com): 2 users have this address" "${WORK}/out" || fail "duplicate owners not reported"
grep -q "4 violation(s)" "${WORK}/out" || { cat "${WORK}/out"; fail "violation count"; }

# MO-7: Drives must run as the person, never on the shared key (which has no grants).
( unset OUTFITTER_RUN_KEY_FALLBACK; source "${HERE}/../config.env"; [[ "${OUTFITTER_RUN_KEY_FALLBACK}" == 0 ]] ) \
  || fail "config.env must keep OUTFITTER_RUN_KEY_FALLBACK=0"

echo "mcp-identity-check.test.sh: ok"
