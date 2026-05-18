#!/usr/bin/env bash
set -euo pipefail

if command -v blender >/dev/null 2>&1; then
  blender --version | head -n 1
  exit 0
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update
  $SUDO apt-get install -y --no-install-recommends blender
  blender --version | head -n 1
  exit 0
fi

if command -v snap >/dev/null 2>&1; then
  $SUDO snap install blender --classic
  blender --version | head -n 1
  exit 0
fi

echo "No supported package manager found. Install Blender and set BLENDER_BIN if it is not on PATH." >&2
exit 1
