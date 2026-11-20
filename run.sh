#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PY=python3
if ! command -v "$PY" >/dev/null 2>&1; then
  PY=python
fi

exec "$PY" app.py "$@"
