#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js LTS from https://nodejs.org/en/download, then try again."
  exit 1
fi
exec node scripts/start.mjs --open

