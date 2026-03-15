#!/usr/bin/env bash
# DEW Eco Warden - Create Python virtual environment and install dependencies
# Run from project root: ./scripts/setup_venv.sh

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/venv"

if [ -d "$VENV" ]; then
  echo "venv already exists at $VENV"
else
  echo "Creating virtual environment at $VENV ..."
  python3 -m venv "$VENV"
fi

echo "Installing dependencies from requirements.txt ..."
"$VENV/bin/pip" install -r "$ROOT/requirements.txt"
echo "Done. Activate with: source venv/bin/activate"
