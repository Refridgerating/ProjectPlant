#!/usr/bin/env bash
set -euo pipefail

# ProjectPlant Fallback AP Installer

if [[ $(id -u) -ne 0 ]]; then
  echo "Please run as root" >&2
  exit 1
fi

SRC_DIR=$(cd "$(dirname "$0")" && pwd)
INSTALL_DIR=/opt/projectplant/fallback-ap
SYSTEMD_DIR=/etc/systemd/system
CONF_DIR=/etc/projectplant

echo "[1/6] Installing OS packages..."
apt-get update -y
apt-get install -y --no-install-recommends hostapd dnsmasq python3

echo "[2/6] Installing scripts..."
install -d "$INSTALL_DIR"
install -m 0755 "$SRC_DIR/scripts/projectplant-ap-setup.sh" "$INSTALL_DIR/projectplant-ap-setup.sh"
install -m 0755 "$SRC_DIR/scripts/projectplant-apply-wifi.sh" "$INSTALL_DIR/projectplant-apply-wifi.sh"
install -m 0755 "$SRC_DIR/scripts/projectplant-wait-provisioning.sh" "$INSTALL_DIR/projectplant-wait-provisioning.sh"
install -m 0755 "$SRC_DIR/scripts/projectplant-captive-portal.py" "$INSTALL_DIR/projectplant-captive-portal.py"

echo "[3/6] Installing unit files..."
install -m 0644 "$SRC_DIR/systemd/projectplant-provision-check.service" "$SYSTEMD_DIR/projectplant-provision-check.service"
install -m 0644 "$SRC_DIR/systemd/projectplant-ap.target" "$SYSTEMD_DIR/projectplant-ap.target"
install -m 0644 "$SRC_DIR/systemd/projectplant-disable-ble.service" "$SYSTEMD_DIR/projectplant-disable-ble.service"
install -m 0644 "$SRC_DIR/systemd/projectplant-disable-nm.service" "$SYSTEMD_DIR/projectplant-disable-nm.service"
install -m 0644 "$SRC_DIR/systemd/projectplant-ap-setup.service" "$SYSTEMD_DIR/projectplant-ap-setup.service"
install -m 0644 "$SRC_DIR/systemd/projectplant-hostapd.service" "$SYSTEMD_DIR/projectplant-hostapd.service"
install -m 0644 "$SRC_DIR/systemd/projectplant-dnsmasq.service" "$SYSTEMD_DIR/projectplant-dnsmasq.service"
install -m 0644 "$SRC_DIR/systemd/projectplant-captive-portal.service" "$SYSTEMD_DIR/projectplant-captive-portal.service"
install -m 0644 "$SRC_DIR/systemd/projectplant-apply-wifi.service" "$SYSTEMD_DIR/projectplant-apply-wifi.service"

echo "[4/6] Creating configuration..."
install -d "$CONF_DIR"
if [[ ! -f "$CONF_DIR/ap.env" ]]; then
  cat > "$CONF_DIR/ap.env" <<'EOF'
# ProjectPlant AP configuration
WLAN_IFACE=wlan0
WIFI_COUNTRY=US
EOF
  chmod 0644 "$CONF_DIR/ap.env"
fi

echo "[5/6] Enabling units..."
systemctl daemon-reload
systemctl enable projectplant-provision-check.service

echo "[6/6] Done. Reboot or start check service to activate."
