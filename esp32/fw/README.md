# ProjectPlant ESP32 Firmware

ESP-IDF project providing:

- Wi-Fi Provisioning Manager over BLE with PoP
- Automatic Wi-Fi connect with retry → re-enter provisioning after 5 failures
- MQTT client with topics:
  - `plant/<id>/tele` telemetry (uptime, RSSI)
  - `plant/<id>/state` state (online/offline)
  - `plant/<id>/cmd` commands (see below)
- Long-press button to re-enter provisioning

## Build

- Requires ESP-IDF (v4.4+ or v5.x). Set up `IDF_PATH` and tools.
- Configure and build:

```
idf.py set-target esp32
idf.py menuconfig
idf.py build
```

Recommended config in Menuconfig:
- Enable BLE (NimBLE) and Wi-Fi Provisioning over BLE
- Ensure MQTT client is enabled

You can also apply defaults from `sdkconfig.defaults` (below).

## Flash & Monitor

```
idf.py -p <PORT> flash monitor
```

## Provisioning

On boot, if there are no credentials or 5 consecutive connection failures occur, the device starts BLE provisioning:
- Service name: `PROV_<last3bytes>`
- Security: PoP (Security 1), PoP value from `CONFIG_PROJECTPLANT_PROV_POP`

Use the ESP-IDF provisioning phone app or CLI to send Wi-Fi credentials.

Long-press the configured button (default GPIO0) for ~3s to clear Wi-Fi creds and re-enter provisioning.

## MQTT

Broker URI is taken from NVS key `mqtt/broker_url` if present, otherwise from Kconfig `CONFIG_PROJECTPLANT_MQTT_BROKER_URI`.

- Client ID: `<id>` where `<id>` is the 12-hex uppercase STA MAC
- Topics:
  - Telemetry: `plant/<id>/tele`
  - State: `plant/<id>/state`
  - Commands: `plant/<id>/cmd`

On connect, device publishes `online` (retained) to the state topic. The LWT is `offline` (retained).

### Commands

- `provision` — clears credentials and starts provisioning
- `set_broker <uri>` — stores URI to NVS and reconnects MQTT

## Defaults

`sdkconfig.defaults` provides a good starting point enabling BLE (NimBLE), provisioning and MQTT.

***

This code is minimal and intended as a starting point for integrating sensors.
