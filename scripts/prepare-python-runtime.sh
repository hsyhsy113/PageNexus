#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="${ROOT_DIR}/python"
VENV_DIR="${PY_DIR}/venv"
REQ_FILE="${PY_DIR}/requirements.txt"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found in PATH"
  exit 1
fi

echo "Preparing Python runtime at ${VENV_DIR}"
rm -rf "${VENV_DIR}"
python3 -m venv "${VENV_DIR}"

"${VENV_DIR}/bin/python3" -m pip install --upgrade pip wheel
"${VENV_DIR}/bin/python3" -m pip install -r "${REQ_FILE}"

echo "Python runtime prepared."
