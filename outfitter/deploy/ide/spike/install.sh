#!/bin/sh
# Browser IDE spike S2 (docs/specs/browser-ide.md §2): stream the pinned code-server release into tar
# through a SHA-256 check, unpacking into a temp dir that is moved into place only on a match.
# Usage (as root): install.sh <version> <sha256> [dest]   -- arch from uname -m.
set -eu
VERSION=$1; WANT=$2; DEST=${3:-/opt/code-server}
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "unsupported arch" >&2; exit 2 ;; esac
URL="https://github.com/coder/code-server/releases/download/v${VERSION}/code-server-${VERSION}-linux-${ARCH}.tar.gz"
TMP=$(mktemp -d "${DEST}.tmp.XXXXXX")
FIFO="$TMP.fifo"; mkfifo "$FIFO"
trap 'rm -rf "$TMP" "$FIFO" "$TMP.sum"' EXIT
start=$(date +%s.%N)
sha256sum < "$FIFO" | cut -d' ' -f1 > "$TMP.sum" &
curl -fsSL --retry 2 "$URL" | tee "$FIFO" | nice -n 10 tar xz -C "$TMP" --strip-components=1
wait
end=$(date +%s.%N)
GOT=$(cat "$TMP.sum")
if [ "$GOT" != "$WANT" ]; then echo "checksum mismatch: got $GOT" >&2; exit 1; fi
rm -rf "$DEST"; mv "$TMP" "$DEST"; chown -R root:root "$DEST"; chmod -R go-w "$DEST"; chmod 755 "$DEST"   # mktemp -d made it 0700
echo "{\"arch\":\"$ARCH\",\"version\":\"$VERSION\",\"seconds\":$(awk "BEGIN {print $end - $start}"),\"bytes\":$(du -sb "$DEST" | cut -f1)}"
