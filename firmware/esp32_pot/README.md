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

MQTT topics (canonical):
- Sensors: `pots/<device_id>/sensors`
- Status: `pots/<device_id>/status`
- Commands: `pots/<device_id>/command`

Sensors payload example:
```json
{
  "potId": "pot-01",
  "moisture": 47.2,
  "temperature": 22.8,
  "humidity": 48.5,
  "valveOpen": false,
  "waterLow": false,
  "waterCutoff": false,
  "soilRaw": 18342,
  "timestampMs": 145000
}
```

Command payload example:
```json
{"pump": "on", "duration_ms": 15000}
```
