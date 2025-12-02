"""Background worker that drives ETc control from live telemetry."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Optional

from asyncio_mqtt import Client, Message, MqttCodeError, MqttError
from paho.mqtt.client import topic_matches_sub

from fastapi import HTTPException

from config import settings
from services.telemetry import telemetry_store
from svc_etkc.db import connect as svc_connect, ensure_schema
from svc_etkc.service import (
    fetch_config,
    fetch_pot,
    fetch_state,
    store_metric,
    upsert_state,
)
from .controller import mm_to_mL, step
from .state import StepConfig, StepSensors

LOGGER = logging.getLogger("projectplant.hub.etkc.worker")
TELEMETRY_FILTER = "plant/+/telemetry"
METRICS_TOPIC_FMT = "plant/{plant_id}/et/metrics"
IRRIGATION_CMD_TOPIC_FMT = "plant/{plant_id}/irrigation/cmd"
PAR_UMOL_TO_MJ_PER_H = 7.85e-4  # Approximate conversion factor


def _env_sensor_freshness() -> Optional[timedelta]:
    minutes = max(settings.environment_sensor_freshness_minutes, 0.0)
    if minutes <= 0.0:
        return None
    return timedelta(minutes=minutes)


def _topic_matches(topic: Any, wildcard: str) -> bool:
    if hasattr(topic, "matches"):
        try:
            return topic.matches(wildcard)
        except ValueError:
            pass
    return topic_matches_sub(wildcard, str(topic))


class EtkcWorker:
    """Consumes telemetry and runs the ET controller."""

    def __init__(
        self,
        client: Client,
        *,
        on_disconnect: Optional[Callable[[str, BaseException | None], Awaitable[None]]] = None,
    ) -> None:
        self._client = client
        self._task: Optional[asyncio.Task[None]] = None
        self._running = False
        self._on_disconnect = on_disconnect
        self._backoff_seconds = 1.0

    async def start(self) -> None:
        if self._task is not None:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop(), name="etkc-worker")
        LOGGER.info("ETc worker started")

    async def stop(self) -> None:
        self._running = False
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # pragma: no cover - defensive logging
            LOGGER.warning("ETc worker stopped with error: %s", exc)
        finally:
            self._task = None
            LOGGER.info("ETc worker stopped")

    async def _loop(self) -> None:
        while self._running:
            try:
                async with self._client.messages() as messages:
                    await self._client.subscribe(TELEMETRY_FILTER)
                    async for message in messages:
                        if not _topic_matches(message.topic, TELEMETRY_FILTER):
                            continue
                        await self._handle_message(message)
                        self._reset_backoff()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover
                await self._handle_loop_exception(exc)
            finally:
                try:
                    await self._client.unsubscribe(TELEMETRY_FILTER)
                except Exception as exc:
                    await self._handle_unsubscribe_error(exc)

    async def _handle_message(self, message: Message) -> None:
        plant_id = _extract_plant_id(message.topic)
        if not plant_id:
            LOGGER.debug("Ignoring message with unexpected topic: %s", message.topic)
            return

        try:
            payload = json.loads(message.payload.decode("utf-8"))
            sensors, sensor_meta = await _build_step_sensors(payload)
        except Exception as exc:
            LOGGER.debug("Failed to parse telemetry for %s: %s", plant_id, exc)
            return

        conn = svc_connect()
        pot = None
        cfg = None
        try:
            ensure_schema(conn)
            try:
                pot = fetch_pot(conn, plant_id)
            except HTTPException:
                LOGGER.debug("No pot configuration for %s; skipping telemetry.", plant_id)
                return

            state = fetch_state(conn, plant_id, pot)
            cfg = fetch_config(conn, plant_id) or StepConfig()

            new_state, result = step(pot, state, sensors, cfg)
            upsert_state(conn, plant_id, new_state)
            metadata = _build_metric_metadata(message, sensor_meta)
            result = result.model_copy(update={"metadata": metadata})
            store_metric(conn, plant_id, result, metadata=metadata)
        finally:
            conn.close()

        await self._publish_metrics(plant_id, result)
        if pot is not None and cfg is not None:
            await self._maybe_publish_command(plant_id, pot.pot_area_m2, cfg, result)

    async def _publish_metrics(self, plant_id: str, result) -> None:
        try:
            payload = json.dumps(result.model_dump())
            await self._client.publish(METRICS_TOPIC_FMT.format(plant_id=plant_id), payload, qos=0)
        except MqttCodeError as exc:
            if self._is_not_connected_error(exc):
                await self._notify_disconnect("publish metrics", exc)
            else:  # pragma: no cover - unexpected publish failure codes
                LOGGER.debug("Failed to publish metrics for %s: %s", plant_id, exc)
        except MqttError as exc:  # pragma: no cover - generic MQTT failure
            LOGGER.debug("Failed to publish metrics for %s: %s", plant_id, exc)
        except Exception as exc:  # pragma: no cover
            LOGGER.debug("Failed to publish metrics for %s: %s", plant_id, exc)

    async def _maybe_publish_command(
        self,
        plant_id: str,
        area_m2: float,
        cfg: StepConfig,
        result,
    ) -> None:
        if not cfg.auto_mode:
            return
        if not result.need_irrigation or result.recommend_mm <= 0.0:
            return

        dose_mm = min(result.recommend_mm, cfg.max_auto_irrigation_mm)
        dose_mL = mm_to_mL(dose_mm, area_m2)
        if dose_mL <= 0.0 or math.isnan(dose_mL):
            return

        command = {
            "dose_mL": dose_mL,
            "source": "etkc",
            "timestamp": time.time(),
        }
        try:
            await self._client.publish(
                IRRIGATION_CMD_TOPIC_FMT.format(plant_id=plant_id),
                json.dumps(command),
                qos=0,
            )
            LOGGER.info("Auto irrigation command published for %s: %.1f mL", plant_id, dose_mL)
        except MqttCodeError as exc:
            if self._is_not_connected_error(exc):
                await self._notify_disconnect("publish irrigation command", exc)
            else:  # pragma: no cover - unexpected publish failures
                LOGGER.warning("Failed to publish auto irrigation command for %s: %s", plant_id, exc)
        except MqttError as exc:  # pragma: no cover - non code MQTT error
            LOGGER.warning("Failed to publish auto irrigation command for %s: %s", plant_id, exc)
        except Exception as exc:  # pragma: no cover
            LOGGER.warning("Failed to publish auto irrigation command for %s: %s", plant_id, exc)

    async def _handle_loop_exception(self, exc: Exception) -> None:
        if self._is_not_connected_error(exc):
            await self._notify_disconnect("etkc worker", exc)
            return
        LOGGER.warning("ETc worker loop error: %s", exc)
        await asyncio.sleep(1.0)

    async def _handle_unsubscribe_error(self, exc: Exception) -> None:
        if self._is_not_connected_error(exc):
            await self._notify_disconnect("etkc worker unsubscribe", exc)
            return
        LOGGER.debug("ETc worker unsubscribe failed: %s", exc)

    async def _notify_disconnect(self, context: str, exc: BaseException | None) -> None:
        LOGGER.warning("ETc worker detected MQTT disconnect during %s: %s", context, exc)
        self._running = False
        if self._on_disconnect is not None:
            try:
                await self._on_disconnect(context, exc)
            except Exception as callback_exc:  # pragma: no cover - defensive logging
                LOGGER.debug("Disconnect callback failed: %s", callback_exc)
        delay = self._backoff_seconds
        if delay > 0:
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


def _extract_plant_id(topic: Any) -> Optional[str]:
    parts = str(topic).split("/")
    if len(parts) >= 3 and parts[0] == "plant" and parts[2] == "telemetry":
        return parts[1]
    return None


async def _build_step_sensors(payload: Dict[str, Any]) -> tuple[StepSensors, Dict[str, Any]]:
    payload_source = _coerce_source(payload.get("source"))
    payload_timestamp = _extract_payload_timestamp(payload)
    T_C, RH_pct, source_used, source_label, source_timestamp = await _select_temperature_humidity(payload)

    Rs = _coerce_float(payload, ["Rs_MJ_m2_h", "Rs", "solar_rad"])
    PAR = _coerce_float(payload, ["PAR_umol_m2_s", "PAR"])
    inflow_mL = _coerce_float(payload, ["inflow_mL", "inflow"])
    drain_mL = _coerce_float(payload, ["drain_mL", "drain"])
    dStorage_mL = _coerce_float(payload, ["dStorage_mL", "dStorage"])
    theta = _coerce_float(payload, ["theta", "soil_theta", "moisture_theta"])
    u2_ms = _coerce_float(payload, ["u2_ms", "wind_ms"])

    if Rs is None and PAR is not None:
        Rs = PAR * PAR_UMOL_TO_MJ_PER_H
    Rs = Rs if Rs is not None else 0.0

    inflow_mL = inflow_mL if inflow_mL is not None else 0.0
    drain_mL = drain_mL if drain_mL is not None else 0.0

    AC_on = _coerce_bool(payload.get("AC_on", payload.get("ac_on", payload.get("ac"))))

    if source_used != "sensor":
        LOGGER.info("Using %s environment data for ET step temperature/humidity inputs", source_label)

    sensors = StepSensors(
        T_C=T_C,
        RH_pct=RH_pct,
        Rs_MJ_m2_h=Rs,
        u2_ms=u2_ms,
        theta=theta,
        inflow_mL=inflow_mL,
        drain_mL=drain_mL,
        dStorage_mL=dStorage_mL,
        AC_on=AC_on if AC_on is not None else False,
    )

    metadata = {
        "environment": {
            "source": source_used,
            "label": source_label,
            "timestamp": _isoformat_ts(source_timestamp),
        },
        "payload": {
            "source": payload_source,
            "timestamp": _isoformat_ts(payload_timestamp),
        },
    }

    return sensors, metadata


def _build_metric_metadata(message: Message, sensor_meta: Dict[str, Any]) -> Dict[str, Any]:
    metadata = dict(sensor_meta)
    metadata["telemetry"] = {
        "topic": str(message.topic),
        "qos": getattr(message, "qos", None),
        "retain": bool(getattr(message, "retain", False)),
        "received_at": _isoformat_ts(datetime.now(timezone.utc)),
    }
    return metadata


async def _select_temperature_humidity(payload: Dict[str, Any]) -> tuple[float, float, str, str, Optional[datetime]]:
    window = _env_sensor_freshness()
    now = datetime.now(timezone.utc)

    payload_temp, payload_rh, payload_source, payload_ts = _extract_payload_environment(payload)
    if payload_temp is not None and payload_rh is not None and _payload_is_local(payload_source):
        if window is None or payload_ts is None or (now - payload_ts) <= window:
            display = payload_source or "sensor"
            return payload_temp, payload_rh, "sensor", display, payload_ts

    sample = await telemetry_store.latest_matching(
        source_filter=("sensor",),
        max_age=window,
        require=("temperature_c", "humidity_pct"),
    )
    if sample is not None:
        display = sample.source or "sensor"
        return sample.temperature_c, sample.humidity_pct, display.lower(), display, sample.timestamp

    if payload_temp is not None and payload_rh is not None:
        if window is None or payload_ts is None or (now - payload_ts) <= window:
            display = payload_source or "payload"
            canonical = display.lower()
            return payload_temp, payload_rh, canonical, display, payload_ts

    fallback = await telemetry_store.latest_matching(
        max_age=window,
        require=("temperature_c", "humidity_pct"),
    )
    if fallback is not None:
        display = fallback.source or "weather"
        return fallback.temperature_c, fallback.humidity_pct, display.lower(), display, fallback.timestamp

    raise ValueError("Missing required temperature or humidity measurements.")


def _extract_payload_environment(payload: Dict[str, Any]) -> tuple[Optional[float], Optional[float], Optional[str], Optional[datetime]]:
    temp = _coerce_float(payload, ["T_C", "temperature_C", "temperature"])
    rh_raw = _coerce_float(payload, ["RH_pct", "relative_humidity", "humidity_pct", "humidity"])

    rh_pct = _normalize_rh_pct(rh_raw) if rh_raw is not None else None
    source = _coerce_source(payload.get("source"))
    timestamp = _extract_payload_timestamp(payload)

    return temp, rh_pct, source, timestamp


def _normalize_rh_pct(raw: float) -> float:
    if not math.isfinite(raw):
        raise ValueError("Relative humidity must be finite.")
    value = raw * 100.0 if raw <= 1.0 else raw
    value = max(0.0, min(value, 100.0))
    return value


def _extract_payload_timestamp(payload: Dict[str, Any]) -> Optional[datetime]:
    timestamp_ms = _coerce_float(payload, ["timestampMs", "timestamp_ms"])
    if timestamp_ms is not None:
        try:
            return datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            LOGGER.debug("Ignoring invalid timestampMs value in telemetry payload")

    raw = payload.get("timestamp")
    if isinstance(raw, str) and raw.strip():
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            LOGGER.debug("Ignoring invalid ISO timestamp in telemetry payload")
    return None


def _isoformat_ts(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    iso = value.astimezone(timezone.utc).isoformat(timespec="seconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def _payload_is_local(source: Optional[str]) -> bool:
    if source is None:
        return True
    lowered = source.lower()
    if "weather" in lowered or "hrrr" in lowered or "forecast" in lowered:
        return False
    return True


def _coerce_source(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return str(value).strip() if value else None


def _coerce_float(payload: Dict[str, Any], keys: list[str]) -> Optional[float]:
    for key in keys:
        value = payload.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _coerce_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lower = value.strip().lower()
        if lower in {"true", "1", "yes", "on"}:
            return True
        if lower in {"false", "0", "no", "off"}:
            return False
    return None


_WORKER: Optional[EtkcWorker] = None


async def start_worker(
    client: Optional[Client] = None,
    *,
    on_disconnect: Optional[Callable[[str, BaseException | None], Awaitable[None]]] = None,
) -> None:
    global _WORKER
    if _WORKER is not None:
        return
    if client is None:
        from mqtt.client import get_mqtt_manager  # lazy import to avoid circular dependency

        manager = get_mqtt_manager()
        if manager is None:
            LOGGER.info("MQTT manager not available; ETc worker not started.")
            return
        client = manager.get_client()
        if on_disconnect is None:
            on_disconnect = manager.notify_disconnect
    _WORKER = EtkcWorker(client, on_disconnect=on_disconnect)
    await _WORKER.start()


async def stop_worker() -> None:
    global _WORKER
    if _WORKER is None:
        return
    await _WORKER.stop()
    _WORKER = None
