#!/usr/bin/env bash
# Install or update the kernal agent from a GitHub release bundle.
#   curl -fsSL https://github.com/mgmonteleone/mgm-pi/releases/latest/download/install.sh | bash
#   KERNAL_VERSION=0.2.0 ... | bash          # a specific release
#   KERNAL_HOME=~/tools/kernal ... | bash    # install location (default ~/.kernal)
#   KERNAL_BUNDLE_FILE=dist/kernal-0.2.0-darwin-arm64.tar.gz KERNAL_VERSION=0.2.0 bash install.sh
#                                             # install a locally built bundle (no download; tests use this)
# Needs curl and tar; for a private repo either the gh CLI (logged in) or GH_TOKEN plus python3.
# Puts `kernal` on PATH via ~/.local/bin.
#
# --- mgm -> kernal rename (docs/rename.md) ---
# Every env var this script reads has a KERNAL_* name; the pre-rename MGM_* name still works as a
# fallback (via kenv() below, which warns once per process per old name) because the OLD `mgm`
# launcher's update case (bin/mgm, releases through 0.1.x) downloads *this* (the new release's)
# install.sh and runs it as `MGM_HOME=$HOME/.mgm MGM_VERSION=<v> bash install.sh` — an existing
# install upgrades with nothing more than `mgm update`.
#
# MGM_HOME gets one extra rule: when it is exactly the legacy default ($HOME/.mgm, what `mgm update`
# always passes), it names the install being migrated FROM, not the target — the bundle installs
# into the new default ($HOME/.kernal) instead, and migrate_legacy() below carries the old install's
# state, .env (MGM_* keys renamed to KERNAL_*) and settings across, once, idempotently. A CUSTOM
# (non-default) MGM_HOME — e.g. `MGM_HOME=~/tools/mgm bash install.sh` — is honoured as the target
# directly, exactly as KERNAL_HOME would be: that directory goes on holding the renamed bundle.
set -euo pipefail

# kenv NAME: read $KERNAL_<NAME>, falling back to the legacy $MGM_<NAME> (warns once per process per
# old name, to stderr). The same small function is duplicated in bin/kernal — install.sh ships and
# runs standalone (downloaded on its own by `kernal update`), so it cannot source a sibling file.
_kenv_warned=""
kenv() {
  local name="$1" kv="KERNAL_$1" mv="MGM_$1"
  if [[ -n "${!kv:-}" ]]; then printf '%s' "${!kv}"; return 0; fi
  if [[ -n "${!mv:-}" ]]; then
    case " $_kenv_warned " in *" $name "*) ;; *) _kenv_warned="$_kenv_warned $name"; echo "$mv is now $kv; the old name stops working in a later release." >&2 ;; esac
    printf '%s' "${!mv}"; return 0
  fi
  return 1
}

REPO="mgmonteleone/mgm-pi"
LEGACY_DEFAULT_HOME="$HOME/.mgm"

if [[ -n "${KERNAL_HOME:-}" ]]; then
  HOME_DIR="$KERNAL_HOME"
elif [[ -n "${MGM_HOME:-}" && "$MGM_HOME" != "$LEGACY_DEFAULT_HOME" ]]; then
  HOME_DIR="$MGM_HOME"    # custom legacy override: honoured as the (new-named-bundle) target itself
else
  HOME_DIR="$HOME/.kernal"
fi
BIN_DIR="$(kenv BIN || true)"; BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
case "$os-$arch" in darwin-arm64|darwin-x64|linux-x64|linux-arm64) platform="$os-$arch" ;; *) echo "unsupported platform $os-$arch" >&2; exit 1 ;; esac
auth=(); [[ -n "${GH_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GH_TOKEN")
# note: bash 3.2 (macOS default) treats an empty array as unbound under set -u, hence ${auth[@]+"${auth[@]}"} below
have_gh() { command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; }

VERSION="$(kenv VERSION || true)"
BUNDLE_FILE="$(kenv BUNDLE_FILE || true)"
if [[ -z "$VERSION" ]]; then
  [[ -z "$BUNDLE_FILE" ]] || { echo "KERNAL_BUNDLE_FILE needs KERNAL_VERSION" >&2; exit 1; }
  if have_gh; then
    VERSION=$(gh release view --repo "$REPO" --json tagName --jq '.tagName' 2>/dev/null | sed 's/^v//')
  else
    VERSION=$(curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1 || true)
  fi
  [[ -n "$VERSION" ]] || { echo "could not determine the latest release of $REPO. The repo is private: log in with 'gh auth login' or set GH_TOKEN, or pass KERNAL_VERSION=x.y.z" >&2; exit 1; }
fi
name="kernal-$VERSION-$platform"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "installing kernal $VERSION ($platform) to $HOME_DIR"
if [[ -n "$BUNDLE_FILE" ]]; then
  [[ -f "$BUNDLE_FILE" ]] || { echo "no bundle at $BUNDLE_FILE" >&2; exit 1; }
  cp "$BUNDLE_FILE" "$tmp/$name.tar.gz"
  if [[ -f "$BUNDLE_FILE.sha256" ]]; then cp "$BUNDLE_FILE.sha256" "$tmp/$name.tar.gz.sha256"
  else (cd "$tmp" && { command -v sha256sum >/dev/null && sha256sum "$name.tar.gz" || shasum -a 256 "$name.tar.gz"; } > "$name.tar.gz.sha256"); fi
elif have_gh; then
  gh release download "v$VERSION" --repo "$REPO" --pattern "$name.tar.gz" --pattern "$name.tar.gz.sha256" --dir "$tmp"
elif [[ -n "${GH_TOKEN:-}" ]]; then
  # private repo without gh: resolve asset ids through the API and download them as octet-streams
  command -v python3 >/dev/null || { echo "python3 (or the gh CLI) is required to download from a private repo" >&2; exit 1; }
  curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/tags/v$VERSION" > "$tmp/release.json"
  for f in "$name.tar.gz" "$name.tar.gz.sha256"; do
    id=$(python3 -c 'import json,sys; a=[x["id"] for x in json.load(open(sys.argv[1]))["assets"] if x["name"]==sys.argv[2]]; print(a[0] if a else "")' "$tmp/release.json" "$f")
    [[ -n "$id" ]] || { echo "asset $f not found in release v$VERSION" >&2; exit 1; }
    curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/octet-stream" -o "$tmp/$f" "https://api.github.com/repos/$REPO/releases/assets/$id"
  done
else
  for f in "$name.tar.gz" "$name.tar.gz.sha256"; do curl -fsSL -o "$tmp/$f" "https://github.com/$REPO/releases/download/v$VERSION/$f"; done
fi
(cd "$tmp" && { command -v sha256sum >/dev/null && sha256sum -c "$name.tar.gz.sha256" || shasum -a 256 -c "$name.tar.gz.sha256"; } >/dev/null) || { echo "checksum mismatch" >&2; exit 1; }
mkdir -p "$HOME_DIR" "$BIN_DIR"

# --- migration from a legacy ~/.mgm install (once, idempotent) --------------------------------
# Runs before anything below reads $HOME_DIR/current or $STATE, so the rest of the script (which
# already knows how to carry a `.env` / settings.json forward across a same-tool upgrade) sees the
# migrated files as if they had always been at $HOME_DIR — except the .env key rename, which only
# this step does (MGM_* -> KERNAL_*; values are copied, never printed).
STATE="$(kenv STATE || true)"; STATE="${STATE:-$HOME_DIR/state}"
rename_env_keys() {   # $1: an .env file; stdout: the same with MGM_<X>=... -> KERNAL_<X>=...
  # Values are never touched. If the file already sets KERNAL_<X>, that line wins and the legacy
  # MGM_<X> line is dropped, so a key never appears twice. Runs on every install, not only the
  # ~/.mgm migration: an install that always lived at a custom MGM_HOME is upgraded in place and
  # would otherwise keep MGM_* keys until the fallback is removed (review of PR #22).
  awk '
    NR == FNR { if (match($0, /^KERNAL_[A-Za-z0-9_]*=/)) has[substr($0, 1, RLENGTH - 1)] = 1; next }
    /^MGM_[A-Za-z0-9_]*=/ {
      match($0, /^MGM_[A-Za-z0-9_]*=/)
      key = "KERNAL_" substr($0, 5, RLENGTH - 5)
      if (key in has) next
      print key substr($0, RLENGTH); next
    }
    { print }
  ' "$1" "$1"
}
migrate_legacy() {
  local legacy="$LEGACY_DEFAULT_HOME"
  [[ -d "$legacy" ]] || return 0
  [[ -f "$legacy/MOVED" ]] && return 0                                   # already migrated
  [[ -d "$legacy/state" || -e "$legacy/current" ]] || return 0           # nothing legacy to migrate
  echo "migrating the legacy install at $legacy to $HOME_DIR …"
  mkdir -p "$STATE"
  if [[ -d "$legacy/state" ]]; then
    # Copy-without-clobber: never overwrite something the new home already has (idempotent, and
    # safe if $HOME_DIR was not actually fresh).
    (cd "$legacy/state" && find . -type f) | while IFS= read -r f; do
      [[ -f "$STATE/$f" ]] && continue
      mkdir -p "$(dirname "$STATE/$f")" && cp -p "$legacy/state/$f" "$STATE/$f"
    done
  fi
  if [[ -f "$legacy/.update-check.json" && ! -f "$HOME_DIR/.update-check.json" ]]; then
    cp -p "$legacy/.update-check.json" "$HOME_DIR/.update-check.json"
  fi
  # .env and settings.json/settings.shipped.json are staged into $tmp under the same names the
  # normal (same-tool) upgrade path below already looks for, so that path carries them forward
  # without any extra code — it cannot tell a migrated file from one that was already there.
  if [[ -f "$legacy/current/.env" && ! -f "$tmp/settings.ours.json" && ! -s "$tmp/legacy.env" ]]; then
    rename_env_keys "$legacy/current/.env" > "$tmp/legacy.env"
  fi
  if [[ -f "$legacy/current/.pi/settings.json" ]]; then
    cp "$legacy/current/.pi/settings.json" "$tmp/settings.ours.json"
    [[ -f "$legacy/current/.pi/settings.shipped.json" ]] && cp "$legacy/current/.pi/settings.shipped.json" "$tmp/settings.base.json"
  fi
  MIGRATED_FROM_LEGACY=1
}
MIGRATED_FROM_LEGACY=0
migrate_legacy

# The outgoing version's settings, taken before anything is replaced (reinstalling the same version
# deletes its directory): what the user has now, and what that version shipped (see below). A
# migration (above) may already have staged these into $tmp; a same-tool upgrade (the normal case)
# takes precedence if both are somehow present.
keep_env=""
if [[ -f "$HOME_DIR/current/.env" ]]; then
  keep_env=$(rename_env_keys "$HOME_DIR/current/.env")
elif [[ -f "$tmp/legacy.env" ]]; then
  keep_env=$(cat "$tmp/legacy.env")
fi
if [[ -f "$HOME_DIR/current/.pi/settings.json" ]]; then
  cp "$HOME_DIR/current/.pi/settings.json" "$tmp/settings.ours.json"
  [[ -f "$HOME_DIR/current/.pi/settings.shipped.json" ]] && cp "$HOME_DIR/current/.pi/settings.shipped.json" "$tmp/settings.base.json"
fi
rm -rf "$HOME_DIR/$name" && tar xzf "$tmp/$name.tar.gz" -C "$HOME_DIR"
ln -sfn "$HOME_DIR/$name" "$HOME_DIR/current"
if [[ -n "$keep_env" ]]; then
  # keep the user's .env; add only keys the bundle ships that the user does not have yet
  shipped=""; [[ -f "$HOME_DIR/current/.env" ]] && shipped=$(cat "$HOME_DIR/current/.env")
  printf '%s\n' "$keep_env" > "$HOME_DIR/current/.env"
  printf '%s\n' "$shipped" | { grep -E '^[A-Z0-9_]+=' || true; } | while IFS= read -r line; do k=${line%%=*}; grep -q "^$k=." "$HOME_DIR/current/.env" || printf '%s\n' "$line" >> "$HOME_DIR/current/.env"; done
fi
# State that belongs to you, not to a version: sessions, credentials, trust decisions and caches. A
# bundle lives in a versioned directory, so PI_CODING_AGENT_DIR moves on every upgrade and anything
# written inside it would be stranded there — session history most painfully, since `--session <id>`
# only looks in the current agent dir. Keep it in $HOME_DIR/state and link it into the bundle, so an
# upgrade changes nothing but the code. Existing state is gathered from older bundles once.
mkdir -p "$STATE/sessions"
for old_dir in "$HOME_DIR"/kernal-*-"$platform"; do
  [[ -d "$old_dir/.pi/sessions" && ! -L "$old_dir/.pi/sessions" ]] || continue
  for project in "$old_dir/.pi/sessions"/*; do
    [[ -d "$project" ]] || continue
    target="$STATE/sessions/$(basename "$project")"; mkdir -p "$target"
    for f in "$project"/*.jsonl; do [[ -f "$f" ]] && [[ ! -f "$target/$(basename "$f")" ]] && cp "$f" "$target/"; done
  done
done
# Agents you write (pi-subagents' user scope is $PI_CODING_AGENT_DIR/agents, the admin's editor and
# the subagent tool's create/eject write there) are yours too. Gather any from older bundles once.
mkdir -p "$STATE/agents"
for old_dir in "$HOME_DIR"/kernal-*-"$platform"; do
  [[ -d "$old_dir/.pi/agents" && ! -L "$old_dir/.pi/agents" ]] || continue
  (cd "$old_dir/.pi/agents" && find . -type f -name "*.md") | while IFS= read -r f; do
    [[ -f "$STATE/agents/$f" ]] && continue
    mkdir -p "$(dirname "$STATE/agents/$f")" && cp "$old_dir/.pi/agents/$f" "$STATE/agents/$f"
  done
done
for name in sessions bug-reports agents; do
  mkdir -p "$STATE/$name"
  rm -rf "$HOME_DIR/current/.pi/$name"
  ln -sfn "$STATE/$name" "$HOME_DIR/current/.pi/$name"
done
for name in auth.json trust.json models-store.json mcp-cache.json; do
  if [[ ! -f "$STATE/$name" ]]; then
    for old_dir in "$HOME_DIR"/kernal-*-"$platform"; do
      [[ -f "$old_dir/.pi/$name" && ! -L "$old_dir/.pi/$name" ]] && cp "$old_dir/.pi/$name" "$STATE/$name" && break
    done
  fi
  [[ -f "$STATE/$name" ]] || continue
  rm -f "$HOME_DIR/current/.pi/$name"
  ln -sf "$STATE/$name" "$HOME_DIR/current/.pi/$name"
done
# Settings: settings.json is both the release's defaults and where every choice is saved (default
# model, subagent models, /settings, installed packages), so it cannot be linked into state like the
# rest, nor copied forward whole. Each bundle keeps a pristine settings.shipped.json; the user's changes
# relative to the old one are merged over the new release's settings (.pi/extensions/connect/settings.ts
# has the rules). The bundle has no Node, but its pi binary is a Bun executable that runs TypeScript.
new_pi="$HOME_DIR/current/.pi"
[[ -f "$new_pi/settings.shipped.json" ]] || cp "$new_pi/settings.json" "$new_pi/settings.shipped.json"
if [[ -f "$tmp/settings.ours.json" ]]; then
  cp "$tmp/settings.ours.json" "$STATE/settings.previous.json"
  merge=(--ours "$tmp/settings.ours.json" --theirs "$new_pi/settings.shipped.json" --out "$new_pi/settings.json")
  [[ -f "$tmp/settings.base.json" ]] && merge+=(--base "$tmp/settings.base.json")
  merged=0
  if [[ -x "$HOME_DIR/current/pi/pi" ]] && BUN_BE_BUN=1 "$HOME_DIR/current/pi/pi" "$new_pi/extensions/connect/settings-merge.ts" "${merge[@]}"; then merged=1
  elif command -v node >/dev/null 2>&1 && node "$new_pi/extensions/connect/settings-merge.ts" "${merge[@]}"; then merged=1; fi
  [[ $merged == 1 ]] || echo "warning: could not carry your settings forward; this release's defaults apply. Your previous settings: $STATE/settings.previous.json" >&2
fi
sessions=$(find "$STATE/sessions" -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')
echo "state: $STATE (${sessions} sessions carried over, shared by every version)"

ln -sf "$HOME_DIR/current/bin/kernal" "$BIN_DIR/kernal"
echo "installed: $HOME_DIR/current  →  $BIN_DIR/kernal"

# Finish the legacy migration: leave ~/.mgm in place (nothing there is deleted) but point its
# `current` at the new install, and mark it moved so this whole step is skipped from now on.
if [[ "$MIGRATED_FROM_LEGACY" == 1 ]]; then
  ln -sfn "$HOME_DIR/current" "$LEGACY_DEFAULT_HOME/current"
  cat > "$LEGACY_DEFAULT_HOME/MOVED" <<EOF
This install moved to $HOME_DIR on $(date -u +%Y-%m-%dT%H:%M:%SZ).
mgm is now called Kernal (docs/rename.md in the kernal repo); both commands keep working. Your sessions, credentials, trust decisions,
caches and settings were copied to $STATE and $HOME_DIR/current — nothing here was modified or
deleted. This directory ($LEGACY_DEFAULT_HOME) is safe to delete once you have confirmed
'kernal version' and your sessions look right; 'current' here is now just a symlink to the new
install, kept only so old scripts/aliases pointing at $LEGACY_DEFAULT_HOME/current still work.
EOF
  echo "legacy install at $LEGACY_DEFAULT_HOME migrated (see $LEGACY_DEFAULT_HOME/MOVED); safe to delete once you're happy with the new install"
fi

# ~/.local/bin/mgm: a permanent, silent alias for kernal (the owner's choice: it is his initials and
# years of muscle memory). A plain link to the same launcher, so both names behave identically and
# follow every upgrade. It replaces whatever was there before, which on a real install is always
# the old install.sh's own symlink to the legacy bundle's bin/mgm, never something hand-written.
rm -f "$BIN_DIR/mgm"
ln -s "$HOME_DIR/current/bin/kernal" "$BIN_DIR/mgm"

if ! command -v rec >/dev/null 2>&1 && ! command -v ffmpeg >/dev/null 2>&1 && ! command -v arecord >/dev/null 2>&1; then
  case "$os" in darwin) echo "voice input needs an audio capture tool: brew install sox" ;; linux) echo "voice input needs an audio capture tool: sudo apt install sox" ;; esac
fi
[[ -f "$HOME_DIR/current/.env" ]] || echo "next: cp $HOME_DIR/current/.env.example $HOME_DIR/current/.env and add your keys"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "add $BIN_DIR to your PATH" ;; esac
