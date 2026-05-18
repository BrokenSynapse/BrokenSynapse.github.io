#!/usr/bin/env bash
set -euo pipefail

TARGET="${KN5_CONVERTER_DIR:-/opt/kn5-obj-converter}"
REPO="${KN5_CONVERTER_REPO:-https://github.com/MarvinSt/kn5-obj-converter.git}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update
  $SUDO apt-get install -y --no-install-recommends git python3 python3-numpy p7zip-full
fi

if [ ! -d "$TARGET/.git" ]; then
  $SUDO mkdir -p "$(dirname "$TARGET")"
  $SUDO git clone "$REPO" "$TARGET"
else
  $SUDO git -C "$TARGET" pull --ff-only
fi

echo "KN5 converter installed at $TARGET/convert.py"
