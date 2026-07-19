#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 1 && "$1" =~ ^https?:// ]]; then
  browser_profile="${HOME:-/home/orkestr}/.config/google-chrome"
  if ! pgrep -f "chromium.*--user-data-dir=${browser_profile}" >/dev/null 2>&1; then
    rm -f \
      "${browser_profile}/SingletonCookie" \
      "${browser_profile}/SingletonLock" \
      "${browser_profile}/SingletonSocket"
  fi
  exec chromium \
    --no-sandbox \
    --disable-dev-shm-usage \
    --user-data-dir="${browser_profile}" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 \
    "$1"
fi

exec /usr/bin/xdg-open "$@"
