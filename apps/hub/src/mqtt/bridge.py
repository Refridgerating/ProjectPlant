from __future__ import annotations

import asyncio
import json
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from asyncio_mqtt import Client, Message

from services.pump_status import PumpStatusSnapshot, pump_status_cache

LOGGER_NAME = "projectplant.hub.mqtt.bridge"
LEGACY_FIRMWARE_TELEMETRY_FILTER = "projectplant/pots/+/telemetry"
CANONICAL_SENSOR_TOPIC_FMT = "pots/{pot_id}/sensors"
LEGACY_FIRMWARE_STATUS_FILTER = "projectplant/pots/+/status"
CANONICAL_STATUS_TOPIC_FMT = "pots/{pot_id}/status"


@dataclass(frozen=True)
class NormalizedTelemetry:
    potId: str
    moisture: float
    temperature: float
    valveOpen: bool
    timestamp: str
    humidity: Optional[float] = None
    flowRateLpm: Optional[float] = None
    requestId: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "potId": self.potId,
            "moisture": self.moisture,
            "temperature": self.temperature,
            "valveOpen": self.valveOpen,
            "timestamp": self.timestamp,
        }
        if self.humidity is not None:
            payload["humidity"] = self.humidity
        if self.flowRateLpm is not None:
            payload["flowRateLpm"] = self.flowRateLpm
        if self.requestId:
            payload["requestId"] = self.requestId
        return payload


class MqttBridge:
    """Bridges firmware MQTT topics into the SDK-friendly namespace."""

    def __init__(self, client: Client, *, logger: Optional[logging.Logger] = None) -> None:
        self._client = client
        self._logger = logger or logging.getLogger(LOGGER_NAME)
        self._tasks: list[asyncio.Task[None]] = []
        self._started = False

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._logger.info("Starting MQTT bridge")
        self._tasks.append(asyncio.create_task(self._forward_firmware(), name="mqtt-bridge-firmware"))
        self._tasks.append(asyncio.create_task(self._forward_status(), name="mqtt-bridge-status"))

    async def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # pragma: no cover - defensive logging
                self._logger.warning("MQTT bridge task terminated with error: %s", exc)
        self._logger.info("MQTT bridge stopped")

    async def _forward_firmware(self) -> None:
        topic_filter = LEGACY_FIRMWARE_TELEMETRY_FILTER
        try:
            async with self._client.filtered_messages(topic_filter) as messages:
                await self._client.subscribe(topic_filter)
                async for message in messages:
                    await self._handle_firmware_message(message)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - unexpected failures logged for observability
            self._logger.exception("MQTT firmware bridge loop crashed")
        finally:
            try:
                await self._client.unsubscribe(topic_filter)
            except Exception:  # pragma: no cover - best effort clean-up
                pass

    async def _forward_status(self) -> None:
        topic_filter = LEGACY_FIRMWARE_STATUS_FILTER
        try:
            async with self._client.filtered_messages(topic_filter) as messages:
                await self._client.subscribe(topic_filter)
                async for message in messages:
                    await self._handle_status_message(message)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - unexpected failures logged for observability
            self._logger.exception("MQTT status bridge loop crashed")
        finally:
            try:
                await self._client.unsubscribe(topic_filter)
            except Exception:  # pragma: no cover - best effort clean-up
                pass

    async def _handle_firmware_message(self, message: Message) -> None:
        pot_id = _extract_pot_id(message.topic)
        if not pot_id:
            self._logger.debug("Ignoring firmware telemetry with unexpected topic: %s", message.topic)
            return

        telemetry = build_sensor_payload(message.payload, pot_id)
        if telemetry is None:
            self._logger.debug("Firmware payload for %s could not be normalized", pot_id)
            return

        payload_json = json.dumps(telemetry.to_dict(), separators=(",", ":"))
        target_topic = CANONICAL_SENSOR_TOPIC_FMT.format(pot_id=pot_id)
        await self._client.publish(target_topic, payload_json, retain=True)
        self._logger.debug("Bridged %s -> %s", message.topic, target_topic)

    async def _handle_status_message(self, message: Message) -> None:
        pot_id = _extract_pot_id(message.topic)
        if not pot_id:
            self._logger.debug("Ignoring firmware status with unexpected topic: %s", message.topic)
            return

        snapshot = build_status_payload(message.payload, pot_id)
        if snapshot is None:
            self._logger.debug("Firmware status payload for %s could not be normalized", pot_id)
            return

        pump_status_cache.update(snapshot)
        payload_json = json.dumps(snapshot.to_dict(), separators=(",", ":"))
        target_topic = CANONICAL_STATUS_TOPIC_FMT.format(pot_id=pot_id)
        await self._client.publish(target_topic, payload_json, retain=True)
        self._logger.debug("Bridged status %s -> %s", message.topic, target_topic)


def build_sensor_payload(raw_payload: bytes, pot_id: str) -> Optional[NormalizedTelemetry]:
    try:
        decoded = raw_payload.decode("utf-8")
    except UnicodeDecodeError:
        return None

    try:
        data = json.loads(decoded)
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict):
        return None

    soil_pct = _coerce_float(data.get("soil_pct"))
    temperature_c = _coerce_float(data.get("temperature_c"))
    humidity_pct = _coerce_float(data.get("humidity_pct"))
    flow_rate = _coerce_float(data.get("flow_rate_lpm"))
    pump_on = _coerce_bool(data.get("pump_on"))
    request_id = _coerce_str(data.get("requestId") or data.get("request_id"))
    timestamp_iso = _coerce_timestamp(data.get("timestamp_ms"))

    if soil_pct is None and temperature_c is None and humidity_pct is None and flow_rate is None and pump_on is None:
        # Nothing usable in this payload
        return None

    moisture = _round_or_default(soil_pct, 0.0, digits=1)
    temperature = _round_or_default(temperature_c, 0.0, digits=1)
    humidity = _round_optional(humidity_pct, digits=1)
    flow_rate_lpm = _round_optional(flow_rate, digits=3)
    valve_open = pump_on if pump_on is not None else False
    timestamp = timestamp_iso or _utc_now_iso()

    return NormalizedTelemetry(
        potId=pot_id,
        moisture=moisture,
        temperature=temperature,
        humidity=humidity,
        valveOpen=valve_open,
        flowRateLpm=flow_rate_lpm,
        timestamp=timestamp,
        requestId=request_id,
    )


def build_status_payload(raw_payload: bytes, pot_id: str) -> Optional[PumpStatusSnapshot]:
    try:
        decoded = raw_payload.decode("utf-8")
    except UnicodeDecodeError:
        return None

    try:
        data = json.loads(decoded)
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict):
        return None

    status = _coerce_str(data.get("status") or data.get("state"))
    pump_on = _coerce_bool(data.get("pump_on"))
    if pump_on is None:
        pump_on = _coerce_bool(data.get("pumpOn"))
    if pump_on is None:
        pump_on = _coerce_bool(data.get("pump"))
    if pump_on is None and status:
        pump_on = _infer_pump_state(status)

    request_id = _coerce_str(data.get("requestId") or data.get("request_id"))
    timestamp_ms_float = _coerce_float(data.get("timestampMs") or data.get("timestamp_ms"))
    timestamp_ms = int(timestamp_ms_float) if timestamp_ms_float is not None else None
    timestamp_iso = _normalize_status_timestamp(data.get("timestamp"))
    if timestamp_iso is None and timestamp_ms_float is not None:
        timestamp_iso = _coerce_timestamp(timestamp_ms_float)

    if status is None and pump_on is None and request_id is None and timestamp_iso is None and timestamp_ms is None:
        return None

    received_at = _utc_now_iso()

    return PumpStatusSnapshot(
        pot_id=pot_id,
        status=status,
        pump_on=pump_on,
        request_id=request_id,
        timestamp=timestamp_iso,
        timestamp_ms=timestamp_ms,
        received_at=received_at,
    )


def _extract_pot_id(topic: str) -> Optional[str]:
    parts = topic.split("/")
    if len(parts) >= 4 and parts[0] == "projectplant" and parts[1] == "pots":
        return parts[2]
    return None


def _coerce_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not math.isnan(value):
        return float(value)
    if isinstance(value, str):
        try:
            result = float(value.strip())
        except ValueError:
            return None
        if math.isnan(result):
            return None
        return result
    return None


def _coerce_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "on", "yes"}:
            return True
        if lowered in {"0", "false", "off", "no"}:
            return False
    return None


def _coerce_timestamp(value: Any) -> Optional[str]:
    ms = _coerce_float(value)
    if ms is None:
        return None
    seconds = ms / 1000.0
    dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return _isoformat(dt)


def _round_or_default(value: Optional[float], default: float, *, digits: int) -> float:
    if value is None:
        return default
    return round(value, digits)


def _round_optional(value: Optional[float], *, digits: int) -> Optional[float]:
    if value is None:
        return None
    return round(value, digits)


def _utc_now_iso() -> str:
    return _isoformat(datetime.now(tz=timezone.utc))


def _isoformat(dt: datetime) -> str:
    # Ensure trailing Z for UTC to align with frontend expectations
    iso = dt.isoformat(timespec="milliseconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def _normalize_status_timestamp(value: Any) -> Optional[str]:
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            dt = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
        except ValueError:
            return stripped
        return _isoformat(dt)
    return None


def _infer_pump_state(status: str) -> Optional[bool]:
    lowered = status.strip().lower()
    if not lowered:
        return None

    positive_markers = {"pump_on", "on", "running", "active", "open", "enabled"}
    negative_markers = {"pump_off", "off", "stopped", "idle", "closed", "disabled"}

    if lowered in positive_markers or lowered.endswith("_on"):
        return True
    if lowered in negative_markers or lowered.endswith("_off"):
        return False

    if "on" in lowered and "off" not in lowered:
        return True
    if "off" in lowered and "on" not in lowered:
        return False
    return None


def _coerce_str(value: Any) -> Optional[str]:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None
