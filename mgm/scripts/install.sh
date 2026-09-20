#!/usr/bin/env bash
# Install or update the mgm agent from a GitHub release bundle.
#   curl -fsSL https://github.com/mgmonteleone/localllm/releases/latest/download/install.sh | bash
#   MGM_VERSION=0.2.0 ... | bash          # a specific release
#   MGM_HOME=~/tools/mgm ... | bash        # install location (default ~/.mgm)
# Needs curl, tar and a GitHub token in GH_TOKEN for private repos. Puts `mgm` on PATH via ~/.local/bin.
set -euo pipefail
REPO="mgmonteleone/localllm"; HOME_DIR="${MGM_HOME:-$HOME/.mgm}"; BIN_DIR="${MGM_BIN:-$HOME/.local/bin}"
os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
case "$os-$arch" in darwin-arm64|darwin-x64|linux-x64|linux-arm64) platform="$os-$arch" ;; *) echo "unsupported platform $os-$arch" >&2; exit 1 ;; esac
auth=(); [[ -n "${GH_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GH_TOKEN")
if [[ -z "${MGM_VERSION:-}" ]]; then
  MGM_VERSION=$(curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)
  [[ -n "$MGM_VERSION" ]] || { echo "could not determine the latest release (private repo? set GH_TOKEN)" >&2; exit 1; }
fi
name="mgm-$MGM_VERSION-$platform"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "installing mgm $MGM_VERSION ($platform) to $HOME_DIR"
if [[ -n "${GH_TOKEN:-}" ]]; then
  # private repo: resolve the asset id and download through the API
  assets=$(curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/tags/v$MGM_VERSION")
  for f in "$name.tar.gz" "$name.tar.gz.sha256"; do
    id=$(printf '%s' "$assets" | tr ',' '\n' | grep -B3 "\"name\": *\"$f\"" | sed -n 's/.*"id": *\([0-9]*\).*/\1/p' | tail -1)
    [[ -n "$id" ]] || { echo "asset $f not found in release v$MGM_VERSION" >&2; exit 1; }
    curl -fsSL "${auth[@]}" -H "Accept: application/octet-stream" -o "$tmp/$f" "https://api.github.com/repos/$REPO/releases/assets/$id"
  done
else
  for f in "$name.tar.gz" "$name.tar.gz.sha256"; do curl -fsSL -o "$tmp/$f" "https://github.com/$REPO/releases/download/v$MGM_VERSION/$f"; done
fi
(cd "$tmp" && { command -v sha256sum >/dev/null && sha256sum -c "$name.tar.gz.sha256" || shasum -a 256 -c "$name.tar.gz.sha256"; } >/dev/null) || { echo "checksum mismatch" >&2; exit 1; }
mkdir -p "$HOME_DIR" "$BIN_DIR"
keep_env=""; [[ -f "$HOME_DIR/current/.env" ]] && keep_env=$(cat "$HOME_DIR/current/.env")
rm -rf "$HOME_DIR/$name" && tar xzf "$tmp/$name.tar.gz" -C "$HOME_DIR"
ln -sfn "$HOME_DIR/$name" "$HOME_DIR/current"
[[ -n "$keep_env" ]] && printf '%s\n' "$keep_env" > "$HOME_DIR/current/.env"
ln -sf "$HOME_DIR/current/bin/mgm" "$BIN_DIR/mgm"
echo "installed: $HOME_DIR/current  →  $BIN_DIR/mgm"
[[ -f "$HOME_DIR/current/.env" ]] || echo "next: cp $HOME_DIR/current/.env.example $HOME_DIR/current/.env and add your keys"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "add $BIN_DIR to your PATH" ;; esac
