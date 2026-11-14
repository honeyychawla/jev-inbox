#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js LTS from https://nodejs.org/en/download, then open this file again."
  read -r -p "Press Enter to close. "
  exit 1
fi
node scripts/start.mjs --open
result=$?
if [ "$result" -ne 0 ]; then read -r -p "Press Enter to close. "; fi
exit "$result"

