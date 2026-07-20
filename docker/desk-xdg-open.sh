#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 1 && ( "$1" =~ ^(https?|file):// || -f "$1" ) ]]; then
  browser_profile="${HOME:-/home/orkestr}/.config/chromium"
  target="$1"
  if [[ -f "$target" ]]; then
    target="file://$(realpath -- "$target")"
  fi
  token_file="${ORKESTR_DESK_TOKEN_FILE:-/run/orkestr-desk-auth/token}"
  if [[ -s "$token_file" ]]; then
    token="$(<"$token_file")"
    if curl --silent --show-error --fail \
      --request POST \
      --header "Authorization: Bearer ${token}" \
      --get \
      --data-urlencode "url=${target}" \
      http://127.0.0.1:3100/actions/open-browser \
      >/dev/null; then
      exit 0
    fi
  fi
  exec /usr/bin/chromium \
    --no-sandbox \
    --disable-dev-shm-usage \
    --user-data-dir="${browser_profile}" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 \
    "$target"
fi

exec /usr/bin/xdg-open "$@"
