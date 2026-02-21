from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from config import settings
from services.commands import CommandServiceError, CommandTimeoutError, SensorReadResult, command_service
from services.plant_schedule import PotSchedule, ScheduleTimer, plant_schedule_service
from services.pot_ids import normalize_pot_id
from services.pump_status import PumpStatusSnapshot, pump_status_cache
from services.plant_telemetry import plant_telemetry_store

logger = logging.getLogger("projectplant.hub.api.plant_control")
router = APIRouter(prefix="/plant-control", tags=["plant-control"])


def _utc_now_iso() -> str:
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return iso.replace("+00:00", "Z")


def _normalize_status_payload(payload: dict[str, Any], pot_id: str, request_id: str | None) -> dict[str, Any]:
    normalized = dict(payload)
    aliases = {
        "pot_id": "potId",
        "received_at": "receivedAt",
        "pump_on": "pumpOn",
        "fan_on": "fanOn",
        "mister_on": "misterOn",
        "light_on": "lightOn",
        "request_id": "requestId",
        "timestamp_ms": "timestampMs",
        "device_name": "deviceName",
        "is_named": "isNamed",
        "sensor_mode": "sensorMode",
    }
    for source_key, target_key in aliases.items():
        if target_key not in normalized and source_key in normalized:
            normalized[target_key] = normalized[source_key]

    raw_pot_id = normalized.get("potId") or pot_id
    if isinstance(raw_pot_id, str):
        cleaned = raw_pot_id.strip()
    else:
        cleaned = ""
    normalized_pot_id = normalize_pot_id(cleaned) or pot_id
    normalized["potId"] = normalized_pot_id

    received_at = normalized.get("receivedAt")
    if not isinstance(received_at, str) or not received_at.strip():
        normalized["receivedAt"] = _utc_now_iso()

    if request_id and not normalized.get("requestId"):
        normalized["requestId"] = request_id

    if "sensorMode" not in normalized:
        sensors_enabled = normalized.get("sensorsEnabled")
        if isinstance(sensors_enabled, bool):
            normalized["sensorMode"] = "full" if sensors_enabled else "control_only"

    return normalized


class SensorReadPayload(BaseModel):
    potId: str
    moisture: float
    temperature: float
    valveOpen: bool
    timestamp: str
    humidity: float | None = None
    flowRateLpm: float | None = None
    waterLow: bool | None = None
    waterCutoff: bool | None = None
    soilRaw: float | int | None = None
    timestampMs: float | int | None = None
    fanOn: bool | None = None
    misterOn: bool | None = None
    lightOn: bool | None = None

    model_config = ConfigDict(extra="allow")

    @classmethod
    def from_result(cls, result: SensorReadResult) -> "SensorReadPayload":
        payload: dict[str, Any] = result.payload
        return cls.model_validate(payload)


class PumpControlRequest(BaseModel):
    on: bool
    duration_ms: float | int | None = Field(
        default=None,
        alias="durationMs",
        gt=0,
        description="Optional pump run duration in milliseconds. Positive values only.",
    )
    timeout: float | None = Field(
        default=None,
        ge=0.1,
        le=30.0,
        description="Optional timeout (seconds) to wait for a status update after issuing the pump command.",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FanControlRequest(BaseModel):
    on: bool
    duration_ms: float | int | None = Field(
        default=None,
        alias="durationMs",
        ge=0,
        description="Optional fan run duration in milliseconds. Non-negative values only.",
    )
    timeout: float | None = Field(
        default=None,
        ge=0.1,
        le=30.0,
        description="Optional timeout (seconds) to wait for a status update after issuing the fan command.",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class MisterControlRequest(BaseModel):
    on: bool
    duration_ms: float | int | None = Field(
        default=None,
        alias="durationMs",
        ge=0,
        description="Optional mister run duration in milliseconds. Non-negative values only.",
    )
    timeout: float | None = Field(
        default=None,
        ge=0.1,
        le=30.0,
        description="Optional timeout (seconds) to wait for a status update after issuing the mister command.",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LightControlRequest(BaseModel):
    on: bool
    duration_ms: float | int | None = Field(
        default=None,
        alias="durationMs",
        ge=0,
        description="Optional light run duration in milliseconds. Non-negative values only.",
    )
    timeout: float | None = Field(
        default=None,
        ge=0.1,
        le=30.0,
        description="Optional timeout (seconds) to wait for a status update after issuing the light command.",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class DeviceNameRequest(BaseModel):
    device_name: str = Field(
        ...,
        alias="deviceName",
        min_length=1,
        max_length=32,
        description="Display name to store on the device.",
    )
    timeout: float | None = Field(
        default=None,
        ge=0.1,
        le=30.0,
        description="Optional timeout (seconds) to wait for the name update status.",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SensorModeRequest(BaseModel):
    sensor_mode: Literal["full", "control_only"] = Field(
        ...,
        alias="sensorMode",
        description="Sensor mode for the device: full (with safety floats) or control_only (no sensors).",
    )
    timeout: float | None = Field(
        default=None,
        ge=0.1,
        le=30.0,
        description="Optional timeout (seconds) to wait for the mode update status.",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class PumpStatusPayload(BaseModel):
    potId: str
    receivedAt: str
    status: str | None = None
    pumpOn: bool | None = None
    fanOn: bool | None = None
    misterOn: bool | None = None
    lightOn: bool | None = None
    requestId: str | None = None
    timestamp: str | None = None
    timestampMs: int | None = None
    deviceName: str | None = None
    isNamed: bool | None = None
    sensorMode: str | None = None

    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class PlantScheduleTimerPayload(BaseModel):
    enabled: bool = False
    start_time: str = Field(
        default="00:00",
        alias="startTime",
        pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$",
    )
    end_time: str = Field(
        default="00:00",
        alias="endTime",
        pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def to_timer(self) -> ScheduleTimer:
        return ScheduleTimer(
            enabled=self.enabled,
            start_time=self.start_time,
            end_time=self.end_time,
        )


class PlantSchedulePayload(BaseModel):
    pot_id: str = Field(..., alias="potId")
    light: PlantScheduleTimerPayload
    pump: PlantScheduleTimerPayload
    mister: PlantScheduleTimerPayload
    fan: PlantScheduleTimerPayload
    updated_at: str = Field(..., alias="updatedAt")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @classmethod
    def from_schedule(cls, schedule: PotSchedule) -> "PlantSchedulePayload":
        return cls.model_validate(schedule.to_payload())


class PlantScheduleUpdateRequest(BaseModel):
    light: PlantScheduleTimerPayload
    pump: PlantScheduleTimerPayload
    mister: PlantScheduleTimerPayload | None = None
    fan: PlantScheduleTimerPayload

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


@router.post(
    "/{pot_id}/sensor-read",
    response_model=SensorReadPayload,
    response_model_exclude_none=True,
)
async def request_sensor_read(
    pot_id: str,
    response: Response,
    timeout: float | None = Query(
        default=None,
        ge=0.1,
        le=30.0,
        description="Optional timeout (seconds) to wait for a fresh sensor reading.",
    ),
) -> SensorReadPayload:
    start = time.monotonic()
    logger.debug("sensor-read command received for %s (timeout=%s)", pot_id, timeout)
    try:
        result = await command_service.request_sensor_read(pot_id, timeout=timeout)
    except CommandTimeoutError as exc:
        elapsed = time.monotonic() - start
        logger.warning("sensor-read for %s timed out after %.2fs: %s", pot_id, elapsed, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        elapsed = time.monotonic() - start
        logger.error("sensor-read for %s failed: %s", pot_id, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    elapsed = time.monotonic() - start
    logger.debug(
        "sensor-read for %s completed in %.2fs (requestId=%s)",
        pot_id,
        elapsed,
        result.request_id,
    )
    response.headers["X-Command-Request-Id"] = result.request_id
    payload = SensorReadPayload.from_result(result)
    await _persist_sensor_snapshot(payload, source="sensor-read", request_id=result.request_id)
    return payload


@router.post(
    "/{pot_id}/pump",
    response_model=SensorReadPayload,
    response_model_exclude_none=True,
)
async def control_pump(pot_id: str, payload: PumpControlRequest, response: Response) -> SensorReadPayload:
    start = time.monotonic()
    logger.debug(
        "pump control command received for %s (on=%s, durationMs=%s, timeout=%s)",
        pot_id,
        payload.on,
        payload.duration_ms,
        payload.timeout,
    )
    try:
        result = await command_service.control_pump(
            pot_id,
            on=payload.on,
            duration_ms=float(payload.duration_ms) if payload.duration_ms is not None else None,
            timeout=payload.timeout,
        )
    except CommandTimeoutError as exc:
        elapsed = time.monotonic() - start
        logger.warning("pump control for %s timed out after %.2fs: %s", pot_id, elapsed, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        elapsed = time.monotonic() - start
        logger.error("pump control for %s failed: %s", pot_id, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    elapsed = time.monotonic() - start
    logger.debug(
        "pump control for %s completed in %.2fs (requestId=%s)",
        pot_id,
        elapsed,
        result.request_id,
    )
    response.headers["X-Command-Request-Id"] = result.request_id
    payload = SensorReadPayload.from_result(result)
    await _persist_sensor_snapshot(payload, source="pump-control", request_id=result.request_id)
    return payload


@router.post(
    "/{pot_id}/fan",
    response_model=SensorReadPayload,
    response_model_exclude_none=True,
)
async def control_fan(pot_id: str, payload: FanControlRequest, response: Response) -> SensorReadPayload:
    start = time.monotonic()
    logger.debug(
        "fan control command received for %s (on=%s, durationMs=%s, timeout=%s)",
        pot_id,
        payload.on,
        payload.duration_ms,
        payload.timeout,
    )
    try:
        result = await command_service.control_fan(
            pot_id,
            on=payload.on,
            duration_ms=float(payload.duration_ms) if payload.duration_ms is not None else None,
            timeout=payload.timeout,
        )
    except CommandTimeoutError as exc:
        elapsed = time.monotonic() - start
        logger.warning("fan control for %s timed out after %.2fs: %s", pot_id, elapsed, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        elapsed = time.monotonic() - start
        logger.error("fan control for %s failed: %s", pot_id, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    elapsed = time.monotonic() - start
    logger.debug(
        "fan control for %s completed in %.2fs (requestId=%s)",
        pot_id,
        elapsed,
        result.request_id,
    )
    response.headers["X-Command-Request-Id"] = result.request_id
    payload_model = SensorReadPayload.from_result(result)
    await _persist_sensor_snapshot(payload_model, source="fan-control", request_id=result.request_id)
    return payload_model


@router.post(
    "/{pot_id}/mister",
    response_model=SensorReadPayload,
    response_model_exclude_none=True,
)
async def control_mister(pot_id: str, payload: MisterControlRequest, response: Response) -> SensorReadPayload:
    start = time.monotonic()
    logger.debug(
        "mister control command received for %s (on=%s, durationMs=%s, timeout=%s)",
        pot_id,
        payload.on,
        payload.duration_ms,
        payload.timeout,
    )
    try:
        result = await command_service.control_mister(
            pot_id,
            on=payload.on,
            duration_ms=float(payload.duration_ms) if payload.duration_ms is not None else None,
            timeout=payload.timeout,
        )
    except CommandTimeoutError as exc:
        elapsed = time.monotonic() - start
        logger.warning("mister control for %s timed out after %.2fs: %s", pot_id, elapsed, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        elapsed = time.monotonic() - start
        logger.error("mister control for %s failed: %s", pot_id, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    elapsed = time.monotonic() - start
    logger.debug(
        "mister control for %s completed in %.2fs (requestId=%s)",
        pot_id,
        elapsed,
        result.request_id,
    )
    response.headers["X-Command-Request-Id"] = result.request_id
    payload_model = SensorReadPayload.from_result(result)
    await _persist_sensor_snapshot(payload_model, source="mister-control", request_id=result.request_id)
    return payload_model


@router.post(
    "/{pot_id}/light",
    response_model=SensorReadPayload,
    response_model_exclude_none=True,
)
async def control_light(pot_id: str, payload: LightControlRequest, response: Response) -> SensorReadPayload:
    start = time.monotonic()
    logger.debug(
        "light control command received for %s (on=%s, durationMs=%s, timeout=%s)",
        pot_id,
        payload.on,
        payload.duration_ms,
        payload.timeout,
    )
    try:
        result = await command_service.control_light(
            pot_id,
            on=payload.on,
            duration_ms=float(payload.duration_ms) if payload.duration_ms is not None else None,
            timeout=payload.timeout,
        )
    except CommandTimeoutError as exc:
        elapsed = time.monotonic() - start
        logger.warning("light control for %s timed out after %.2fs: %s", pot_id, elapsed, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        elapsed = time.monotonic() - start
        logger.error("light control for %s failed: %s", pot_id, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    elapsed = time.monotonic() - start
    logger.debug(
        "light control for %s completed in %.2fs (requestId=%s)",
        pot_id,
        elapsed,
        result.request_id,
    )
    response.headers["X-Command-Request-Id"] = result.request_id
    payload_model = SensorReadPayload.from_result(result)
    await _persist_sensor_snapshot(payload_model, source="light-control", request_id=result.request_id)
    return payload_model


@router.post(
    "/{pot_id}/name",
    response_model=PumpStatusPayload,
    response_model_exclude_none=True,
)
async def set_device_name(pot_id: str, payload: DeviceNameRequest, response: Response) -> PumpStatusPayload:
    start = time.monotonic()
    logger.debug(
        "device name update received for %s (deviceName=%s, timeout=%s)",
        pot_id,
        payload.device_name,
        payload.timeout,
    )
    try:
        result = await command_service.set_device_name(pot_id, name=payload.device_name, timeout=payload.timeout)
    except CommandTimeoutError as exc:
        elapsed = time.monotonic() - start
        logger.warning("device name update for %s timed out after %.2fs: %s", pot_id, elapsed, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        elapsed = time.monotonic() - start
        logger.error("device name update for %s failed: %s", pot_id, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    elapsed = time.monotonic() - start
    logger.debug(
        "device name update for %s completed in %.2fs (requestId=%s)",
        pot_id,
        elapsed,
        result.request_id,
    )
    response.headers["X-Command-Request-Id"] = result.request_id
    payload = result.payload if isinstance(result.payload, dict) else {}
    normalized = _normalize_status_payload(payload, pot_id, result.request_id)
    snapshot = PumpStatusSnapshot(
        pot_id=normalized["potId"],
        status=normalized.get("status"),
        pump_on=normalized.get("pumpOn"),
        fan_on=normalized.get("fanOn"),
        mister_on=normalized.get("misterOn"),
        light_on=normalized.get("lightOn"),
        request_id=normalized.get("requestId"),
        timestamp=normalized.get("timestamp"),
        timestamp_ms=normalized.get("timestampMs"),
        received_at=normalized["receivedAt"],
        device_name=normalized.get("deviceName"),
        is_named=normalized.get("isNamed"),
        sensor_mode=normalized.get("sensorMode"),
    )
    pump_status_cache.update(snapshot, merge=True)
    return PumpStatusPayload.model_validate(normalized)


@router.post(
    "/{pot_id}/sensor-mode",
    response_model=PumpStatusPayload,
    response_model_exclude_none=True,
)
async def set_sensor_mode(pot_id: str, payload: SensorModeRequest, response: Response) -> PumpStatusPayload:
    start = time.monotonic()
    logger.debug(
        "sensor mode update received for %s (sensorMode=%s, timeout=%s)",
        pot_id,
        payload.sensor_mode,
        payload.timeout,
    )
    try:
        result = await command_service.set_sensor_mode(pot_id, mode=payload.sensor_mode, timeout=payload.timeout)
    except CommandTimeoutError as exc:
        elapsed = time.monotonic() - start
        logger.warning("sensor mode update for %s timed out after %.2fs: %s", pot_id, elapsed, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        elapsed = time.monotonic() - start
        logger.error("sensor mode update for %s failed: %s", pot_id, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    elapsed = time.monotonic() - start
    logger.debug(
        "sensor mode update for %s completed in %.2fs (requestId=%s)",
        pot_id,
        elapsed,
        result.request_id,
    )
    response.headers["X-Command-Request-Id"] = result.request_id
    payload_dict = result.payload if isinstance(result.payload, dict) else {}
    normalized = _normalize_status_payload(payload_dict, pot_id, result.request_id)
    if "sensorMode" not in normalized:
        normalized["sensorMode"] = payload.sensor_mode
    snapshot = PumpStatusSnapshot(
        pot_id=normalized["potId"],
        status=normalized.get("status"),
        pump_on=normalized.get("pumpOn"),
        fan_on=normalized.get("fanOn"),
        mister_on=normalized.get("misterOn"),
        light_on=normalized.get("lightOn"),
        request_id=normalized.get("requestId"),
        timestamp=normalized.get("timestamp"),
        timestamp_ms=normalized.get("timestampMs"),
        received_at=normalized["receivedAt"],
        device_name=normalized.get("deviceName"),
        is_named=normalized.get("isNamed"),
        sensor_mode=normalized.get("sensorMode"),
    )
    pump_status_cache.update(snapshot, merge=True)
    return PumpStatusPayload.model_validate(normalized)


@router.get(
    "/{pot_id}/schedule",
    response_model=PlantSchedulePayload,
    response_model_exclude_none=True,
)
async def get_plant_schedule(pot_id: str) -> PlantSchedulePayload:
    try:
        schedule = plant_schedule_service.get_schedule(pot_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PlantSchedulePayload.from_schedule(schedule)


@router.put(
    "/{pot_id}/schedule",
    response_model=PlantSchedulePayload,
    response_model_exclude_none=True,
)
async def update_plant_schedule(pot_id: str, payload: PlantScheduleUpdateRequest) -> PlantSchedulePayload:
    try:
        existing = plant_schedule_service.get_schedule(pot_id)
        mister_timer = payload.mister.to_timer() if payload.mister is not None else existing.mister
        schedule = plant_schedule_service.update_schedule(
            pot_id,
            light=payload.light.to_timer(),
            pump=payload.pump.to_timer(),
            mister=mister_timer,
            fan=payload.fan.to_timer(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if settings.mqtt_enabled:
        await plant_schedule_service.sync_schedule_to_device(schedule)
        await plant_schedule_service.apply_schedule_now(schedule.pot_id)
    return PlantSchedulePayload.from_schedule(schedule)


@router.get(
    "/{pot_id}/status",
    response_model=PumpStatusPayload,
    response_model_exclude_none=True,
)
async def get_pump_status(pot_id: str) -> PumpStatusPayload:
    snapshot = pump_status_cache.get(pot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Pump status unavailable")
    return PumpStatusPayload.model_validate(snapshot.to_dict())


async def _persist_sensor_snapshot(payload: SensorReadPayload, *, source: str, request_id: str | None) -> None:
    try:
        await plant_telemetry_store.record(
            pot_id=payload.potId,
            timestamp=payload.timestamp,
            timestamp_ms=payload.timestampMs,
            moisture=payload.moisture,
            temperature=payload.temperature,
            humidity=payload.humidity,
            pressure=None,
            solar=None,
            wind=None,
            valve_open=payload.valveOpen,
            fan_on=payload.fanOn,
            mister_on=payload.misterOn,
            light_on=payload.lightOn,
            flow_rate=payload.flowRateLpm,
            water_low=payload.waterLow,
            water_cutoff=payload.waterCutoff,
            soil_raw=payload.soilRaw,
            source=source,
            request_id=request_id,
        )
    except Exception as exc:  # pragma: no cover - defensive logging
        logger.warning("Failed to persist sensor snapshot for %s: %s", payload.potId, exc)
