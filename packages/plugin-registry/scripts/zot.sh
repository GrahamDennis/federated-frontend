#!/usr/bin/env bash
# Download (once) and run a standalone zot OCI registry — no Docker required.
# Usage: packages/plugin-registry/scripts/zot.sh
# Override the version with ZOT_VERSION=v2.1.2.
set -euo pipefail

ZOT_VERSION="${ZOT_VERSION:-v2.1.2}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HERE/.bin"
BIN="$BIN_DIR/zot"

case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=amd64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

if [[ ! -x "$BIN" ]]; then
  URL="https://github.com/project-zot/zot/releases/download/${ZOT_VERSION}/zot-${OS}-${ARCH}"
  echo "Downloading zot ${ZOT_VERSION} (${OS}/${ARCH}) -> $BIN"
  mkdir -p "$BIN_DIR"
  curl -fSL "$URL" -o "$BIN"
  chmod +x "$BIN"
fi

# Run from the package dir so zot-config.json's relative `rootDirectory`
# (.zot/data) lands here (gitignored), not in the invocation cwd.
cd "$HERE"
mkdir -p .zot/data
echo "Starting zot on http://localhost:5001 (Ctrl-C to stop)"
exec "$BIN" serve zot-config.json
