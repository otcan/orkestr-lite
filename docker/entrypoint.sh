#!/usr/bin/env bash
set -euo pipefail

orkestr_home="${ORKESTR_HOME:-/data}"
active_codex_home="${CODEX_HOME:-/codex}"
workspace_home="${ORKESTR_WORKSPACE:-/workspace}"
legacy_codex_home="${orkestr_home}/codex"
legacy_merge_marker="${active_codex_home}/.orkestr-legacy-merge-v1"

mkdir -p \
  "${orkestr_home}" \
  "${legacy_codex_home}" \
  "${active_codex_home}" \
  "${workspace_home}"
chmod 0700 "${orkestr_home}" "${legacy_codex_home}" "${active_codex_home}"

if [[ "${active_codex_home}" != "${legacy_codex_home}" \
  && -d "${legacy_codex_home}" \
  && ! -e "${legacy_merge_marker}" ]]; then
  # The Desk may initialize CODEX_HOME before the control container starts.
  # Merge missing legacy state instead of requiring the destination to be empty.
  # Existing files in the shared CODEX_HOME always win.
  cp -a --update=none "${legacy_codex_home}/." "${active_codex_home}/"
  touch "${legacy_merge_marker}"
fi

if [[ -z "$(find "${workspace_home}" -mindepth 1 -maxdepth 1 ! -name .gitkeep -print -quit)" ]]; then
  rm -f "${workspace_home}/.gitkeep"
  cp -a /opt/orkestr-demo/. "${workspace_home}/"
  git -C "${workspace_home}" init -b main >/dev/null
  git -C "${workspace_home}" config user.name "Orkestr Demo"
  git -C "${workspace_home}" config user.email "demo@orkestr.local"
  git -C "${workspace_home}" add .
  git -C "${workspace_home}" commit -m "chore: seed deterministic demo" >/dev/null
fi

exec node /app/dist/server/main.js
