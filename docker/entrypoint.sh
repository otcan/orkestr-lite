#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${ORKESTR_HOME:-/data}" "${CODEX_HOME:-/data/codex}" "${ORKESTR_WORKSPACE:-/workspace}"

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
