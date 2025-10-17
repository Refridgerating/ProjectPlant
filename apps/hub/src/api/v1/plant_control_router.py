from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from services.commands import CommandServiceError, CommandTimeoutError, SensorReadResult, command_service
from services.pump_status import pump_status_cache

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
    try:
        result = await command_service.request_sensor_read(pot_id, timeout=timeout)
    except CommandTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    response.headers["X-Command-Request-Id"] = result.request_id
    return SensorReadPayload.from_result(result)


@router.post(
    "/{pot_id}/pump",
    response_model=SensorReadPayload,
    response_model_exclude_none=True,
)
async def control_pump(pot_id: str, payload: PumpControlRequest, response: Response) -> SensorReadPayload:
    try:
        result = await command_service.control_pump(
            pot_id,
            on=payload.on,
            duration_ms=float(payload.duration_ms) if payload.duration_ms is not None else None,
            timeout=payload.timeout,
        )
    except CommandTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except CommandServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    response.headers["X-Command-Request-Id"] = result.request_id
    return SensorReadPayload.from_result(result)


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
