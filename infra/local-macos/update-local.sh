#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
python=${PYTHON:-"$root/.venv-codegen/bin/python"}
if [ ! -x "$python" ]; then
  echo "Missing $python. Use the existing project .venv-codegen, or set PYTHON." >&2
  exit 1
fi
exec "$python" "$root/infra/local-macos/update.py" "$@"
