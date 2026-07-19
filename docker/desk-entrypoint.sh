#!/usr/bin/env bash
set -euo pipefail

auth_dir="$(dirname "${ORKESTR_DESK_TOKEN_FILE:-/run/orkestr-desk-auth/token}")"
token_file="${ORKESTR_DESK_TOKEN_FILE:-/run/orkestr-desk-auth/token}"
mkdir -p "$auth_dir" /home/orkestr /codex /workspace

if [[ ! -s "$token_file" ]]; then
  umask 077
  head -c 32 /dev/urandom | base64 | tr -d '\n' > "$token_file"
fi
chmod 0400 "$token_file"

exec node /app/dist/server/desk-agent/main.js
