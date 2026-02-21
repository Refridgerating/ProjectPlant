from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Optional
from uuid import uuid4

from asyncio_mqtt import MqttError

from mqtt.client import get_mqtt_manager
from services.pot_ids import normalize_pot_id

LOGGER_NAME = "projectplant.hub.commands"
COMMAND_TOPIC_FMT = "pots/{pot_id}/command"
SENSORS_TOPIC_FMT = "pots/{pot_id}/sensors"
STATUS_TOPIC_FMT = "pots/{pot_id}/status"
FRESHNESS_SLACK_SECONDS = 0.5
MIN_REAL_TIMESTAMP = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()


class CommandServiceError(RuntimeError):
    """Raised when a command cannot be executed or the MQTT client is unavailable."""


class CommandTimeoutError(CommandServiceError):
    """Raised when a command does not receive a fresh response before the deadline."""


@dataclass(slots=True)
class SensorReadResult:
    request_id: str
    payload: dict[str, Any]


@dataclass(slots=True)
class CommandAckResult:
    request_id: str
    payload: dict[str, Any]


class CommandService:
    def __init__(self, *, default_timeout: float = 5.0) -> None:
        self._default_timeout = max(default_timeout, 0.1)
        self._logger = logging.getLogger(LOGGER_NAME)

    @staticmethod
    def _normalize_pot_id(pot_id: str) -> str:
        normalized = normalize_pot_id(pot_id)
        if not normalized:
            raise ValueError("pot_id is required")
        return normalized

    async def request_sensor_read(self, pot_id: str, *, timeout: Optional[float] = None) -> SensorReadResult:
        return await self._execute_command(pot_id, command="sensor_read", timeout=timeout)

    async def control_pump(
        self,
        pot_id: str,
        *,
        on: bool,
        duration_ms: Optional[float] = None,
        timeout: Optional[float] = None,
    ) -> SensorReadResult:
        if duration_ms is not None and duration_ms <= 0:
            raise ValueError("duration_ms must be greater than zero")

        duration_int: Optional[int]
        if duration_ms is None:
            duration_int = None
        else:
            duration_int = int(duration_ms)

        overall_start = time.monotonic()
        pump_result = await self.send_pump_override(
            pot_id,
            pump_on=on,
            duration_ms=duration_int,
            timeout=timeout,
        )

        sensor_timeout: Optional[float] = None
        if timeout is not None:
            elapsed = time.monotonic() - overall_start
            remaining = timeout - elapsed
            if remaining <= 0:
                raise CommandTimeoutError(
                    f"Timed out waiting for sensor reading after pump command for {pot_id}"
                )
            sensor_timeout = remaining

        sensor_result = await self.request_sensor_read(pot_id, timeout=sensor_timeout)
        payload = dict(sensor_result.payload)
        payload["requestId"] = pump_result.request_id
        return SensorReadResult(request_id=pump_result.request_id, payload=payload)

    async def control_fan(
        self,
        pot_id: str,
        *,
        on: bool,
        duration_ms: Optional[float] = None,
        timeout: Optional[float] = None,
    ) -> SensorReadResult:
        if duration_ms is not None and duration_ms < 0:
            raise ValueError("duration_ms must be non-negative")

        duration_int: Optional[int] = None
        if duration_ms is not None:
            duration_int = int(duration_ms)

        overall_start = time.monotonic()
        fan_result = await self.send_fan_override(
            pot_id,
            fan_on=on,
            duration_ms=duration_int,
            timeout=timeout,
        )

        sensor_timeout: Optional[float] = None
        if timeout is not None:
            elapsed = time.monotonic() - overall_start
            remaining = timeout - elapsed
            if remaining <= 0:
                raise CommandTimeoutError(
                    f"Timed out waiting for sensor reading after fan command for {pot_id}"
                )
            sensor_timeout = remaining

        sensor_result = await self.request_sensor_read(pot_id, timeout=sensor_timeout)
        payload = dict(sensor_result.payload)
        payload["requestId"] = fan_result.request_id
        return SensorReadResult(request_id=fan_result.request_id, payload=payload)

    async def control_mister(
        self,
        pot_id: str,
        *,
        on: bool,
        duration_ms: Optional[float] = None,
        timeout: Optional[float] = None,
    ) -> SensorReadResult:
        if duration_ms is not None and duration_ms < 0:
            raise ValueError("duration_ms must be non-negative")

        duration_int: Optional[int] = None
        if duration_ms is not None:
            duration_int = int(duration_ms)

        overall_start = time.monotonic()
        mister_result = await self.send_mister_override(
            pot_id,
            mister_on=on,
            duration_ms=duration_int,
            timeout=timeout,
        )

        sensor_timeout: Optional[float] = None
        if timeout is not None:
            elapsed = time.monotonic() - overall_start
            remaining = timeout - elapsed
            if remaining <= 0:
                raise CommandTimeoutError(
                    f"Timed out waiting for sensor reading after mister command for {pot_id}"
                )
            sensor_timeout = remaining

        sensor_result = await self.request_sensor_read(pot_id, timeout=sensor_timeout)
        payload = dict(sensor_result.payload)
        payload["requestId"] = mister_result.request_id
        return SensorReadResult(request_id=mister_result.request_id, payload=payload)

    async def control_light(
        self,
        pot_id: str,
        *,
        on: bool,
        duration_ms: Optional[float] = None,
        timeout: Optional[float] = None,
    ) -> SensorReadResult:
        if duration_ms is not None and duration_ms < 0:
            raise ValueError("duration_ms must be non-negative")

        duration_int: Optional[int] = None
        if duration_ms is not None:
            duration_int = int(duration_ms)

        overall_start = time.monotonic()
        light_result = await self.send_light_override(
            pot_id,
            light_on=on,
            duration_ms=duration_int,
            timeout=timeout,
        )

        sensor_timeout: Optional[float] = None
        if timeout is not None:
            elapsed = time.monotonic() - overall_start
            remaining = timeout - elapsed
            if remaining <= 0:
                raise CommandTimeoutError(
                    f"Timed out waiting for sensor reading after light command for {pot_id}"
                )
            sensor_timeout = remaining

        sensor_result = await self.request_sensor_read(pot_id, timeout=sensor_timeout)
        payload = dict(sensor_result.payload)
        payload["requestId"] = light_result.request_id
        return SensorReadResult(request_id=light_result.request_id, payload=payload)

    async def _execute_command(
        self,
        pot_id: str,
        *,
        command: str,
        command_payload: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> SensorReadResult:
        pot_id = self._normalize_pot_id(pot_id)

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

        payload_dict: dict[str, Any] = {"requestId": request_id, "command": command}
        if command_payload:
            payload_dict.update(command_payload)
        payload_json = json.dumps(payload_dict, separators=(",", ":"))

        start_monotonic = time.monotonic()
        command_start_epoch = datetime.now(timezone.utc).timestamp()

        subscribe_attempts = 0
        self._logger.info(
            "Starting %s command for %s (requestId=%s, timeout=%.2fs)",
            command,
            pot_id,
            request_id,
            target_timeout,
        )
        while True:
            try:
                async with client.messages() as messages:
                    try:
                        await client.subscribe(sensors_topic)
                        subscribe_attempts = 0
                        self._logger.info("Subscribed to %s", sensors_topic)
                    except MqttError as exc:
                        subscribe_attempts += 1
                        if subscribe_attempts >= 3:
                            raise CommandServiceError(f"Failed to subscribe to {sensors_topic}") from exc
                        sleep_for = min(0.5 * subscribe_attempts, 2.0)
                        self._logger.warning(
                            "Subscribe to %s failed (%s); retrying in %.1fs", sensors_topic, exc, sleep_for
                        )
                        await asyncio.sleep(sleep_for)
                        continue

                    try:
                        await client.publish(command_topic, payload_json, qos=1, retain=False)
                        self._logger.info("Published %s command to %s", command, command_topic)
                    except MqttError as exc:
                        raise CommandServiceError(f"Failed to publish {command} command to {command_topic}") from exc

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
                                self._logger.warning("MQTT error while awaiting sensor reading: %s", exc)
                                break

                            topic_value = getattr(message, "topic", sensors_topic)
                            if hasattr(topic_value, "matches"):
                                if not topic_value.matches(sensors_topic):
                                    continue
                            elif str(topic_value) != sensors_topic:
                                continue

                            data = self._decode_payload(message.payload)
                            if data is None:
                                self._logger.debug("Ignored non-JSON payload on %s", sensors_topic)
                                continue

                            response_request_id = data.get("requestId") or data.get("request_id")
                            if response_request_id and response_request_id != request_id:
                                self._logger.warning(
                                    "Ignoring sensor payload for %s with unmatched requestId %r (expected %s)",
                                    pot_id,
                                    response_request_id,
                                    request_id,
                                )
                                continue

                            timestamp = self._extract_timestamp(data)
                            if timestamp is not None and timestamp + FRESHNESS_SLACK_SECONDS < command_start_epoch:
                                self._logger.debug(
                                    "Ignoring stale sensor payload for %s (timestamp=%s)", pot_id, timestamp
                                )
                                continue

                            self._logger.info(
                                "Accepting sensor payload for %s with requestId=%r timestamp=%s",
                                pot_id,
                                response_request_id,
                                timestamp,
                            )
                            elapsed = time.monotonic() - start_monotonic
                            self._logger.debug(
                                "Received sensor payload for %s after %s command in %.2f s",
                                pot_id,
                                command,
                                elapsed,
                            )
                            return SensorReadResult(request_id=request_id, payload=data)
                    finally:
                        try:
                            await client.unsubscribe(sensors_topic)
                        except MqttError:
                            self._logger.debug(
                                "Failed to unsubscribe from %s during cleanup", sensors_topic, exc_info=True
                            )

            except CommandTimeoutError:
                raise
            except CommandServiceError:
                raise
            except Exception as exc:  # pragma: no cover
                self._logger.warning("Sensor read loop encountered error: %s", exc, exc_info=True)
                await asyncio.sleep(0.5)

    async def send_pump_override(
        self,
        pot_id: str,
        *,
        pump_on: bool,
        duration_ms: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> CommandAckResult:
        pot_id = self._normalize_pot_id(pot_id)
        if not pot_id:
            raise ValueError("pot_id is required")
        if duration_ms is not None:
            if duration_ms < 0:
                raise ValueError("duration_ms must be non-negative")
            duration_ms = int(duration_ms)

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
        status_topic = STATUS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())

        payload_dict: dict[str, Any] = {
            "requestId": request_id,
            "pump": "on" if pump_on else "off",
        }
        if duration_ms is not None:
            payload_dict["duration_ms"] = duration_ms

        payload = json.dumps(payload_dict, separators=(",", ":"))

        start_monotonic = time.monotonic()

        async with client.messages() as messages:
            try:
                await client.subscribe(status_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {status_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish pump override command to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}") from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting status update") from exc

                    topic_value = getattr(message, "topic", status_topic)
                    if hasattr(topic_value, "matches"):
                        if not topic_value.matches(status_topic):
                            continue
                    elif str(topic_value) != status_topic:
                        continue

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    if data.get("requestId") != request_id:
                        self._logger.debug(
                            "Ignoring status payload for %s with unmatched requestId %r", pot_id, data.get("requestId")
                        )
                        continue

                    self._logger.debug(
                        "Received pump status for %s in %.2f s", pot_id, time.monotonic() - start_monotonic
                    )
                    return CommandAckResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(status_topic)
                except MqttError:
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", status_topic, exc_info=True)

    async def send_fan_override(
        self,
        pot_id: str,
        *,
        fan_on: bool,
        duration_ms: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> CommandAckResult:
        pot_id = self._normalize_pot_id(pot_id)
        if not pot_id:
            raise ValueError("pot_id is required")
        if duration_ms is not None:
            if duration_ms < 0:
                raise ValueError("duration_ms must be non-negative")
            duration_ms = int(duration_ms)

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
        status_topic = STATUS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())

        payload_dict: dict[str, Any] = {
            "requestId": request_id,
            "fan": "on" if fan_on else "off",
        }
        if duration_ms is not None:
            payload_dict["duration_ms"] = duration_ms

        payload = json.dumps(payload_dict, separators=(",", ":"))

        start_monotonic = time.monotonic()

        async with client.messages() as messages:
            try:
                await client.subscribe(status_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {status_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish fan override command to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(
                            f"Timed out waiting for status update on {status_topic}"
                        ) from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting status update") from exc

                    topic_value = getattr(message, "topic", status_topic)
                    if hasattr(topic_value, "matches"):
                        if not topic_value.matches(status_topic):
                            continue
                    elif str(topic_value) != status_topic:
                        continue

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    if data.get("requestId") != request_id:
                        self._logger.debug(
                            "Ignoring status payload for %s with unmatched requestId %r", pot_id, data.get("requestId")
                        )
                        continue

                    self._logger.debug(
                        "Received fan status for %s in %.2f s", pot_id, time.monotonic() - start_monotonic
                    )
                    return CommandAckResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(status_topic)
                except MqttError:
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", status_topic, exc_info=True)

    async def send_mister_override(
        self,
        pot_id: str,
        *,
        mister_on: bool,
        duration_ms: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> CommandAckResult:
        pot_id = self._normalize_pot_id(pot_id)
        if not pot_id:
            raise ValueError("pot_id is required")
        if duration_ms is not None:
            if duration_ms < 0:
                raise ValueError("duration_ms must be non-negative")
            duration_ms = int(duration_ms)

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
        status_topic = STATUS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())

        payload_dict: dict[str, Any] = {
            "requestId": request_id,
            "mister": "on" if mister_on else "off",
        }
        if duration_ms is not None:
            payload_dict["duration_ms"] = duration_ms

        payload = json.dumps(payload_dict, separators=(",", ":"))

        start_monotonic = time.monotonic()

        async with client.messages() as messages:
            try:
                await client.subscribe(status_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {status_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish mister override command to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(
                            f"Timed out waiting for status update on {status_topic}"
                        ) from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting status update") from exc

                    topic_value = getattr(message, "topic", status_topic)
                    if hasattr(topic_value, "matches"):
                        if not topic_value.matches(status_topic):
                            continue
                    elif str(topic_value) != status_topic:
                        continue

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    if data.get("requestId") != request_id:
                        self._logger.debug(
                            "Ignoring status payload for %s with unmatched requestId %r", pot_id, data.get("requestId")
                        )
                        continue

                    self._logger.debug(
                        "Received mister status for %s in %.2f s", pot_id, time.monotonic() - start_monotonic
                    )
                    return CommandAckResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(status_topic)
                except MqttError:
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", status_topic, exc_info=True)

    async def send_light_override(
        self,
        pot_id: str,
        *,
        light_on: bool,
        duration_ms: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> CommandAckResult:
        pot_id = self._normalize_pot_id(pot_id)
        if not pot_id:
            raise ValueError("pot_id is required")
        if duration_ms is not None:
            if duration_ms < 0:
                raise ValueError("duration_ms must be non-negative")
            duration_ms = int(duration_ms)

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
        status_topic = STATUS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())

        payload_dict: dict[str, Any] = {
            "requestId": request_id,
            "light": "on" if light_on else "off",
        }
        if duration_ms is not None:
            payload_dict["duration_ms"] = duration_ms

        payload = json.dumps(payload_dict, separators=(",", ":"))

        start_monotonic = time.monotonic()

        async with client.messages() as messages:
            try:
                await client.subscribe(status_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {status_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish light override command to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(
                            f"Timed out waiting for status update on {status_topic}"
                        ) from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting status update") from exc

                    topic_value = getattr(message, "topic", status_topic)
                    if hasattr(topic_value, "matches"):
                        if not topic_value.matches(status_topic):
                            continue
                    elif str(topic_value) != status_topic:
                        continue

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    if data.get("requestId") != request_id:
                        self._logger.debug(
                            "Ignoring status payload for %s with unmatched requestId %r", pot_id, data.get("requestId")
                        )
                        continue

                    self._logger.debug(
                        "Received light status for %s in %.2f s", pot_id, time.monotonic() - start_monotonic
                    )
                    return CommandAckResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(status_topic)
                except MqttError:
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", status_topic, exc_info=True)

    async def set_device_name(
        self,
        pot_id: str,
        *,
        name: str,
        timeout: Optional[float] = None,
    ) -> CommandAckResult:
        pot_id = self._normalize_pot_id(pot_id)
        cleaned = name.strip()
        if not cleaned:
            raise ValueError("device name is required")
        if len(cleaned) > 32:
            raise ValueError("device name must be 32 characters or fewer")

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
        status_topic = STATUS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())

        payload_dict: dict[str, Any] = {
            "requestId": request_id,
            "deviceName": cleaned,
        }
        payload = json.dumps(payload_dict, separators=(",", ":"))

        start_monotonic = time.monotonic()

        async with client.messages() as messages:
            try:
                await client.subscribe(status_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {status_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish device name update to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}") from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting status update") from exc

                    topic_value = getattr(message, "topic", status_topic)
                    if hasattr(topic_value, "matches"):
                        if not topic_value.matches(status_topic):
                            continue
                    elif str(topic_value) != status_topic:
                        continue

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    if data.get("requestId") != request_id:
                        self._logger.debug(
                            "Ignoring status payload for %s with unmatched requestId %r", pot_id, data.get("requestId")
                        )
                        continue

                    self._logger.debug(
                        "Received name update status for %s in %.2f s", pot_id, time.monotonic() - start_monotonic
                    )
                    return CommandAckResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(status_topic)
                except MqttError:
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", status_topic, exc_info=True)

    async def set_sensor_mode(
        self,
        pot_id: str,
        *,
        mode: str,
        timeout: Optional[float] = None,
    ) -> CommandAckResult:
        pot_id = self._normalize_pot_id(pot_id)
        cleaned = mode.strip().lower()
        if cleaned in {"control_only", "control-only", "control"}:
            normalized_mode = "control_only"
        elif cleaned in {"full", "sensors", "enabled"}:
            normalized_mode = "full"
        else:
            raise ValueError("sensor mode must be 'full' or 'control_only'")

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
        status_topic = STATUS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())

        payload_dict: dict[str, Any] = {
            "requestId": request_id,
            "sensorMode": normalized_mode,
        }
        payload = json.dumps(payload_dict, separators=(",", ":"))

        start_monotonic = time.monotonic()

        async with client.messages() as messages:
            try:
                await client.subscribe(status_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {status_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish sensor mode update to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}") from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting status update") from exc

                    topic_value = getattr(message, "topic", status_topic)
                    if hasattr(topic_value, "matches"):
                        if not topic_value.matches(status_topic):
                            continue
                    elif str(topic_value) != status_topic:
                        continue

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    if data.get("requestId") != request_id:
                        self._logger.debug(
                            "Ignoring status payload for %s with unmatched requestId %r", pot_id, data.get("requestId")
                        )
                        continue

                    self._logger.debug(
                        "Received sensor mode update status for %s in %.2f s",
                        pot_id,
                        time.monotonic() - start_monotonic,
                    )
                    return CommandAckResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(status_topic)
                except MqttError:
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", status_topic, exc_info=True)

    async def set_device_schedule(
        self,
        pot_id: str,
        *,
        schedule: Mapping[str, Any],
        tz_offset_minutes: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> CommandAckResult:
        pot_id = self._normalize_pot_id(pot_id)
        if not isinstance(schedule, Mapping):
            raise ValueError("schedule must be an object")

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
        status_topic = STATUS_TOPIC_FMT.format(pot_id=pot_id)
        request_id = str(uuid4())

        schedule_payload = {
            "light": dict(schedule.get("light", {})) if isinstance(schedule.get("light"), Mapping) else {},
            "pump": dict(schedule.get("pump", {})) if isinstance(schedule.get("pump"), Mapping) else {},
            "mister": dict(schedule.get("mister", {})) if isinstance(schedule.get("mister"), Mapping) else {},
            "fan": dict(schedule.get("fan", {})) if isinstance(schedule.get("fan"), Mapping) else {},
        }
        payload_dict: dict[str, Any] = {
            "requestId": request_id,
            "schedule": schedule_payload,
        }
        if tz_offset_minutes is not None:
            payload_dict["tzOffsetMinutes"] = int(tz_offset_minutes)

        payload = json.dumps(payload_dict, separators=(",", ":"))
        start_monotonic = time.monotonic()

        async with client.messages() as messages:
            try:
                await client.subscribe(status_topic)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to subscribe to {status_topic}") from exc

            try:
                await client.publish(command_topic, payload, qos=1, retain=False)
            except MqttError as exc:
                raise CommandServiceError(f"Failed to publish schedule update to {command_topic}") from exc

            deadline = start_monotonic + target_timeout
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}")

                    try:
                        message = await asyncio.wait_for(messages.__anext__(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise CommandTimeoutError(f"Timed out waiting for status update on {status_topic}") from exc
                    except MqttError as exc:
                        raise CommandServiceError("MQTT error while awaiting status update") from exc

                    topic_value = getattr(message, "topic", status_topic)
                    if hasattr(topic_value, "matches"):
                        if not topic_value.matches(status_topic):
                            continue
                    elif str(topic_value) != status_topic:
                        continue

                    data = self._decode_payload(message.payload)
                    if data is None:
                        continue

                    if data.get("requestId") != request_id:
                        self._logger.debug(
                            "Ignoring status payload for %s with unmatched requestId %r",
                            pot_id,
                            data.get("requestId"),
                        )
                        continue

                    self._logger.debug(
                        "Received schedule update status for %s in %.2f s",
                        pot_id,
                        time.monotonic() - start_monotonic,
                    )
                    return CommandAckResult(request_id=request_id, payload=data)
            finally:
                try:
                    await client.unsubscribe(status_topic)
                except MqttError:
                    self._logger.debug("Failed to unsubscribe from %s during cleanup", status_topic, exc_info=True)

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
                dt = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                timestamp = dt.timestamp()
                if timestamp < MIN_REAL_TIMESTAMP:
                    return None
                return timestamp
            except ValueError:
                self._logger.debug("Failed to parse ISO timestamp: %s", ts_iso, exc_info=True)

        ts_ms = data.get("timestampMs")
        if ts_ms is not None:
            try:
                timestamp = float(ts_ms) / 1000.0
                if timestamp < MIN_REAL_TIMESTAMP:
                    return None
                return timestamp
            except (TypeError, ValueError):
                self._logger.debug("Failed to parse millisecond timestamp: %r", ts_ms, exc_info=True)
        return None


command_service = CommandService()
