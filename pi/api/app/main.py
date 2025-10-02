import asyncio
import os
import sys
import time
import platform
import subprocess
from typing import Dict, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from asyncio_mqtt import Client, MqttError
except Exception as e:  # pragma: no cover
    # Provide a clear import error if dependencies are missing
    raise RuntimeError("asyncio-mqtt not installed. Install dependencies via 'pip install -r requirements.txt'") from e

from . import __version__


# -----------------
# Configuration
# -----------------

MQTT_HOST: str = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT: int = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USERNAME: Optional[str] = os.getenv("MQTT_USERNAME")
MQTT_PASSWORD: Optional[str] = os.getenv("MQTT_PASSWORD")

# ESP32 firmware in this repo publishes retained availability to plant/{DEVICE_ID}/state
MQTT_STATE_TOPIC: str = os.getenv("MQTT_STATE_TOPIC", "plant/+/state")

# CORS config
ENV: str = os.getenv("ENV", "production").lower()
APP_ORIGINS: Optional[str] = os.getenv("APP_ORIGINS")


# -----------------
# App & State
# -----------------

app = FastAPI(title="ProjectPlant Pi API", version=__version__)


def _dev_origins_default() -> List[str]:
    return [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ]


def _parse_origins() -> List[str]:
    if APP_ORIGINS:
        return [o.strip() for o in APP_ORIGINS.split(",") if o.strip()]
    if ENV in ("dev", "development"):
        return _dev_origins_default()
    return []


origins = _parse_origins()
if origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# In-memory device registry built from retained and live MQTT state messages.
# Key: device_id -> { id, topic, online, last_seen, retained }
_devices: Dict[str, Dict[str, object]] = {}
_devices_lock = asyncio.Lock()
_mqtt_connected: bool = False
_mqtt_task: Optional[asyncio.Task] = None


def _parse_device_id_from_state_topic(topic: str) -> Optional[str]:
    # Expect pattern: plant/{DEVICE_ID}/state
    parts = topic.split("/")
    if len(parts) == 3 and parts[0] == "plant" and parts[2] == "state":
        return parts[1]
    return None


async def _mqtt_loop():
    global _mqtt_connected

    client_id = f"projectplant-api-{os.getpid()}"

    while True:
        try:
            connect_kwargs = {}
            if MQTT_USERNAME:
                connect_kwargs["username"] = MQTT_USERNAME
            if MQTT_PASSWORD:
                connect_kwargs["password"] = MQTT_PASSWORD

            async with Client(MQTT_HOST, port=MQTT_PORT, client_id=client_id, **connect_kwargs) as client:
                _mqtt_connected = True

                # Receive all messages (including retained ones on subscribe)
                async with client.unfiltered_messages() as messages:
                    await client.subscribe(MQTT_STATE_TOPIC, qos=1)

                    async for message in messages:
                        payload = message.payload.decode(errors="ignore").strip().lower()
                        topic = message.topic
                        retained = bool(message.retain)
                        device_id = _parse_device_id_from_state_topic(topic)
                        if not device_id:
                            continue

                        online = payload == "online"
                        now = int(time.time())
                        async with _devices_lock:
                            _devices[device_id] = {
                                "id": device_id,
                                "topic": topic,
                                "online": online,
                                "last_seen": now,
                                "retained": retained,
                            }

        except MqttError:
            _mqtt_connected = False
            # Backoff and retry connection
            await asyncio.sleep(2.0)
        except asyncio.CancelledError:
            _mqtt_connected = False
            raise
        except Exception:
            # Log to stderr but continue trying
            _mqtt_connected = False
            print("[mqtt] unexpected error:", file=sys.stderr)
            import traceback

            traceback.print_exc()
            await asyncio.sleep(2.0)


def _is_avahi_active() -> bool:
    # Basic check for Avahi daemon on Linux
    if platform.system().lower() != "linux":
        return False
    try:
        res = subprocess.run(
            ["systemctl", "is-active", "avahi-daemon"],
            capture_output=True,
            text=True,
            timeout=1.5,
        )
        return res.returncode == 0 and res.stdout.strip() == "active"
    except Exception:
        return False


@app.on_event("startup")
async def on_startup():
    global _mqtt_task
    _mqtt_task = asyncio.create_task(_mqtt_loop())


@app.on_event("shutdown")
async def on_shutdown():
    global _mqtt_task
    if _mqtt_task:
        _mqtt_task.cancel()
        try:
            await _mqtt_task
        except asyncio.CancelledError:
            pass
        _mqtt_task = None


@app.get("/healthz")
@app.get("/api/healthz")
async def healthz():
    return {
        "status": "ok",
        "version": __version__,
        "services": {
            "mqtt": _mqtt_connected,
            "avahi": _is_avahi_active(),
        },
    }


@app.get("/devices")
@app.get("/api/devices")
async def list_devices():
    async with _devices_lock:
        # Return a stable order for readability (by device id)
        items = list(_devices.values())
    items.sort(key=lambda d: str(d.get("id", "")))
    return items
