#!/usr/bin/env bash
set -euo pipefail

CONF_DIR=/etc/projectplant
STATE_DIR=/var/lib/projectplant

DESIRED_ENV="$CONF_DIR/desired_wifi.env"

if [[ ! -f "$DESIRED_ENV" ]]; then
  echo "No desired Wi-Fi credentials found at $DESIRED_ENV; nothing to do."
  exit 0
fi

# Load desired SSID/PASS and iface
# shellcheck disable=SC1090
source "$DESIRED_ENV"

WLAN_IFACE=${WLAN_IFACE:-wlan0}
SSID=${SSID:-}
PASS=${PASS:-}

if [[ -z "${SSID}" ]]; then
  echo "SSID is empty in $DESIRED_ENV"
  exit 1
fi

echo "Applying Wi-Fi credentials for SSID='${SSID}' on ${WLAN_IFACE}"

# If AP target is active, stop it first to free the interface
if systemctl is-active --quiet projectplant-ap.target; then
  echo "Stopping projectplant-ap.target..."
  systemctl stop projectplant-ap.target || true
fi

# Ensure NetworkManager is running
systemctl start NetworkManager.service || true

# Wait until NetworkManager is active
for i in {1..30}; do
  if systemctl is-active --quiet NetworkManager.service; then break; fi
  sleep 1
done

# Try to connect using nmcli (password may be empty for open networks)
if [[ -n "${PASS}" ]]; then
  nmcli dev wifi connect "${SSID}" password "${PASS}" ifname "${WLAN_IFACE}" || true
else
  nmcli dev wifi connect "${SSID}" ifname "${WLAN_IFACE}" || true
fi

# Check connectivity (IP assigned)
for i in {1..15}; do
  if ip -o -4 addr show dev "${WLAN_IFACE}" | grep -q 'inet '; then
    CONNECTED=1
    break
  fi
  sleep 1
done

if [[ "${CONNECTED:-0}" -eq 1 ]]; then
  echo "Connected to ${SSID}. Marking provisioned."
  install -d "$STATE_DIR"
  date +%s > "$STATE_DIR/provisioned"
  # Remove desired credentials to avoid reuse
  rm -f "$DESIRED_ENV"
  # Restart BLE provisioner if present (optional)
  systemctl start projectplant-ble-provision.service 2>/dev/null || true
  # Optionally start Avahi announcement
  systemctl start projectplant-avahi.service 2>/dev/null || true
  exit 0
else
  echo "Failed to confirm connectivity to ${SSID}. Leaving files in place for retry."
  exit 2
fi

