from __future__ import annotations

import asyncio
import json
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from asyncio_mqtt import Client, Message, MqttCodeError, MqttError
from paho.mqtt.client import topic_matches_sub

from services.pump_status import PumpStatusSnapshot, pump_status_cache
from services.telemetry import telemetry_store
from services.plant_telemetry import plant_telemetry_store
from services.provisioning import provisioning_store

LOGGER_NAME = "projectplant.hub.mqtt.bridge"
LEGACY_FIRMWARE_TELEMETRY_FILTER = "projectplant/pots/+/telemetry"
CANONICAL_SENSOR_TOPIC_FMT = "pots/{pot_id}/sensors"
CANONICAL_SENSOR_FILTER = "pots/+/sensors"
LEGACY_FIRMWARE_STATUS_FILTER = "projectplant/pots/+/status"
CANONICAL_STATUS_TOPIC_FMT = "pots/{pot_id}/status"
DEVICE_STATE_FILTER = "plant/+/state"


def _topic_matches(topic: Any, wildcard: str) -> bool:
    if hasattr(topic, "matches"):
        try:
            return topic.matches(wildcard)
        except ValueError:
            # Fall back to string matching for invalid combinations
            pass
    return topic_matches_sub(wildcard, str(topic))


@dataclass(frozen=True)
class NormalizedTelemetry:
    potId: str
    moisture: float
    temperature: float
    valveOpen: bool
    timestamp: str
    timestampMs: Optional[int] = None
    humidity: Optional[float] = None
    flowRateLpm: Optional[float] = None
    waterLow: Optional[bool] = None
    waterCutoff: Optional[bool] = None
    soilRaw: Optional[float] = None
    requestId: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "potId": self.potId,
            "moisture": self.moisture,
            "temperature": self.temperature,
            "valveOpen": self.valveOpen,
            "timestamp": self.timestamp,
        }
        if self.timestampMs is not None:
            payload["timestampMs"] = self.timestampMs
        if self.humidity is not None:
            payload["humidity"] = self.humidity
        if self.flowRateLpm is not None:
            payload["flowRateLpm"] = self.flowRateLpm
        if self.waterLow is not None:
            payload["waterLow"] = self.waterLow
        if self.waterCutoff is not None:
            payload["waterCutoff"] = self.waterCutoff
        if self.soilRaw is not None:
            payload["soilRaw"] = self.soilRaw
        if self.requestId:
            payload["requestId"] = self.requestId
        payload["source"] = "bridge"
        return payload


class MqttBridge:
    """Bridges firmware MQTT topics into the SDK-friendly namespace."""

    def __init__(
        self,
        client: Client,
        *,
        logger: Optional[logging.Logger] = None,
        on_disconnect: Optional[Callable[[str, BaseException | None], Awaitable[None]]] = None,
    ) -> None:
        self._client = client
        self._logger = logger or logging.getLogger(LOGGER_NAME)
        self._tasks: list[asyncio.Task[None]] = []
        self._started = False
        self._on_disconnect = on_disconnect
        self._backoff_seconds = 1.0

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._logger.info("Starting MQTT bridge")
        self._tasks.append(asyncio.create_task(self._forward_firmware(), name="mqtt-bridge-firmware"))
        self._tasks.append(asyncio.create_task(self._capture_canonical_sensors(), name="mqtt-sensor-capture"))
        self._tasks.append(asyncio.create_task(self._forward_status(), name="mqtt-bridge-status"))
        self._tasks.append(asyncio.create_task(self._monitor_device_state(), name="mqtt-device-state"))

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
        while self._started:
            try:
                async with self._client.messages() as messages:
                    await self._client.subscribe(topic_filter)
                    async for message in messages:
                        if not _topic_matches(message.topic, topic_filter):
                            continue
                        await self._handle_firmware_message(message)
                        self._reset_backoff()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - unexpected failures logged for observability
                await self._handle_loop_exception("firmware bridge", exc)
            finally:
                try:
                    await self._client.unsubscribe(topic_filter)
                except Exception as exc:  # pragma: no cover - best effort clean-up
                    await self._handle_unsubscribe_error("firmware bridge", exc)

        self._logger.debug("Firmware bridge task exiting")

    async def _forward_status(self) -> None:
        topic_filter = LEGACY_FIRMWARE_STATUS_FILTER
        while self._started:
            try:
                async with self._client.messages() as messages:
                    await self._client.subscribe(topic_filter)
                    async for message in messages:
                        if not _topic_matches(message.topic, topic_filter):
                            continue
                        await self._handle_status_message(message)
                        self._reset_backoff()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - unexpected failures logged for observability
                await self._handle_loop_exception("status bridge", exc)
            finally:
                try:
                    await self._client.unsubscribe(topic_filter)
                except Exception as exc:  # pragma: no cover - best effort clean-up
                    await self._handle_unsubscribe_error("status bridge", exc)

        self._logger.debug("Status bridge task exiting")

    async def _monitor_device_state(self) -> None:
        topic_filter = DEVICE_STATE_FILTER
        while self._started:
            try:
                async with self._client.messages() as messages:
                    await self._client.subscribe(topic_filter)
                    async for message in messages:
                        if not _topic_matches(message.topic, topic_filter):
                            continue
                        await self._handle_state_message(message)
                        self._reset_backoff()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - unexpected failures logged for observability
                await self._handle_loop_exception("state monitor", exc)
            finally:
                try:
                    await self._client.unsubscribe(topic_filter)
                except Exception as exc:  # pragma: no cover - best effort clean-up
                    await self._handle_unsubscribe_error("state monitor", exc)

        self._logger.debug("State monitor exiting")

    async def _capture_canonical_sensors(self) -> None:
        topic_filter = CANONICAL_SENSOR_FILTER
        while self._started:
            try:
                async with self._client.messages() as messages:
                    await self._client.subscribe(topic_filter)
                    async for message in messages:
                        if not _topic_matches(message.topic, topic_filter):
                            continue
                        await self._handle_canonical_sensor_message(message)
                        self._reset_backoff()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - unexpected failures logged for observability
                await self._handle_loop_exception("canonical sensor", exc)
            finally:
                try:
                    await self._client.unsubscribe(topic_filter)
                except Exception as exc:  # pragma: no cover - best effort clean-up
                    await self._handle_unsubscribe_error("canonical sensor", exc)

        self._logger.debug("Canonical sensor capture exiting")

    async def _handle_loop_exception(self, context: str, exc: Exception) -> None:
        if self._is_not_connected_error(exc):
            await self._notify_disconnect(context, exc)
            return
        self._logger.warning("MQTT %s loop interrupted: %s", context, exc)
        await asyncio.sleep(1.0)

    async def _handle_unsubscribe_error(self, context: str, exc: Exception) -> None:
        if self._is_not_connected_error(exc):
            await self._notify_disconnect(f"{context} unsubscribe", exc)
            return
        self._logger.debug("Failed to unsubscribe in %s: %s", context, exc)

    async def _notify_disconnect(self, context: str, exc: BaseException | None) -> None:
        if not self._started:
            return
        self._logger.warning("MQTT %s detected disconnect: %s", context, exc)
        if self._on_disconnect is not None:
            try:
                await self._on_disconnect(context, exc)
            except Exception as callback_exc:  # pragma: no cover - defensive logging
                self._logger.debug("Disconnect callback failed: %s", callback_exc)
        if not self._started:
            return
        delay = self._backoff_seconds
        if delay > 0 and self._started:
            await asyncio.sleep(delay)
        self._backoff_seconds = min(self._backoff_seconds * 2.0, 30.0)

    def _reset_backoff(self) -> None:
        self._backoff_seconds = 1.0

    @staticmethod
    def _is_not_connected_error(exc: Exception) -> bool:
        if isinstance(exc, MqttCodeError):
            rc = exc.rc
            if isinstance(rc, int) and rc in {4, 7}:
                return True
        if isinstance(exc, MqttError):
            return "Disconnected" in str(exc)
        return False

    async def _handle_firmware_message(self, message: Message) -> None:
        pot_id = _extract_pot_id(message.topic)
        if not pot_id:
            self._logger.debug("Ignoring firmware telemetry with unexpected topic: %s", message.topic)
            return

        telemetry = build_sensor_payload(message.payload, pot_id)
        if telemetry is None:
            self._logger.debug("Firmware payload for %s could not be normalized", pot_id)
            return

        await telemetry_store.record_environment(
            timestamp=_parse_iso_datetime(telemetry.timestamp),
            temperature_c=telemetry.temperature,
            humidity_pct=telemetry.humidity,
            source="sensor",
        )

        await plant_telemetry_store.record(
            pot_id=telemetry.potId,
            timestamp=telemetry.timestamp,
            timestamp_ms=telemetry.timestampMs,
            moisture=telemetry.moisture,
            temperature=telemetry.temperature,
            humidity=telemetry.humidity,
            pressure=None,
            solar=None,
            wind=None,
            valve_open=telemetry.valveOpen,
            flow_rate=telemetry.flowRateLpm,
            water_low=telemetry.waterLow,
            water_cutoff=telemetry.waterCutoff,
            soil_raw=telemetry.soilRaw,
            source="mqtt",
            request_id=telemetry.requestId,
        )

        payload_json = json.dumps(telemetry.to_dict(), separators=(",", ":"))
        target_topic = CANONICAL_SENSOR_TOPIC_FMT.format(pot_id=pot_id)
        await self._client.publish(target_topic, payload_json, retain=True)
        self._logger.debug("Bridged %s -> %s", message.topic, target_topic)

    async def _handle_canonical_sensor_message(self, message: Message) -> None:
        pot_id = _extract_canonical_pot_id(message.topic)
        if not pot_id:
            return
        try:
            decoded = message.payload.decode("utf-8")
        except UnicodeDecodeError:
            self._logger.debug("Ignoring canonical sensor payload with invalid encoding")
            return

        try:
            data = json.loads(decoded)
        except json.JSONDecodeError:
            self._logger.debug("Ignoring canonical sensor payload with invalid JSON")
            return

        if not isinstance(data, dict):
            return

        if data.get("source") == "bridge":
            # Skip messages that originated from the bridge to avoid duplicates
            return

        timestamp_ms_float = _coerce_float(data.get("timestampMs"))
        if timestamp_ms_float is None:
            timestamp_ms_float = _coerce_float(data.get("timestamp_ms"))
        timestamp_iso = _coerce_str(data.get("timestamp"))
        if timestamp_iso:
            try:
                dt_iso = datetime.fromisoformat(timestamp_iso.replace("Z", "+00:00"))
                if dt_iso.tzinfo is None:
                    dt_iso = dt_iso.replace(tzinfo=timezone.utc)
                timestamp_iso = _isoformat(dt_iso)
            except ValueError:
                timestamp_iso = None
        if timestamp_iso is None and timestamp_ms_float is not None:
            timestamp_iso = _coerce_timestamp(timestamp_ms_float)
        if timestamp_iso is None:
            timestamp_iso = _utc_now_iso()

        timestamp_ms_int = int(round(timestamp_ms_float)) if timestamp_ms_float is not None else None

        moisture = _coerce_float(data.get("moisture"))
        if moisture is None:
            moisture = _coerce_float(data.get("moisture_pct"))

        temperature = _coerce_float(data.get("temperature"))
        if temperature is None:
            temperature = _coerce_float(data.get("temperature_c"))

        humidity = _coerce_float(data.get("humidity"))
        if humidity is None:
            humidity = _coerce_float(data.get("humidity_pct"))

        pressure = _coerce_float(data.get("pressure_hpa"))
        if pressure is None:
            pressure = _coerce_float(data.get("pressure"))

        solar = _coerce_float(data.get("solar_radiation_w_m2"))
        if solar is None:
            solar = _coerce_float(data.get("solar"))

        wind = _coerce_float(data.get("wind_speed_m_s"))
        if wind is None:
            wind = _coerce_float(data.get("wind"))

        valve_open = _coerce_bool(data.get("valveOpen"))
        if valve_open is None:
            valve_open = _coerce_bool(data.get("valve_open"))

        flow_rate = _coerce_float(data.get("flowRateLpm"))
        if flow_rate is None:
            flow_rate = _coerce_float(data.get("flow_rate_lpm"))
        water_low = _coerce_bool(data.get("waterLow"))
        water_cutoff = _coerce_bool(data.get("waterCutoff"))
        soil_raw = _coerce_float(data.get("soilRaw"))
        if soil_raw is None:
            soil_raw = _coerce_float(data.get("soil_raw"))

        try:
            timestamp_dt = datetime.fromisoformat(timestamp_iso.replace("Z", "+00:00"))
        except ValueError:
            timestamp_dt = datetime.now(timezone.utc)

        await telemetry_store.record_environment(
            timestamp=timestamp_dt,
            temperature_c=temperature,
            humidity_pct=humidity,
            pressure_hpa=pressure,
            solar_radiation_w_m2=solar,
            wind_speed_m_s=wind,
            source="sensor",
        )

        await plant_telemetry_store.record(
            pot_id=data.get("potId") or pot_id,
            timestamp=timestamp_iso,
            timestamp_ms=timestamp_ms_int,
            moisture=moisture,
            temperature=temperature,
            humidity=humidity,
            pressure=pressure,
            solar=solar,
            wind=wind,
            valve_open=valve_open,
            flow_rate=flow_rate,
            water_low=water_low,
            water_cutoff=water_cutoff,
            soil_raw=soil_raw,
            source=data.get("source") or "firmware",
            request_id=_coerce_str(data.get("requestId")),
        )

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

    async def _handle_state_message(self, message: Message) -> None:
        device_id = _extract_state_device_id(message.topic)
        if not device_id:
            self._logger.debug("Ignoring device state with unexpected topic: %s", message.topic)
            return

        try:
            payload = message.payload.decode("utf-8")
        except UnicodeDecodeError:
            payload = ""

        await provisioning_store.record_state(
            device_id=device_id,
            topic=str(message.topic),
            payload=payload,
            retained=bool(getattr(message, "retain", False)),
        )


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
    if soil_pct is None:
        soil_pct = _coerce_float(data.get("moisture"))

    temperature_c = _coerce_float(data.get("temperature_c"))
    if temperature_c is None:
        temperature_c = _coerce_float(data.get("temperature"))

    humidity_pct = _coerce_float(data.get("humidity_pct"))
    if humidity_pct is None:
        humidity_pct = _coerce_float(data.get("humidity"))

    flow_rate = _coerce_float(data.get("flow_rate_lpm"))
    if flow_rate is None:
        flow_rate = _coerce_float(data.get("flowRateLpm"))

    pump_on = _coerce_bool(data.get("pump_on"))
    if pump_on is None:
        pump_on = _coerce_bool(data.get("valveOpen"))

    request_id = _coerce_str(data.get("requestId"))
    if request_id is None:
        request_id = _coerce_str(data.get("request_id"))

    timestamp_ms_float = _coerce_float(data.get("timestampMs"))
    if timestamp_ms_float is None:
        timestamp_ms_float = _coerce_float(data.get("timestamp_ms"))
    timestamp_iso = None
    raw_timestamp = _coerce_str(data.get("timestamp"))
    if raw_timestamp:
        try:
            dt = datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            timestamp_iso = _isoformat(dt)
        except ValueError:
            timestamp_iso = None
    if timestamp_iso is None and timestamp_ms_float is not None:
        timestamp_iso = _coerce_timestamp(timestamp_ms_float)

    if (
        soil_pct is None
        and temperature_c is None
        and humidity_pct is None
        and flow_rate is None
        and pump_on is None
    ):
        # Nothing usable in this payload
        return None

    water_low = _coerce_bool(data.get("waterLow"))
    if water_low is None:
        water_low = _coerce_bool(data.get("water_low"))

    water_cutoff = _coerce_bool(data.get("waterCutoff"))
    if water_cutoff is None:
        water_cutoff = _coerce_bool(data.get("water_cutoff"))

    soil_raw = _coerce_float(data.get("soilRaw"))
    if soil_raw is None:
        soil_raw = _coerce_float(data.get("soil_raw"))

    moisture = _round_or_default(soil_pct, 0.0, digits=1)
    temperature = _round_or_default(temperature_c, 0.0, digits=1)
    humidity = _round_optional(humidity_pct, digits=1)
    flow_rate_lpm = _round_optional(flow_rate, digits=3)
    valve_open = pump_on if pump_on is not None else False
    timestamp = timestamp_iso or _utc_now_iso()
    timestamp_ms_int = int(round(timestamp_ms_float)) if timestamp_ms_float is not None else None

    return NormalizedTelemetry(
        potId=pot_id,
        moisture=moisture,
        temperature=temperature,
        humidity=humidity,
        valveOpen=valve_open,
        flowRateLpm=flow_rate_lpm,
        timestamp=timestamp,
        timestampMs=timestamp_ms_int,
        waterLow=water_low,
        waterCutoff=water_cutoff,
        soilRaw=soil_raw,
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

    status = _coerce_str(data.get("status"))
    if status is None:
        status = _coerce_str(data.get("state"))
    pump_on = _coerce_bool(data.get("pump_on"))
    if pump_on is None:
        pump_on = _coerce_bool(data.get("pumpOn"))
    if pump_on is None:
        pump_on = _coerce_bool(data.get("pump"))
    if pump_on is None and status:
        pump_on = _infer_pump_state(status)

    request_id = _coerce_str(data.get("requestId"))
    if request_id is None:
        request_id = _coerce_str(data.get("request_id"))
    timestamp_ms_float = _coerce_float(data.get("timestampMs"))
    if timestamp_ms_float is None:
        timestamp_ms_float = _coerce_float(data.get("timestamp_ms"))
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


def _extract_pot_id(topic: Any) -> Optional[str]:
    parts = str(topic).split("/")
    if len(parts) >= 4 and parts[0] == "projectplant" and parts[1] == "pots":
        return parts[2]
    return None


def _extract_canonical_pot_id(topic: Any) -> Optional[str]:
    parts = str(topic).split("/")
    if len(parts) >= 3 and parts[0] == "pots" and parts[2] == "sensors":
        return parts[1]
    return None


def _extract_state_device_id(topic: Any) -> Optional[str]:
    parts = str(topic).split("/")
    if len(parts) >= 3 and parts[0] == "plant" and parts[2] == "state":
        return parts[1]
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


def _parse_iso_datetime(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
