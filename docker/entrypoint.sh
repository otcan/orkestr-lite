#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${ORKESTR_HOME:-/data}" "${CODEX_HOME:-/codex}" "${ORKESTR_WORKSPACE:-/workspace}"

legacy_codex_home="${ORKESTR_HOME:-/data}/codex"
active_codex_home="${CODEX_HOME:-/codex}"
legacy_merge_marker="${active_codex_home}/.orkestr-legacy-merge-v1"

if [[ "${active_codex_home}" != "${legacy_codex_home}" \
  && -d "${legacy_codex_home}" \
  && ! -e "${legacy_merge_marker}" ]]; then
  # The Desk may initialize CODEX_HOME before the control container starts.
  # Merge missing legacy state instead of requiring the destination to be empty.
  # Existing files in the shared CODEX_HOME always win.
  cp -a --update=none "${legacy_codex_home}/." "${active_codex_home}/"
  touch "${legacy_merge_marker}"
fi

if [[ -z "$(find "${ORKESTR_WORKSPACE:-/workspace}" -mindepth 1 -maxdepth 1 ! -name .gitkeep -print -quit)" ]]; then
  rm -f "${ORKESTR_WORKSPACE:-/workspace}/.gitkeep"
  cp -a /opt/orkestr-demo/. "${ORKESTR_WORKSPACE:-/workspace}/"
  git -C "${ORKESTR_WORKSPACE:-/workspace}" init -b main >/dev/null
  git -C "${ORKESTR_WORKSPACE:-/workspace}" config user.name "Orkestr Demo"
  git -C "${ORKESTR_WORKSPACE:-/workspace}" config user.email "demo@orkestr.local"
  git -C "${ORKESTR_WORKSPACE:-/workspace}" add .
  git -C "${ORKESTR_WORKSPACE:-/workspace}" commit -m "chore: seed deterministic demo" >/dev/null
fi

exec node /app/dist/server/main.js
