ProjectPlant Pi API

FastAPI service providing Raspberry Pi endpoints for health and ESP32 device discovery via MQTT retained state.

Endpoints
- GET /healthz: { status: 'ok', version, services: { mqtt: boolean, avahi: boolean } }
- GET /devices: Array of known ESP32s from retained LWT/state (topic: plant/{id}/state)

Quick start
1) Create a virtualenv and install deps
   python -m venv .venv
   . .venv/bin/activate  # Windows: .venv\\Scripts\\activate
   pip install -r requirements.txt

2) Run the API (dev)
   # Defaults to localhost MQTT, topic filter plant/+/state
   ENV=development uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

Configuration (env vars)
- MQTT_HOST: Broker host (default: localhost)
- MQTT_PORT: Broker port (default: 1883)
- MQTT_USERNAME: Username (optional)
- MQTT_PASSWORD: Password (optional)
- MQTT_STATE_TOPIC: Topic filter for availability/state (default: plant/+/state)
- ENV: Set to development to enable CORS for local app origins
- APP_ORIGINS: Comma-separated CORS origins override (optional)

Notes
- ESP32 firmware in this repo publishes retained availability to plant/{DEVICE_ID}/state with payloads 'online'/'offline'.
- /devices is built from retained messages plus live updates after API startup.
