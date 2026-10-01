# Sourced by the toolkit scripts: checks dependencies and picks the Python that has them.
# Everything installs with Homebrew:
#   brew install ffmpeg numpy pillow
# Homebrew's numpy/pillow live in Homebrew's own python3, so prefer that over macOS's
# /usr/bin/python3. Override with PYTHON=/path/to/python3.

BREW_INSTALL="brew install ffmpeg numpy pillow"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install with: $BREW_INSTALL" >&2
  exit 1
fi

if [ -z "${PYTHON:-}" ]; then
  if command -v brew >/dev/null 2>&1 && [ -x "$(brew --prefix)/bin/python3" ]; then
    PYTHON="$(brew --prefix)/bin/python3"
  else
    PYTHON=python3
  fi
fi

if [ "${NEED_PYTHON:-0}" = 1 ] && ! "$PYTHON" -c "import numpy, PIL" 2>/dev/null; then
  echo "numpy/Pillow not importable from $PYTHON. Install with: $BREW_INSTALL" >&2
  exit 1
fi
