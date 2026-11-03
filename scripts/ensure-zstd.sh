#!/usr/bin/env bash
set -euo pipefail

if ! command -v zstd >/dev/null 2>&1; then
  case "${RUNNER_OS:-$(uname -s)}" in
    macOS|Darwin) brew install zstd ;;
    Linux)
      sudo apt-get update
      sudo apt-get install --yes --no-install-recommends zstd
      ;;
    *) echo 'zstd is required to build and inspect release archives' >&2; exit 1 ;;
  esac
fi
zstd --version
