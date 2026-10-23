#!/usr/bin/env bash
# Log in to AmWager, open a track, and record how odds are delivered. Results: http://VM:8000/discovery
#   sudo bash deploy/amwager-discover.sh --track Belmont
set -euo pipefail
APP_DIR=/opt/totebot
VENV="$APP_DIR/.venv"
export PLAYWRIGHT_BROWSERS_PATH="$APP_DIR/.pw-browsers"

if ! grep -q '^AMWAGER_USERNAME=.\+' /etc/totebot.env || ! grep -q '^AMWAGER_PASSWORD=.\+' /etc/totebot.env; then
  echo "Add your login to /etc/totebot.env first:"
  echo "  AMWAGER_USERNAME=..."
  echo "  AMWAGER_PASSWORD=..."
  exit 1
fi

if ! "$VENV/bin/python" -c "import playwright" 2>/dev/null || [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  echo "Installing headless Chromium (one time, a few minutes)..."
  "$VENV/bin/pip" install -q -r "$APP_DIR/requirements-amwager.txt"
  "$VENV/bin/python" -m playwright install --with-deps chromium
  chown -R totebot:totebot "$PLAYWRIGHT_BROWSERS_PATH"
fi

DATA_DIR=$(grep -E '^DATA_DIR=' /etc/totebot.env | cut -d= -f2)
DATA_DIR=${DATA_DIR:-/var/lib/totebot}
cd "$APP_DIR"
DATA_DIR="$DATA_DIR" "$VENV/bin/python" -m totebot.tools.amwager_discover "$@"
chown -R totebot:totebot "$DATA_DIR/discovery"
