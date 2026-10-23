#!/usr/bin/env bash
# Open a public odds page in headless Chrome and record how it delivers odds. Results: http://VM:8000/discovery
#   sudo bash /opt/totebot/deploy/discover.sh "https://www.nyra.com/belmont/racing/" --track "Race 5"
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: discover.sh URL [--track TEXT] [--watch SECONDS]"; exit 1; }
URL="$1"; shift
APP_DIR=/opt/totebot
VENV="$APP_DIR/.venv"
export PLAYWRIGHT_BROWSERS_PATH="$APP_DIR/.pw-browsers"

if ! "$VENV/bin/python" -c "import playwright" 2>/dev/null || [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  echo "Installing headless Chromium (one time, a few minutes)..."
  "$VENV/bin/pip" install -q -r "$APP_DIR/requirements-amwager.txt"
  "$VENV/bin/python" -m playwright install --with-deps chromium
  chown -R totebot:totebot "$PLAYWRIGHT_BROWSERS_PATH"
fi

DATA_DIR=$(grep -E '^DATA_DIR=' /etc/totebot.env | cut -d= -f2 || true)
DATA_DIR=${DATA_DIR:-/var/lib/totebot}
cd "$APP_DIR"
DATA_DIR="$DATA_DIR" "$VENV/bin/python" -m totebot.tools.amwager_discover --no-login --start-url "$URL" --track "" "$@"
chown -R totebot:totebot "$DATA_DIR/discovery"
