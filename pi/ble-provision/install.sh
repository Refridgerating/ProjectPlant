#!/usr/bin/env bash
set -euo pipefail

# ProjectPlant BLE Provisioner Installer

if [[ $(id -u) -ne 0 ]]; then
  echo "Please run as root" >&2
  exit 1
fi

SRC_DIR=$(cd "$(dirname "$0")" && pwd)
INSTALL_DIR=/opt/projectplant/ble-provision
AVAHI_INSTALL_DIR=/opt/projectplant/current/pi/avahi
SYSTEMD_DIR=/etc/systemd/system
CONF_DIR=/etc/projectplant

echo "[1/6] Installing OS packages..."
apt-get update -y
apt-get install -y --no-install-recommends \
  python3 python3-pip python3-venv \
  bluetooth bluez \
  network-manager \
  avahi-daemon avahi-utils

echo "[2/6] Installing Python dependencies..."
python3 -m pip install --upgrade pip
python3 -m pip install dbus-next

echo "[3/6] Installing service files..."
install -d "$INSTALL_DIR"
install -d "$AVAHI_INSTALL_DIR"
install -m 0755 "$SRC_DIR/pp_ble_provision.py" "$INSTALL_DIR/pp_ble_provision.py"
install -m 0755 "$SRC_DIR/../avahi/publish-projectplant-service.sh" "$AVAHI_INSTALL_DIR/publish-projectplant-service.sh"

install -m 0644 "$SRC_DIR/projectplant-ble-provision.service" "$SYSTEMD_DIR/projectplant-ble-provision.service"
install -m 0644 "$SRC_DIR/projectplant-avahi.service" "$SYSTEMD_DIR/projectplant-avahi.service"

echo "[4/6] Creating configuration..."
install -d "$CONF_DIR"
if [[ ! -f "$CONF_DIR/pop" ]]; then
  # Default PoP is a random 6-digit code
  printf "%06d\n" "$(( RANDOM % 1000000 ))" > "$CONF_DIR/pop"
  chmod 0640 "$CONF_DIR/pop"
fi

# Optional Avahi metadata override via environment file
if [[ ! -f "$CONF_DIR/avahi.env" ]]; then
  cat > "$CONF_DIR/avahi.env" <<'EOF'
PROJECTPLANT_AVAHI_NAME=ProjectPlant Hub
PROJECTPLANT_PORT=8080
PROJECTPLANT_AVAHI_TXT=role=hub;channel=dev;hub_version=unknown;agent_version=0.1.0
EOF
  chmod 0644 "$CONF_DIR/avahi.env"
fi

echo "[5/6] Enabling services..."
systemctl daemon-reload
systemctl enable projectplant-ble-provision.service
# Avahi publisher will be started after successful provisioning
systemctl enable projectplant-avahi.service || true

echo "[6/6] Starting BLE provisioning..."
systemctl restart bluetooth.service || true
systemctl start projectplant-ble-provision.service

echo "Install complete. Advertised as 'ProjectPlant-Setup' (UUID 7f1e0000-8536-4d33-9b3b-2df3f9f0a900)"
