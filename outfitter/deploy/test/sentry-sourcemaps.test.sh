#!/usr/bin/env bash
# Web source maps (#423), everything but the upload itself:
# - sentry-token.sh against a fake gcloud that keeps secret versions in files: DRY_RUN writes
#   nothing; the first run creates the secret and grants outfitter-builder@ access to it; the same
#   token again adds nothing; a new token adds a version and disables the old one; the token never
#   reaches the output; it refuses without outfitter-builder@ or without a token.
# - env.sh build_api_image: cloudbuild-api-sentry.yaml (with org/project) only when the secret
#   exists, cloudbuild-api.yaml otherwise.
# - The two build configs: same build, only the sentry one names the secret.
# - packages/api/Dockerfile: the token is a secret mount, never an ARG/ENV, and *.map is deleted
#   after the web build.
# No network, no GCP.
#   bash outfitter/deploy/test/sentry-sourcemaps.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "${HERE}/.." && pwd)"
DOCKERFILE="${DEPLOY}/../packages/api/Dockerfile"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# Never touch the real home directory (#152).
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export STATE="${WORK}/state" CALLS="${WORK}/calls"
mkdir -p "${STATE}/secrets"
: >"${CALLS}"

mkdir -p "${WORK}/bin"
# Secret versions are files <name>.<n>; a disabled one is renamed <name>.<n>.disabled.
# FAKE_NO_BUILDER=1: outfitter-builder@ doesn't exist.
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
d="${STATE}/secrets"
latest() { ls "${d}/$1."* 2>/dev/null | grep -v '\.disabled$' | sort -t. -k2 -n | tail -1; }
echo "$*" >>"${CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "iam service-accounts describe outfitter-builder@"*)
    [[ "${FAKE_NO_BUILDER:-}" != 1 ]] || { echo "NOT_FOUND" >&2; exit 1; } ;;
  "secrets describe "*) ls "${d}/$3."* >/dev/null 2>&1 || { echo "NOT_FOUND" >&2; exit 1; } ;;
  "secrets versions access latest "*) f="$(latest "${5#--secret=}")"; [[ -n "${f}" ]] && cat "${f}" ;;
  "secrets create "*) cat >"${d}/$3.1" ;;
  "secrets versions add "*) n=$(ls "${d}/$4."* | wc -l | tr -d ' '); cat >"${d}/$4.$((n + 1))" ;;
  "secrets versions list "*)
    files=$(ls "${d}/$4."* | grep -v '\.disabled$' | sort -t. -k2 -n)
    [[ "$*" == *--limit=1* ]] && files=$(tail -1 <<<"${files}")
    for f in ${files}; do echo "projects/p/secrets/$4/versions/${f##*.}"; done ;;
  "secrets versions disable "*) mv "${d}/${5#--secret=}.$4" "${d}/${5#--secret=}.$4.disabled" ;;
  "secrets add-iam-policy-binding "*) ;;
  "builds submit"*) ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"
unset GITHUB_ACTIONS DRY_RUN SENTRY_ORG SENTRY_PROJECT

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
no() { fail=$((fail + 1)); echo "FAIL $1"; [[ -f "${WORK}/out" ]] && cat "${WORK}/out"; }
TOKEN1="sntrys_TESTONLY_one" TOKEN2="sntrys_TESTONLY_two"
S="${STATE}/secrets/sentry-release-token"
# token_run <name> <token> [env...]: pipes the token into sentry-token.sh; 0 if it succeeded.
token_run() {
  local name="$1" token="$2"; shift 2
  : >"${CALLS}"
  local rc=0
  printf '%s\n' "${token}" | env "$@" bash "${DEPLOY}/sentry-token.sh" >"${WORK}/out" 2>&1 || rc=$?
  if grep -q 'TESTONLY' "${WORK}/out"; then no "${name}: the token reached the output"; fi
  return "${rc}"
}

# --- sentry-token.sh ---------------------------------------------------------------------------
if token_run "dry run" "${TOKEN1}" DRY_RUN=1 && ! ls "${S}".* >/dev/null 2>&1 \
    && ! grep -qE '^secrets (create|versions add|add-iam)' "${CALLS}"; then ok "DRY_RUN writes nothing"
else no "DRY_RUN writes nothing"; fi

if token_run "first run" "${TOKEN1}" && [[ "$(cat "${S}.1")" == "${TOKEN1}" ]]; then ok "first run creates the secret with the token (no trailing newline)"
else no "first run creates the secret"; fi
if grep -qx "secrets add-iam-policy-binding sentry-release-token --project=outfitter-509211 --member=serviceAccount:outfitter-builder@outfitter-509211.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --quiet" "${CALLS}"; then
  ok "grants secretAccessor on that secret to outfitter-builder@"
else no "grants secretAccessor on that secret to outfitter-builder@"; cat "${CALLS}"; fi
if ! grep -qE '^projects add-iam-policy-binding' "${CALLS}"; then ok "no project-level grant"
else no "no project-level grant"; fi

if token_run "same token" "${TOKEN1}" && [[ "$(ls "${S}".* | wc -l | tr -d ' ')" == 1 ]]; then ok "the same token again adds no version"
else no "the same token again adds no version"; fi

if token_run "new token" "${TOKEN2}" && [[ "$(cat "${S}.2")" == "${TOKEN2}" && -f "${S}.1.disabled" && ! -f "${S}.1" ]]; then
  ok "a new token adds a version and disables the old one"
else no "a new token adds a version and disables the old one"; ls "${STATE}/secrets"; fi

if ! token_run "no builder" "${TOKEN2}" FAKE_NO_BUILDER=1 && grep -q "run ci-setup.sh" "${WORK}/out"; then ok "refuses without outfitter-builder@"
else no "refuses without outfitter-builder@"; fi
if ! token_run "empty" "" && grep -q "no token" "${WORK}/out"; then ok "refuses an empty token"
else no "refuses an empty token"; fi
if ! token_run "spaces" "two words" && grep -q "spaces" "${WORK}/out"; then ok "refuses a token with spaces"
else no "refuses a token with spaces"; fi

# --- env.sh build_api_image ---------------------------------------------------------------------
# build_with <secret present: yes|no> -- the builds submit line it ran.
build_with() {
  rm -f "${S}".*
  [[ "$1" == yes ]] && printf x >"${S}.1"
  : >"${CALLS}"
  # shellcheck disable=SC1091
  (source "${DEPLOY}/env.sh" >/dev/null 2>&1 && build_api_image /src IMG:tag) >/dev/null 2>&1
  grep '^builds submit' "${CALLS}" || true
}
line="$(build_with yes)"
if [[ "${line}" == *"--config=/src/deploy/cloudbuild-api-sentry.yaml"* \
      && "${line}" == *"--substitutions=_IMAGE=IMG:tag,_SENTRY_ORG=cognitio-flow,_SENTRY_PROJECT=kernal-one"* ]]; then
  ok "with the secret: cloudbuild-api-sentry.yaml, org/project from config.env"
else no "with the secret: cloudbuild-api-sentry.yaml ($line)"; fi
line="$(build_with no)"
if [[ "${line}" == *"--config=/src/deploy/cloudbuild-api.yaml"* && "${line}" == *"--substitutions=_IMAGE=IMG:tag "* \
      && "${line}" != *SENTRY* ]]; then
  ok "without the secret: cloudbuild-api.yaml, no Sentry substitutions"
else no "without the secret: cloudbuild-api.yaml ($line)"; fi
# Both call sites go through it, never straight to a config.
if ! grep -n 'cloudbuild-api' "${DEPLOY}/service.sh" "${DEPLOY}/build-api-image.sh" >/dev/null \
    && grep -q 'build_api_image ' "${DEPLOY}/service.sh" && grep -q 'build_api_image ' "${DEPLOY}/build-api-image.sh"; then
  ok "service.sh and build-api-image.sh build through build_api_image"
else no "service.sh and build-api-image.sh build through build_api_image"; fi

# --- the two Cloud Build configs ----------------------------------------------------------------
if python3 -c 'import yaml' 2>/dev/null; then
  if python3 - "${DEPLOY}/cloudbuild-api.yaml" "${DEPLOY}/cloudbuild-api-sentry.yaml" <<'PY'
import sys, yaml
plain, sentry = (yaml.safe_load(open(p)) for p in sys.argv[1:])
p, s = plain["steps"], sentry["steps"]
assert len(p) == len(s) == 1, "one step each"
p, s = p[0], s[0]
assert "DOCKER_BUILDKIT=1" in p["env"] and "DOCKER_BUILDKIT=1" in s["env"], "BuildKit on in both"
assert "availableSecrets" not in plain and "secretEnv" not in p, "plain config names no secret"
assert "--secret" not in p["args"], "plain config passes no secret"
sm = sentry["availableSecrets"]["secretManager"]
assert sm == [{"versionName": "projects/${PROJECT_ID}/secrets/sentry-release-token/versions/latest", "env": "SENTRY_AUTH_TOKEN"}], sm
assert s["secretEnv"] == ["SENTRY_AUTH_TOKEN"], s["secretEnv"]
a = s["args"]
assert a[a.index("--secret") + 1] == "id=sentry_auth_token,env=SENTRY_AUTH_TOKEN", a
assert not any("SENTRY_AUTH_TOKEN" in x for x in a if x != "id=sentry_auth_token,env=SENTRY_AUTH_TOKEN"), "token never a build arg"
# Same build otherwise: drop the Sentry-only args and compare.
rest, skip = [], 0
for x in a:
    if skip: skip -= 1; continue
    if x == "--secret": skip = 1; continue
    if x == "--build-arg": skip = 1; continue
    rest.append(x)
assert rest == p["args"], (rest, p["args"])
for k in ("images", "options"):
    assert plain[k] == sentry[k], k
assert p["name"] == s["name"]
PY
  then ok "build configs: same build, only the sentry one carries the secret"
  else no "build configs: same build, only the sentry one carries the secret"; fi
else
  echo "skip build configs: no python3 yaml"
fi

# --- Dockerfile -------------------------------------------------------------------------------
if grep -qE '^\s*(ARG|ENV)\s+SENTRY_AUTH_TOKEN' "${DOCKERFILE}"; then no "Dockerfile: token is never an ARG/ENV"
else ok "Dockerfile: token is never an ARG/ENV"; fi
# The web build's RUN (joined across continuation lines) mounts the secret and deletes the maps.
web_run="$(awk '/^RUN /{r=$0; while (r ~ /\\$/ && (getline l) > 0) r = r "\n" l; if (r ~ /@outfitter\/web/) print r}' "${DOCKERFILE}")"
if grep -q -- '--mount=type=secret,id=sentry_auth_token' <<<"${web_run}" \
    && grep -q "find packages/web/dist -name '\*.map' -type f -delete" <<<"${web_run}"; then
  ok "Dockerfile: the web build mounts the token as a secret and deletes *.map"
else no "Dockerfile: the web build mounts the token as a secret and deletes *.map"; echo "${web_run}"; fi
# Only packages/web/dist reaches the final image from the web build, after that RUN.
if [[ "$(grep -c 'COPY --from=builder /app/packages/web' "${DOCKERFILE}")" == 1 ]] \
    && grep -q 'COPY --from=builder /app/packages/web/dist packages/web/dist' "${DOCKERFILE}"; then
  ok "Dockerfile: only packages/web/dist is copied from the builder"
else no "Dockerfile: only packages/web/dist is copied from the builder"; fi

echo "${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
