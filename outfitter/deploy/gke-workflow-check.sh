#!/usr/bin/env bash
# Whether outfitter-deploy.yml's setup-gcloud step should install kubectl/gke-gcloud-auth-plugin:
# only when config.env's GKE_CLUSTER default is non-empty. Prints "beta" or
# "beta,kubectl,gke-gcloud-auth-plugin" on stdout, and (when GITHUB_OUTPUT is set) appends
# components=<that value> there for the workflow step to read.
#
# Deliberately does NOT `source config.env` (or env.sh): config.env's other lines reference
# ${REGION}, which only env.sh ever sets, and a bare CI step running under `set -u` with no REGION
# defined would abort on "REGION: unbound variable" before setup-gcloud ever runs -- breaking every
# release, GKE on or off. Instead this extracts and evaluates just the one
# `GKE_CLUSTER="${GKE_CLUSTER:-...}"` line from config.env, in isolation, which references nothing
# else. No project access, no gcloud call: safe to run in a clean environment (env -i).
#   ./gke-workflow-check.sh [path/to/config.env]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_ENV="${1:-${HERE}/config.env}"

GKE_CLUSTER_LINE="$(grep -E '^GKE_CLUSTER=' "${CONFIG_ENV}")" \
  || { echo "gke-workflow-check: no GKE_CLUSTER= line found in ${CONFIG_ENV}" >&2; exit 1; }
# Evaluate only that one assignment, with GKE_CLUSTER unset first so its own "${GKE_CLUSTER:-...}"
# default (config.env's actual, checked-in setting) is what comes out -- not anything inherited from
# this process's environment.
GKE_CLUSTER_VALUE="$(unset GKE_CLUSTER; eval "${GKE_CLUSTER_LINE}"; printf '%s' "${GKE_CLUSTER}")"

if [[ -n "${GKE_CLUSTER_VALUE}" ]]; then
  COMPONENTS="beta,kubectl,gke-gcloud-auth-plugin"
else
  COMPONENTS="beta"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "components=${COMPONENTS}" >>"${GITHUB_OUTPUT}"
fi
echo "${COMPONENTS}"
