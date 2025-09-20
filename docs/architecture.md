# Architecture (draft)
- Devices (ESP32) ↔ MQTT ↔ Hub (FastAPI) ↔ UI (HTTP/WebSocket)
- Data: SQLite first, swappable
- Protocol: MQTT topics with JSON payloads
