#!/usr/bin/env bash
# litellm-retire-keys.sh (#399) against a fake router (node http) and a fake gcloud that keeps
# secrets in files. Checks: DRY_RUN reads and writes nothing; `block` refuses MGM-Pi while
# outfitter-litellm-key-default still holds it; `system-key` makes an internal_user (never
# proxy_admin) in the outfitter-system team, mints a team key, stores it and disables the old
# version; a rerun does nothing; a failed store deletes the new key; `block` blocks the three
# aliases and reports already blocked / not found; `unblock` undoes one; no key value ever reaches
# stdout/stderr. No network, no GCP.
#   bash outfitter/deploy/test/litellm-retire-keys.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../litellm-retire-keys.sh"
WORK="$(mktemp -d)"
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export STATE="${WORK}/state"; mkdir -p "${STATE}/secrets"
printf '%s' "sk-master-TESTONLY" >"${STATE}/secrets/kernal-litellm-prod-master-key.1"
printf '%s' "sk-mgmpi-TESTONLY" >"${STATE}/secrets/outfitter-litellm-key-default.1"
export GCLOUD_LOG="${WORK}/gcloud.log"; : >"${GCLOUD_LOG}"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
# Secret versions are files <name>.<n>; a disabled one is renamed <name>.<n>.disabled.
echo "$*" >>"${GCLOUD_LOG}"
d="${STATE}/secrets"
latest() { ls "${d}/$1."* 2>/dev/null | grep -v '\.disabled$' | sort -t. -k2 -n | tail -1; }
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "secrets describe "*) [[ -n "$(latest "$3")" ]] || { echo "NOT_FOUND" >&2; exit 1; } ;;
  "secrets versions access latest "*) f="$(latest "${5#--secret=}")"; [[ -n "${f}" ]] || exit 1; cat "${f}" ;;
  "secrets create "*) [[ "${FAIL_STORE:-}" != 1 ]] || exit 1; cat >"${d}/$3.1" ;;
  "secrets versions add "*) [[ "${FAIL_STORE:-}" != 1 ]] || exit 1; n=$(ls "${d}/$4."* | wc -l | tr -d ' '); cat >"${d}/$4.$((n + 1))" ;;
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
const MASTER = "sk-master-TESTONLY";
const TEAM = "b8e96aa8-9e6d-4db5-937e-eadbd03fec2d";
const users = new Map([["owner@example.com", { user_id: "owner@example.com", user_role: "proxy_admin" }]]);
const teams = [{ team_id: TEAM, team_alias: "outfitter-system", members_with_roles: [] }, { team_id: "other", team_alias: "x", members_with_roles: [] }];
// agent-testing is added later through /__seed, so the first block run sees it missing.
const keys = [
  { key: "sk-mgmpi-TESTONLY", token: "hash-mgmpi", key_alias: "MGM-Pi", user_id: "owner@example.com", blocked: false },
  { key: "sk-matej-TESTONLY", token: "hash-matej", key_alias: "litellm-autorouter-testing-c", user_id: "matej", blocked: null },
  { key: "sk-local-TESTONLY", token: "hash-local", key_alias: "local-test", user_id: "owner@example.com", blocked: false },
];
let n = 0;
const log = process.env.ROUTER_LOG;
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, "http://x");
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const j = body ? JSON.parse(body) : {};
    // A key asking about itself: /key/info with no key parameter.
    if (bearer !== MASTER) {
      const own = keys.find((k) => k.key === bearer);
      if (url.pathname === "/key/info" && own && own.blocked !== true) {
        fs.appendFileSync(log, `SELF ${req.method} ${url.pathname} ${own.key_alias}\n`);
        return send(200, { key: own.token, info: { key_alias: own.key_alias, user_id: own.user_id, team_id: own.team_id ?? null } });
      }
      return send(401, { error: "bad key" });
    }
    fs.appendFileSync(log, `${req.method} ${url.pathname}${url.search} ${body}\n`);
    const p = url.pathname;
    if (p === "/__seed") { keys.push(j); return send(200, {}); }
    if (p === "/user/info") { const u = users.get(url.searchParams.get("user_id")); return u ? send(200, { user_id: u.user_id, user_info: u }) : send(404, { detail: "no user" }); }
    if (p === "/user/new") { users.set(j.user_id, { user_id: j.user_id, user_role: j.user_role }); return send(200, { user_id: j.user_id }); }
    if (p === "/user/update") { users.get(j.user_id).user_role = j.user_role; return send(200, {}); }
    if (p === "/team/list") return send(200, teams);
    if (p === "/team/info") { const t = teams.find((t) => t.team_id === url.searchParams.get("team_id")); return t ? send(200, { team_id: t.team_id, team_info: t }) : send(404, {}); }
    if (p === "/team/member_add") { teams.find((t) => t.team_id === j.team_id).members_with_roles.push(j.member); return send(200, {}); }
    if (p === "/key/list") { const a = url.searchParams.get("key_alias"); return send(200, { keys: keys.filter((k) => !a || k.key_alias === a).map(({ key, ...rest }) => rest) }); }
    if (p === "/key/generate") { n++; keys.push({ ...j, key: `sk-system-${n}`, token: `hash-system-${n}`, blocked: false }); return send(200, { key: `sk-system-${n}`, key_alias: j.key_alias }); }
    if (p === "/key/delete") { for (const a of j.key_aliases) { const i = keys.findIndex((k) => k.key_alias === a); if (i >= 0) keys.splice(i, 1); } return send(200, {}); }
    if (p === "/key/block" || p === "/key/unblock") { const k = keys.find((k) => k.token === j.key); if (!k) return send(404, {}); k.blocked = p === "/key/block"; return send(200, {}); }
    send(404, {});
  });
});
srv.listen(0, "127.0.0.1", () => { fs.writeFileSync(process.env.PORT_FILE, String(srv.address().port)); });
JS
export ROUTER_LOG="${WORK}/router.log" PORT_FILE="${WORK}/port"
: >"${ROUTER_LOG}"
node "${WORK}/router.mjs" & ROUTER_PID=$!
trap 'kill ${ROUTER_PID} 2>/dev/null; rm -rf "${WORK}"' EXIT
for _ in $(seq 50); do [[ -s "${PORT_FILE}" ]] && break; sleep 0.1; done
ROUTER_URL="http://127.0.0.1:$(cat "${PORT_FILE}")"
export ROUTER_URL
unset GITHUB_ACTIONS DRY_RUN ROTATE FAIL_STORE

fail() { echo "FAIL: $*" >&2; exit 1; }
no_secrets() { ! grep -qE 'sk-[A-Za-z0-9]' "${WORK}/out" || { cat "${WORK}/out"; fail "a key value reached the output"; }; }
run() { bash "${SCRIPT}" "$@" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "script $* exited non-zero"; }; no_secrets; }
says() { grep -qF -- "$1" "${WORK}/out" || { cat "${WORK}/out"; fail "expected '$1' in the output"; }; }
secret_files() { ls "${STATE}/secrets" | sort | tr '\n' ' '; }

# Arguments.
if bash "${SCRIPT}" >"${WORK}/out" 2>&1; then fail "no step accepted"; fi
if bash "${SCRIPT}" nonsense >"${WORK}/out" 2>&1; then fail "unknown step accepted"; fi

# DRY_RUN reads nothing secret and writes nothing, for every step.
before="$(secret_files)"
DRY_RUN=1 run system-key
says "DRY_RUN=1"
DRY_RUN=1 run block
DRY_RUN=1 run unblock MGM-Pi
[[ ! -s "${ROUTER_LOG}" ]] || fail "DRY_RUN called the router"
! grep -q 'versions access\|versions add\|create\|disable' "${GCLOUD_LOG}" || fail "DRY_RUN read or wrote a secret: $(cat "${GCLOUD_LOG}")"
[[ "$(secret_files)" == "${before}" ]] || fail "DRY_RUN changed secrets"

# block before system-key: MGM-Pi refused (the default secret still holds it), agent-testing not
# found, Matej's key blocked.
run block
says "MGM-Pi: refused"
says "agent-testing: not found"
says "litellm-autorouter-testing-c: blocked"
says "unblock"
grep -q '"key":"hash-mgmpi"' "${ROUTER_LOG}" && fail "MGM-Pi was blocked before system-key"
grep -q 'POST /key/block .*"hash-matej"' "${ROUTER_LOG}" || fail "Matej's key not blocked"
grep -q 'hash-local' "${ROUTER_LOG}" && fail "local-test touched (not on the list)"

# system-key: internal_user, team member, team key, stored, old version disabled.
run system-key
grep -q 'POST /user/new .*"user_role":"internal_user"' "${ROUTER_LOG}" || fail "system user not internal_user"
grep -q 'proxy_admin' "${ROUTER_LOG}" && fail "proxy_admin must never be requested"
grep -q 'POST /team/member_add .*"user_id":"outfitter-system"' "${ROUTER_LOG}" || fail "system user not added to the team"
gen="$(grep '^POST /key/generate ' "${ROUTER_LOG}")"
[[ "$(grep -c '^POST /key/generate ' "${ROUTER_LOG}")" == 1 ]] || fail "expected one mint"
grep -q '"user_id":"outfitter-system"' <<<"${gen}" || fail "key not for outfitter-system"
grep -q '"team_id":"b8e96aa8-9e6d-4db5-937e-eadbd03fec2d"' <<<"${gen}" || fail "key not in the outfitter-system team"
grep -q '"key_alias":"outfitter-system-[0-9]\{14\}"' <<<"${gen}" || fail "alias not outfitter-system-<UTC time>"
grep -q '"purpose":"Outfitter'"'"'s own model calls (gurus, summaries, extraction)"' <<<"${gen}" || fail "metadata purpose missing"
grep -q '"owner":"outfitter"' <<<"${gen}" || fail "metadata owner missing"
grep -q 'POST /team/new' "${ROUTER_LOG}" && fail "the existing team must be found by alias, not created"
[[ "$(cat "${STATE}/secrets/outfitter-litellm-key-default.2")" == "sk-system-1" ]] || fail "system key not stored"
[[ -f "${STATE}/secrets/outfitter-litellm-key-default.1.disabled" ]] || fail "old version (MGM-Pi) not disabled"
says "holds: MGM-Pi"

# Rerun: the stored key is already an outfitter-system-* key, checked as that key.
run system-key
says "Nothing to do"
says "already holds outfitter-system-"
[[ "$(grep -c '^POST /key/generate ' "${ROUTER_LOG}")" == 1 ]] || fail "rerun minted"
grep -q '^SELF GET /key/info outfitter-system-' "${ROUTER_LOG}" || fail "stored key not checked with /key/info as itself"

# A failed store deletes the new key and stops.
sleep 1  # the alias carries a seconds timestamp
if ROTATE=1 FAIL_STORE=1 bash "${SCRIPT}" system-key >"${WORK}/out" 2>&1; then fail "a failed store exited 0"; fi
no_secrets
says "new router key was deleted"
grep -q '^POST /key/delete .*"key_aliases":\["outfitter-system-' "${ROUTER_LOG}" || fail "orphan key not deleted"
[[ ! -f "${STATE}/secrets/outfitter-litellm-key-default.3" ]] || fail "failed store wrote a version"

# block after system-key: all three.
curl -sS -X POST "${ROUTER_URL}/__seed" -H 'Authorization: Bearer sk-master-TESTONLY' \
  --data-binary '{"key":"sk-agent-TESTONLY","token":"hash-agent","key_alias":"agent-testing","user_id":"?","blocked":false}' >/dev/null
run block
says "MGM-Pi: blocked"
says "agent-testing: blocked"
says "litellm-autorouter-testing-c: already blocked"
grep -q 'POST /key/block .*"hash-mgmpi"' "${ROUTER_LOG}" || fail "MGM-Pi not blocked"
grep -q 'POST /key/block .*"hash-agent"' "${ROUTER_LOG}" || fail "agent-testing not blocked"
grep -q 'hash-local' "${ROUTER_LOG}" && fail "local-test touched (not on the list)"
grep -q '/key/list?key_alias=MGM-Pi' "${ROUTER_LOG}" || fail "not looked up by alias"

run block
[[ "$(grep -c 'already blocked' "${WORK}/out")" == 3 ]] || { cat "${WORK}/out"; fail "rerun should report all three already blocked"; }

# unblock.
run unblock agent-testing
says "agent-testing: unblocked"
grep -q 'POST /key/unblock .*"hash-agent"' "${ROUTER_LOG}" || fail "agent-testing not unblocked"
run unblock no-such-key
says "no-such-key: not found"

echo "litellm-retire-keys.test.sh: ok"
