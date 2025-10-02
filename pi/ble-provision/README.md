ProjectPlant BLE Wi‑Fi Provisioning

Overview
- Provides a BLE GATT service over BlueZ to provision Wi‑Fi.
- Uses dbus-next to implement a custom GATT service with characteristics:
  - PP-STATE (read/notify): Current provisioning state.
  - PP-SCAN (read): On read, returns nearby Wi‑Fi SSIDs and signal levels.
  - PP-SSID (write): Target SSID string.
  - PP-PASS (write-only): Target passphrase string.
  - PP-APPLY (write): Trigger connection attempt using nmcli.
  - PP-RESULT (read/notify): Result of last APPLY.
  - PP-POP (read): Proof-of-possession code (from /etc/projectplant/pop).

Security / PoP
- The service reads a PoP string from `/etc/projectplant/pop`.
- Writes to PP-SSID/PP-PASS/PP-APPLY are only accepted if the same BLE device
  has recently read PP-POP (within 5 minutes). This is enforced using the
  `device` option passed by BlueZ on GATT operations.

UUIDs
- Service: `7f1e0000-8536-4d33-9b3b-2df3f9f0a900`
- Characteristics:
  - PP-STATE:  `7f1e0001-8536-4d33-9b3b-2df3f9f0a900`
  - PP-SCAN:   `7f1e0002-8536-4d33-9b3b-2df3f9f0a900`
  - PP-SSID:   `7f1e0003-8536-4d33-9b3b-2df3f9f0a900`
  - PP-PASS:   `7f1e0004-8536-4d33-9b3b-2df3f9f0a900`
  - PP-APPLY:  `7f1e0005-8536-4d33-9b3b-2df3f9f0a900`
  - PP-RESULT: `7f1e0006-8536-4d33-9b3b-2df3f9f0a900`
  - PP-POP:    `7f1e0007-8536-4d33-9b3b-2df3f9f0a900`

Characteristic Semantics
- PP-STATE: values: `idle`, `connecting`, `connected`, `failed`.
- PP-SCAN: returns lines `SSID,SIGNAL` per network (limited to ~480 bytes).
- PP-SSID: write plain UTF‑8 SSID.
- PP-PASS: write plain UTF‑8 passphrase (empty for open networks).
- PP-APPLY: write any value to initiate connection with `nmcli`.
- PP-RESULT: `OK` or `ERROR:<reason>` from the last apply attempt.
- PP-POP: returns the current PoP string for this device.

Wifi Commands
- Scan: `nmcli -t -f SSID,SIGNAL dev wifi`
- Connect: `nmcli dev wifi connect "<SSID>" password "<PASS>" ifname wlan0`

On Success
- Stops BLE advertising.
- Starts `api.service` and `mqtt.service`.
- Starts an Avahi publication for `_projectplant._tcp` using the unit
  `projectplant-avahi.service`. Default port is 80 and can be changed by
  editing `/etc/projectplant/avahi-port.env` with `PROJECTPLANT_PORT=<port>`.

Install
1) On the target (Raspberry Pi), copy this folder to the device and run:
   `sudo ./install.sh`

2) The installer will:
   - Install BlueZ, NetworkManager, Avahi and Python deps.
   - Copy the service into `/opt/projectplant/ble-provision`.
   - Create `/etc/projectplant/pop` if missing.
   - Create `/etc/projectplant/avahi-port.env` with `PROJECTPLANT_PORT=80` (editable).
   - Enable `projectplant-ble-provision.service` and `projectplant-avahi.service`.

3) The device will advertise as `ProjectPlant-Setup` with the provisioning
   service UUID. Use a BLE client to:
   - Read `PP-POP`.
   - Write `PP-SSID` and `PP-PASS`.
   - Write `PP-APPLY` to trigger connection.
   - Read/subscribe `PP-STATE` and `PP-RESULT` for feedback.

Notes
- Requires BlueZ 5.50+ with GATT and LE Advertising managers.
- Run the service as root so it can invoke `nmcli` and `systemctl`.
- If using an open network, write an empty string to `PP-PASS` before APPLY.

