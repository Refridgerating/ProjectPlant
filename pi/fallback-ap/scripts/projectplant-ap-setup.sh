#!/usr/bin/env bash
set -euo pipefail

# Prepares hostapd + dnsmasq configs and assigns a static IP to the WLAN iface.

CONF_DIR=/etc/projectplant
HOSTAPD_CONF=/etc/hostapd/hostapd.conf
DNSMASQ_CONF_DIR=/etc/dnsmasq.d
DNSMASQ_PP_CONF=$DNSMASQ_CONF_DIR/projectplant.conf
STATE_DIR=/var/lib/projectplant

mkdir -p "$STATE_DIR"
install -d "$DNSMASQ_CONF_DIR"

# Load config
if [[ -f "$CONF_DIR/ap.env" ]]; then
  # shellcheck disable=SC1090
  source "$CONF_DIR/ap.env"
fi
WLAN_IFACE=${WLAN_IFACE:-wlan0}
WIFI_COUNTRY=${WIFI_COUNTRY:-US}

# Compute SSID suffix from MAC (last 4 hex)
MAC=$(cat "/sys/class/net/${WLAN_IFACE}/address" | tr -d ':')
SUFFIX=${MAC: -4}
SSID="ProjectPlant-${SUFFIX^^}"

echo "Configuring AP on ${WLAN_IFACE} as '${SSID}'"

# Ensure interface is up and has a static IP for AP
ip link set "$WLAN_IFACE" down || true
ip addr flush dev "$WLAN_IFACE" || true
ip link set "$WLAN_IFACE" up
ip addr add 192.168.4.1/24 dev "$WLAN_IFACE"

# hostapd config (open network)
install -d "/etc/hostapd"
cat > "$HOSTAPD_CONF" <<EOF
country_code=${WIFI_COUNTRY}
interface=${WLAN_IFACE}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=6
ieee80211n=1
wmm_enabled=1
auth_algs=1
ignore_broadcast_ssid=0
EOF

# dnsmasq config for captive portal + DHCP
cat > "$DNSMASQ_PP_CONF" <<EOF
interface=${WLAN_IFACE}
bind-interfaces
domain-needed
bogus-priv
dhcp-range=192.168.4.10,192.168.4.200,255.255.255.0,24h
address=/#/192.168.4.1
no-resolv
no-hosts
log-facility=/var/log/dnsmasq.log
EOF

echo "AP setup completed. SSID=${SSID}"

