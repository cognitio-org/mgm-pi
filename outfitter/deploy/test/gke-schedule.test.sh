#!/usr/bin/env bash
# gke-schedule.sh against fake gcloud. No network, no GCP.
#   bash outfitter/deploy/test/gke-schedule.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${GCLOUD_CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "iam service-accounts describe outfitter-tasks"*)
    [[ -n "${FAKE_NO_TASKS_SA:-}" ]] && { echo "ERROR: NOT_FOUND" >&2; exit 1; }
    ;;
  *"run services describe outfitter-link"*"OUTFITTER_ORIGIN"*) printf '%s\n' "${FAKE_LINK_ORIGIN:-}" ;;
  "run services describe"*) exit 0 ;;
  "scheduler jobs describe outfitter-warm-up"*) exit "${FAKE_UP_EXISTS_EXIT:-1}" ;;
  "scheduler jobs describe outfitter-warm-down"*) exit "${FAKE_DOWN_EXISTS_EXIT:-1}" ;;
  "services enable"*) : ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"

export PATH="${WORK}/bin:${PATH}"
export GCLOUD_CALLS="${WORK}/gcloud-calls" GKE_CLUSTER=outfitter FAKE_LINK_ORIGIN=https://link.example.com
unset GITHUB_ACTIONS

fails=0
OUT=""
expect() {
  local want="$1" desc="$2" pattern="$3"
  shift 3
  : >"${GCLOUD_CALLS}"
  local status=0
  OUT="$(env "$@" "${HERE}/../gke-schedule.sh" 2>&1)" || status=$?
  local problem=""
  if [[ "${want}" == pass && ${status} -ne 0 ]] || [[ "${want}" == fail && ${status} -eq 0 ]]; then
    problem="exit ${status}"
  elif [[ -n "${pattern}" ]] && ! grep -q -- "${pattern}" <<<"${OUT}"; then
    problem="no match for: ${pattern}"
  fi
  if [[ -n "${problem}" ]]; then
    echo "FAIL: ${desc} (${problem})"; echo "${OUT}" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: ${desc}"
  fi
}

expect fail "GKE_CLUSTER empty refuses" "GKE_CLUSTER is empty" GKE_CLUSTER=
expect fail "no outfitter-tasks SA refuses (run mailbox.sh first)" "run ./mailbox.sh first" FAKE_NO_TASKS_SA=1
expect fail "outfitter-link not deployed refuses" "outfitter-link is not deployed yet" FAKE_LINK_ORIGIN=

expect pass "both jobs are created when absent" "outfitter-warm-up: 0 8 \* \* 1-5"
grep -q "scheduler jobs create http outfitter-warm-up" "${GCLOUD_CALLS}" \
  && echo "ok:   warm-up: create, --headers (not --update-headers)" \
  || { echo "FAIL:   expected a create call for outfitter-warm-up"; fails=$((fails + 1)); }
grep -q -- "--message-body={\"replicas\":1}" "${GCLOUD_CALLS}" \
  && echo "ok:   warm-up defaults to replicas=1" \
  || { echo "FAIL:   expected replicas=1 in the warm-up body"; fails=$((fails + 1)); }
grep -q "scheduler jobs create http outfitter-warm-down" "${GCLOUD_CALLS}" \
  && echo "ok:   warm-down: create too" \
  || { echo "FAIL:   expected a create call for outfitter-warm-down"; fails=$((fails + 1)); }
grep -q -- "--message-body={\"replicas\":0}" "${GCLOUD_CALLS}" \
  && echo "ok:   warm-down always targets replicas=0" \
  || { echo "FAIL:   expected replicas=0 in the warm-down body"; fails=$((fails + 1)); }
grep -q -- "--time-zone=Europe/Zagreb" "${GCLOUD_CALLS}" \
  && echo "ok:   default time zone is Europe/Zagreb" \
  || { echo "FAIL:   expected --time-zone=Europe/Zagreb"; fails=$((fails + 1)); }

FAKE_UP_EXISTS_EXIT=0 FAKE_DOWN_EXISTS_EXIT=0 \
  expect pass "existing jobs are updated, not recreated" "outfitter-warm-up: 0 8"
grep -q "scheduler jobs update http outfitter-warm-up" "${GCLOUD_CALLS}" \
  && echo "ok:   warm-up: update http, --update-headers" \
  || { echo "FAIL:   expected an update call for outfitter-warm-up"; fails=$((fails + 1)); }
grep -q -- "--update-headers=Content-Type=application/json" "${GCLOUD_CALLS}" \
  && echo "ok:   ... using --update-headers, not --headers" \
  || { echo "FAIL:   expected --update-headers on the update call"; fails=$((fails + 1)); }

WARM_UP_CRON="0 7 * * 1-5" WARM_TZ=UTC WARM_REPLICAS=2 \
  expect pass "overrides are honoured" "outfitter-warm-up: 0 7 \* \* 1-5 UTC"
grep -q -- "--message-body={\"replicas\":2}" "${GCLOUD_CALLS}" \
  && echo "ok:   WARM_REPLICAS=2 is used" \
  || { echo "FAIL:   expected replicas=2 with WARM_REPLICAS=2"; fails=$((fails + 1)); }

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
