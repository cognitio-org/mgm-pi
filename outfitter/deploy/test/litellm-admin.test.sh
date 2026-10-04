#!/usr/bin/env bash
# litellm-admin.sh against a fake router (node http) and a fake gcloud that keeps secrets in files.
# Checks: first run creates the user, mints one scoped key and stores it; a rerun does nothing;
# ROTATE=1 stores a new key, disables the old version and deletes the old key; no key value ever
# reaches stdout/stderr. No network, no GCP.
#   bash outfitter/deploy/test/litellm-admin.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../litellm-admin.sh"
WORK="$(mktemp -d)"
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export STATE="${WORK}/state"; mkdir -p "${STATE}/secrets"
printf '%s' "sk-master-TESTONLY" >"${STATE}/secrets/kernal-litellm-prod-master-key.1"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
# Secret versions are files <name>.<n>; a disabled one is renamed <name>.<n>.disabled.
d="${STATE}/secrets"
latest() { ls "${d}/$1."* 2>/dev/null | grep -v '\.disabled$' | sort -t. -k2 -n | tail -1; }
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "secrets describe "*) [[ -n "$(latest "$3")" ]] || { echo "NOT_FOUND" >&2; exit 1; } ;;
  "secrets versions access latest "*) cat "$(latest "${5#--secret=}")" ;;
  "secrets create "*) cat >"${d}/$3.1" ;;
  "secrets versions add "*) n=$(ls "${d}/$4."* | wc -l | tr -d ' '); cat >"${d}/$4.$((n + 1))" ;;
  "secrets versions list "*)
    files=$(ls "${d}/$4."* | grep -v '\.disabled$' | sort -t. -k2 -n)
    [[ "$*" == *--limit=1* ]] && files=$(tail -1 <<<"${files}")
    for f in ${files}; do echo "projects/p/secrets/$4/versions/${f##*.}"; done ;;
  "secrets versions disable "*) mv "${d}/${5#--secret=}.$4" "${d}/${5#--secret=}.$4.disabled" ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"

cat >"${WORK}/router.mjs" <<'JS'
import http from "node:http";
import fs from "node:fs";
const users = new Set(), keys = [];
let n = 0;
const log = process.env.ROUTER_LOG;
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer sk-master-TESTONLY") return send(401, { error: "bad key" });
    const url = new URL(req.url, "http://x");
    const j = body ? JSON.parse(body) : {};
    fs.appendFileSync(log, `${req.method} ${url.pathname} ${body}\n`);
    if (url.pathname === "/user/info") return users.has(url.searchParams.get("user_id")) ? send(200, {}) : send(404, { detail: "no user" });
    if (url.pathname === "/user/new") { users.add(j.user_id); return send(200, { user_id: j.user_id }); }
    if (url.pathname === "/key/list") return send(200, { keys: keys.filter((k) => k.user_id === url.searchParams.get("user_id")) });
    if (url.pathname === "/key/generate") { const key = `sk-admin-${++n}`; keys.push({ ...j, key }); return send(200, { key, key_alias: j.key_alias }); }
    if (url.pathname === "/key/delete") { for (const a of j.key_aliases) { const i = keys.findIndex((k) => k.key_alias === a); if (i >= 0) keys.splice(i, 1); } return send(200, {}); }
    send(404, {});
  });
});
srv.listen(0, "127.0.0.1", () => { fs.writeFileSync(process.env.PORT_FILE, String(srv.address().port)); });
JS
export ROUTER_LOG="${WORK}/router.log" PORT_FILE="${WORK}/port"
node "${WORK}/router.mjs" & ROUTER_PID=$!
trap 'kill ${ROUTER_PID} 2>/dev/null; rm -rf "${WORK}"' EXIT
for _ in $(seq 50); do [[ -s "${PORT_FILE}" ]] && break; sleep 0.1; done
ROUTER_URL="http://127.0.0.1:$(cat "${PORT_FILE}")"
export ROUTER_URL
unset GITHUB_ACTIONS DRY_RUN ROTATE

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "script exited non-zero"; }
  ! grep -q 'sk-' "${WORK}/out" || { cat "${WORK}/out"; fail "a key value reached the output"; }; }

# DRY_RUN touches nothing.
DRY_RUN=1 run
[[ ! -s "${ROUTER_LOG}" ]] || fail "DRY_RUN called the router"

# First run.
run
[[ "$(cat "${STATE}/secrets/outfitter-litellm-admin.1")" == "sk-admin-1" ]] || fail "key 1 not stored"
grep -q '"user_role":"proxy_admin"' "${ROUTER_LOG}" || fail "service user not proxy_admin"
grep -q '"allowed_routes":\["/key/generate"' "${ROUTER_LOG}" || fail "key not scoped"
grep -q '/key/regenerate' "${ROUTER_LOG}" && fail "regenerate must not be allowed"

# Rerun is a no-op.
run
grep -q "Nothing to do" "${WORK}/out" || fail "rerun was not a no-op"
[[ "$(grep -c '/key/generate' "${ROUTER_LOG}")" == 1 ]] || fail "rerun minted"

# Rotation.
sleep 1  # the alias carries a seconds timestamp
ROTATE=1 run
[[ "$(cat "${STATE}/secrets/outfitter-litellm-admin.2")" == "sk-admin-2" ]] || fail "key 2 not stored"
[[ -f "${STATE}/secrets/outfitter-litellm-admin.1.disabled" ]] || fail "old version not disabled"
grep -q '"key_aliases":\["outfitter-admin-' "${ROUTER_LOG}" || fail "old key not deleted"

echo "litellm-admin.test.sh: ok"
