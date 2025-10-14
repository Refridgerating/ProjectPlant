from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from asyncio_mqtt import MqttError

from mqtt.client import get_mqtt_manager

LOGGER_NAME = "projectplant.hub.commands"
COMMAND_TOPIC_FMT = "pots/{pot_id}/command"
SENSORS_TOPIC_FMT = "pots/{pot_id}/sensors"
FRESHNESS_SLACK_SECONDS = 0.5


class CommandServiceError(RuntimeError):
    """Raised when a command cannot be executed or the MQTT client is unavailable."""


class CommandTimeoutError(CommandServiceError):
    """Raised when a command does not receive a fresh response before the deadline."""


@dataclass(slots=True)
class SensorReadResult:
    request_id: str
    payload: dict[str, Any]


class CommandService:
    def __init__(self, *, default_timeout: float = 5.0) -> None:
        self._default_timeout = max(default_timeout, 0.1)
        self._logger = logging.getLogger(LOGGER_NAME)

    async def request_sensor_read(self, pot_id: str, *, timeout: Optional[float] = None) -> SensorReadResult:
        if not pot_id:
            raise ValueError("pot_id is required")

        manager = get_mqtt_manager()
        if manager is None:
            raise CommandServiceError("MQTT manager is not connected")

        try:
            client = manager.get_client()
        except RuntimeError as exc:
            raise CommandServiceError(str(exc)) from exc
        target_timeout = timeout if timeout is not None else self._default_timeout
        if target_timeout <= 0:
            raise ValueError("timeout must be greater than zero")

        command_topic = COMMAND_TOPIC_FMT.format(pot_id=pot_id)
        sensors_topic = SENSORS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())
        payload = json.dumps({"requestId": request_id, "command": "sensor_read"}, separators=(",", ":"))

        start_monotonic = time.monotonic()
        command_start_epoch = datetime.now(timezone.utc).timestamp()

        async with client.filtered_messages(sensors_topic) as messages:
            try:
                await client.subscribe(sensors_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {sensors_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish sensor-read command to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for sensor reading on {sensors_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(f"Timed out waiting for sensor reading on {sensors_topic}") from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting sensor reading") from exc

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    timestamp = self._extract_timestamp(data)
                    if timestamp is not None and timestamp + FRESHNESS_SLACK_SECONDS < command_start_epoch:
                        self._logger.debug(
                            "Ignoring stale sensor payload for %s (timestamp=%s)", pot_id, timestamp
                        )
                        continue

                    self._logger.debug(
                        "Received sensor payload for %s in %.2f s", pot_id, time.monotonic() - start_monotonic
                    )
                    return SensorReadResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(sensors_topic)
                except MqttError:
                    # Best-effort cleanup; log at debug to avoid noisy shutdown.
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", sensors_topic, exc_info=True)

    def _decode_payload(self, payload: bytes) -> Optional[dict[str, Any]]:
        try:
            decoded = payload.decode("utf-8")
            data = json.loads(decoded)
            if isinstance(data, dict):
                return data
            self._logger.debug("MQTT sensor payload is not a JSON object: %r", data)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._logger.debug("Invalid MQTT sensor payload received", exc_info=True)
        return None

    def _extract_timestamp(self, data: dict[str, Any]) -> Optional[float]:
        ts_iso = data.get("timestamp")
        if isinstance(ts_iso, str):
            try:
                return datetime.fromisoformat(ts_iso.replace("Z", "+00:00")).timestamp()
            except ValueError:
                self._logger.debug("Failed to parse ISO timestamp: %s", ts_iso, exc_info=True)

        ts_ms = data.get("timestampMs")
        if ts_ms is not None:
            try:
                return float(ts_ms) / 1000.0
            except (TypeError, ValueError):
                self._logger.debug("Failed to parse millisecond timestamp: %r", ts_ms, exc_info=True)
        return None


command_service = CommandService()
