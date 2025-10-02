ProjectPlant Fallback Wi‑Fi AP (hostapd + dnsmasq)

Overview
- Starts a fallback Access Point if provisioning has not succeeded within 5 minutes after boot.
- AP SSID is `ProjectPlant-XXXX` where `XXXX` is the last 4 hex of the WLAN MAC.
- Runs a minimal captive portal on port 80 to collect SSID/PASS.
- Disables BLE (and the BLE provisioner) while AP is active; re-enables on exit.
- On submit, applies Wi‑Fi via NetworkManager and tears down the AP automatically.

Assumptions
- Systemd-based Linux (tested on Raspberry Pi OS/Debian with NetworkManager).
- Wireless interface is `wlan0` (override via `/etc/projectplant/ap.env`).
- `hostapd` and `dnsmasq` installed.
- BLE provisioner from `pi/ble-provision` is optional; if present, it will be paused during AP.

Install
1) Copy this folder to the device and run as root:
   `sudo ./install.sh`

2) The installer will:
   - Install hostapd + dnsmasq if missing
   - Install scripts to `/opt/projectplant/fallback-ap`
   - Install systemd units and enable `projectplant-provision-check.service`

3) Reboot, or start immediately:
   - `sudo systemctl start projectplant-provision-check.service`

Behavior
- On boot, waits up to 5 minutes for `/var/lib/projectplant/provisioned`.
- If not present, starts `projectplant-ap.target` which:
  - Stops NetworkManager and BLE services
  - Configures `wlan0` with `192.168.4.1/24`
  - Starts `hostapd`, `dnsmasq`, and the captive portal
- Captive portal writes desired SSID/PASS to `/etc/projectplant/desired_wifi.env`, then starts `projectplant-apply-wifi.service`.
- The apply service stops the AP target, restarts NetworkManager, applies Wi‑Fi via `nmcli`, creates the provisioned flag, and re-enables BLE.

Config
- `/etc/projectplant/ap.env` (optional):
  - `WLAN_IFACE=wlan0`
  - `WIFI_COUNTRY=US`
- Captive portal listens on port 80 and serves simple HTML.

Uninstall
```
sudo systemctl disable --now projectplant-provision-check.service
sudo systemctl stop projectplant-ap.target || true
sudo rm -f /etc/systemd/system/projectplant-*.service /etc/systemd/system/projectplant-*.target
sudo systemctl daemon-reload
```

