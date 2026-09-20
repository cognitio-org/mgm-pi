#!/usr/bin/env bash
# Install or update the mgm agent from a GitHub release bundle.
#   curl -fsSL https://github.com/mgmonteleone/mgm-pi/releases/latest/download/install.sh | bash
#   MGM_VERSION=0.2.0 ... | bash          # a specific release
#   MGM_HOME=~/tools/mgm ... | bash        # install location (default ~/.mgm)
# Needs curl and tar; for a private repo either the gh CLI (logged in) or GH_TOKEN plus python3. Puts `mgm` on PATH via ~/.local/bin.
set -euo pipefail
REPO="mgmonteleone/mgm-pi"; HOME_DIR="${MGM_HOME:-$HOME/.mgm}"; BIN_DIR="${MGM_BIN:-$HOME/.local/bin}"
os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
case "$os-$arch" in darwin-arm64|darwin-x64|linux-x64|linux-arm64) platform="$os-$arch" ;; *) echo "unsupported platform $os-$arch" >&2; exit 1 ;; esac
auth=(); [[ -n "${GH_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GH_TOKEN")
# note: bash 3.2 (macOS default) treats an empty array as unbound under set -u, hence ${auth[@]+"${auth[@]}"} below
have_gh() { command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; }
if [[ -z "${MGM_VERSION:-}" ]]; then
  if have_gh; then
    MGM_VERSION=$(gh release view --repo "$REPO" --json tagName --jq '.tagName' 2>/dev/null | sed 's/^v//')
  else
    MGM_VERSION=$(curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1 || true)
  fi
  [[ -n "$MGM_VERSION" ]] || { echo "could not determine the latest release of $REPO. The repo is private: log in with 'gh auth login' or set GH_TOKEN, or pass MGM_VERSION=x.y.z" >&2; exit 1; }
fi
name="mgm-$MGM_VERSION-$platform"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "installing mgm $MGM_VERSION ($platform) to $HOME_DIR"
if have_gh; then
  gh release download "v$MGM_VERSION" --repo "$REPO" --pattern "$name.tar.gz" --pattern "$name.tar.gz.sha256" --dir "$tmp"
elif [[ -n "${GH_TOKEN:-}" ]]; then
  # private repo without gh: resolve asset ids through the API and download them as octet-streams
  command -v python3 >/dev/null || { echo "python3 (or the gh CLI) is required to download from a private repo" >&2; exit 1; }
  curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/tags/v$MGM_VERSION" > "$tmp/release.json"
  for f in "$name.tar.gz" "$name.tar.gz.sha256"; do
    id=$(python3 -c 'import json,sys; a=[x["id"] for x in json.load(open(sys.argv[1]))["assets"] if x["name"]==sys.argv[2]]; print(a[0] if a else "")' "$tmp/release.json" "$f")
    [[ -n "$id" ]] || { echo "asset $f not found in release v$MGM_VERSION" >&2; exit 1; }
    curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/octet-stream" -o "$tmp/$f" "https://api.github.com/repos/$REPO/releases/assets/$id"
  done
else
  for f in "$name.tar.gz" "$name.tar.gz.sha256"; do curl -fsSL -o "$tmp/$f" "https://github.com/$REPO/releases/download/v$MGM_VERSION/$f"; done
fi
(cd "$tmp" && { command -v sha256sum >/dev/null && sha256sum -c "$name.tar.gz.sha256" || shasum -a 256 -c "$name.tar.gz.sha256"; } >/dev/null) || { echo "checksum mismatch" >&2; exit 1; }
mkdir -p "$HOME_DIR" "$BIN_DIR"
keep_env=""; [[ -f "$HOME_DIR/current/.env" ]] && keep_env=$(cat "$HOME_DIR/current/.env")
rm -rf "$HOME_DIR/$name" && tar xzf "$tmp/$name.tar.gz" -C "$HOME_DIR"
ln -sfn "$HOME_DIR/$name" "$HOME_DIR/current"
if [[ -n "$keep_env" ]]; then
  # keep the user's .env; add only keys the bundle ships that the user does not have yet
  shipped=""; [[ -f "$HOME_DIR/current/.env" ]] && shipped=$(cat "$HOME_DIR/current/.env")
  printf '%s\n' "$keep_env" > "$HOME_DIR/current/.env"
  printf '%s\n' "$shipped" | grep -E '^[A-Z0-9_]+=' | while IFS= read -r line; do k=${line%%=*}; grep -q "^$k=." "$HOME_DIR/current/.env" || printf '%s\n' "$line" >> "$HOME_DIR/current/.env"; done
fi
# State that belongs to you, not to a version: sessions, credentials, trust decisions and caches. A
# bundle lives in a versioned directory, so PI_CODING_AGENT_DIR moves on every upgrade and anything
# written inside it would be stranded there — session history most painfully, since `--session <id>`
# only looks in the current agent dir. Keep it in $HOME_DIR/state and link it into the bundle, so an
# upgrade changes nothing but the code. Existing state is gathered from older bundles once.
STATE="${MGM_STATE:-$HOME_DIR/state}"
mkdir -p "$STATE/sessions"
for old_dir in "$HOME_DIR"/mgm-*-"$platform"; do
  [[ -d "$old_dir/.pi/sessions" && ! -L "$old_dir/.pi/sessions" ]] || continue
  for project in "$old_dir/.pi/sessions"/*; do
    [[ -d "$project" ]] || continue
    target="$STATE/sessions/$(basename "$project")"; mkdir -p "$target"
    for f in "$project"/*.jsonl; do [[ -f "$f" ]] && [[ ! -f "$target/$(basename "$f")" ]] && cp "$f" "$target/"; done
  done
done
for name in sessions bug-reports; do
  mkdir -p "$STATE/$name"
  rm -rf "$HOME_DIR/current/.pi/$name"
  ln -sfn "$STATE/$name" "$HOME_DIR/current/.pi/$name"
done
for name in auth.json trust.json models-store.json mcp-cache.json; do
  if [[ ! -f "$STATE/$name" ]]; then
    for old_dir in "$HOME_DIR"/mgm-*-"$platform"; do
      [[ -f "$old_dir/.pi/$name" && ! -L "$old_dir/.pi/$name" ]] && cp "$old_dir/.pi/$name" "$STATE/$name" && break
    done
  fi
  [[ -f "$STATE/$name" ]] || continue
  rm -f "$HOME_DIR/current/.pi/$name"
  ln -sf "$STATE/$name" "$HOME_DIR/current/.pi/$name"
done
sessions=$(find "$STATE/sessions" -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')
echo "state: $STATE (${sessions} sessions carried over, shared by every version)"

ln -sf "$HOME_DIR/current/bin/mgm" "$BIN_DIR/mgm"
echo "installed: $HOME_DIR/current  →  $BIN_DIR/mgm"
if ! command -v rec >/dev/null 2>&1 && ! command -v ffmpeg >/dev/null 2>&1 && ! command -v arecord >/dev/null 2>&1; then
  case "$os" in darwin) echo "voice input needs an audio capture tool: brew install sox" ;; linux) echo "voice input needs an audio capture tool: sudo apt install sox" ;; esac
fi
[[ -f "$HOME_DIR/current/.env" ]] || echo "next: cp $HOME_DIR/current/.env.example $HOME_DIR/current/.env and add your keys"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "add $BIN_DIR to your PATH" ;; esac
