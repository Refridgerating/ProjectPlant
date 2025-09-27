# ProjectPlant ESP32 Pot Firmware

This ESP-IDF application connects an ESP32-based planter node to the ProjectPlant MQTT broker. It reads soil moisture (capacitive probe on ADC1 channel 6), SHT41 temperature/RH over I2C, and a float switch for reservoir level while controlling a 3V pump.

## Features
- Periodic telemetry publishing (soil moisture, temperature, humidity, water level, pump status)
- Wi-Fi station provisioning via `hardware_config.h`
- MQTT client with JSON command parsing for pump overrides
- Basic SHT41 driver using I2C master mode
- FreeRTOS tasks for sensors, MQTT publishing, and command handling

## Getting Started
1. Install ESP-IDF (v5.1 or newer recommended) and export the environment.
2. Update Wi-Fi/MQTT settings in `main/hardware_config.h`.
3. Configure optional SDK settings: `idf.py menuconfig`.
4. Build and flash:
   ```bash
   idf.py set-target esp32
   idf.py build
   idf.py -p <PORT> flash monitor
   ```

MQTT topics:
- Telemetry: `projectplant/pots/<device_id>/telemetry`
- Status: `projectplant/pots/<device_id>/status`
- Commands: `projectplant/pots/<device_id>/command`

Command payload example:
```json
{"pump": "on", "duration_ms": 15000}
```
