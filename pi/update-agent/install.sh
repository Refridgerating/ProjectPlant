#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Please run as root" >&2
  exit 1
fi

SRC_DIR=$(cd "$(dirname "$0")" && pwd)
INSTALL_DIR=/opt/projectplant/current/pi/update-agent
SYSTEMD_DIR=/etc/systemd/system
CONF_DIR=/etc/projectplant
STATE_DIR=/var/lib/projectplant/agent
REPO_PI_DIR=$(cd "$SRC_DIR/.." && pwd)

install -d "$INSTALL_DIR" "$CONF_DIR" "$STATE_DIR"
install -m 0644 "$SRC_DIR/requirements.txt" "$INSTALL_DIR/requirements.txt"
cp -R "$SRC_DIR/agent" "$INSTALL_DIR/agent"
install -m 0644 "$REPO_PI_DIR/systemd/projectplant-agent.service" "$SYSTEMD_DIR/projectplant-agent.service"
if [[ ! -f "$CONF_DIR/fleet.env" ]]; then
  cat > "$CONF_DIR/fleet.env" <<'EOF'
FLEET_CONTROL_URL=
FLEET_BOOTSTRAP_TOKEN=
PROJECTPLANT_CHANNEL=dev
PROJECTPLANT_MQTT_BROKER_MODE=external
EOF
fi
python3 -m pip install -r "$INSTALL_DIR/requirements.txt"
systemctl daemon-reload
systemctl enable projectplant-agent.service
