#!/usr/bin/env bash
# One-time setup on Ubuntu. Run from the cloned repo:  sudo bash deploy/install.sh
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/totebot

apt-get update -y
apt-get install -y python3 python3-venv rsync

id totebot >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin totebot
mkdir -p "$APP_DIR" /var/lib/totebot
rsync -a --delete --exclude .git --exclude .venv --exclude data "$REPO_DIR"/ "$APP_DIR"/
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
chown -R totebot:totebot "$APP_DIR" /var/lib/totebot

if [ ! -f /etc/totebot.env ]; then
  cp "$APP_DIR/deploy/totebot.env.example" /etc/totebot.env
  PW=$(python3 -c "import secrets; print(secrets.token_urlsafe(12))")
  TOPIC="totebot-$(python3 -c "import secrets; print(secrets.token_hex(6))")"
  sed -i "s|^APP_PASSWORD=.*|APP_PASSWORD=$PW|; s|^NTFY_TOPIC=.*|NTFY_TOPIC=$TOPIC|" /etc/totebot.env
  chmod 600 /etc/totebot.env
  echo "Created /etc/totebot.env"
  echo "  login:      admin / $PW"
  echo "  ntfy topic: $TOPIC"
fi

cp "$APP_DIR/deploy/totebot.service" /etc/systemd/system/totebot.service
systemctl daemon-reload
systemctl enable --now totebot
systemctl restart totebot
sleep 2
systemctl --no-pager --lines=5 status totebot || true
echo
echo "Totebot is running on port $(grep -E '^PORT=' /etc/totebot.env | cut -d= -f2)."
echo "Update later with: git pull && sudo bash deploy/install.sh"
