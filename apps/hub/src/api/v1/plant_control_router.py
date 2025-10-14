from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict

from services.commands import (
    CommandServiceError,
    CommandTimeoutError,
    SensorReadResult,
    command_service,
)

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
