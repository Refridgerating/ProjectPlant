from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from services.commands import CommandServiceError, CommandTimeoutError, SensorReadResult, command_service
from services.pump_status import pump_status_cache
from services.plant_telemetry import plant_telemetry_store

logger = logging.getLogger("projectplant.hub.api.plant_control")
router = APIRouter(prefix="/plant-control", tags=["plant-control"])


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


class PumpStatusPayload(BaseModel):
    potId: str
    receivedAt: str
    status: str | None = None
    pumpOn: bool | None = None
    requestId: str | None = None
    timestamp: str | None = None
    timestampMs: int | None = None

    model_config = ConfigDict(extra="ignore", populate_by_name=True)


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
            flow_rate=payload.flowRateLpm,
            water_low=payload.waterLow,
            water_cutoff=payload.waterCutoff,
            soil_raw=payload.soilRaw,
            source=source,
            request_id=request_id,
        )
    except Exception as exc:  # pragma: no cover - defensive logging
        logger.warning("Failed to persist sensor snapshot for %s: %s", payload.potId, exc)
