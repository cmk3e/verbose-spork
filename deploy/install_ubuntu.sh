#!/usr/bin/env bash
# One-shot installer for an Ubuntu VM (e.g. AWS EC2). Re-run it to update.
#
#   curl -fsSL https://raw.githubusercontent.com/cmk3e/verbose-spork/claude/horse-race-tote-handicapper-3lvvip/deploy/install_ubuntu.sh | bash
#
# It asks for a dashboard password (or pass one as the first argument).
# Installs to ~/verbose-spork, runs as a systemd service that restarts on
# failure and on reboot, and serves the dashboard on port 8000 behind a
# password (username: tote).
set -euo pipefail

PASSWORD="${1:-}"
if [ -z "$PASSWORD" ] && [ -f /etc/tote-handicapper.env ]; then
  KEEP_PASSWORD=1  # re-run to update: keep the existing password
elif [ -z "$PASSWORD" ]; then
  read -r -s -p "Choose a dashboard password: " PASSWORD </dev/tty; echo
  [ -n "$PASSWORD" ] || { echo "A password is required." >&2; exit 1; }
fi
REPO="https://github.com/cmk3e/verbose-spork.git"
BRANCH="${BRANCH:-claude/horse-race-tote-handicapper-3lvvip}"
DIR="$HOME/verbose-spork"
PORT="${PORT:-8000}"

sudo apt-get update -qq
sudo apt-get install -y -qq git python3 >/dev/null

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi

# Keep an existing config.json; otherwise start from the example, opened to the network.
if [ ! -f "$DIR/config.json" ]; then
  python3 - "$DIR" "$PORT" <<'PY'
import json, sys
d, port = sys.argv[1], int(sys.argv[2])
cfg = json.load(open(f"{d}/config.example.json"))
cfg = {k: v for k, v in cfg.items() if not k.startswith("_")}
cfg["web"] = {"host": "0.0.0.0", "port": port}
json.dump(cfg, open(f"{d}/config.json", "w"), indent=2)
PY
fi

sudo tee /etc/systemd/system/tote-handicapper.service >/dev/null <<UNIT
[Unit]
Description=Tote Handicapper
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
EnvironmentFile=/etc/tote-handicapper.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 -m tote_handicapper run --config config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
if [ -z "${KEEP_PASSWORD:-}" ]; then
  printf 'TOTE_DASHBOARD_PASSWORD=%s\n' "$PASSWORD" | sudo tee /etc/tote-handicapper.env >/dev/null
  sudo chmod 600 /etc/tote-handicapper.env
fi

sudo systemctl daemon-reload
sudo systemctl enable -q tote-handicapper
sudo systemctl restart tote-handicapper
sleep 2
sudo systemctl --no-pager --lines=5 status tote-handicapper || true

IP=$(curl -fsS --max-time 3 https://checkip.amazonaws.com 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "Dashboard: http://$IP:$PORT   (username: tote)"
echo "If it doesn't load, open port $PORT in the instance's security group."
echo "Logs:      journalctl -u tote-handicapper -f"
