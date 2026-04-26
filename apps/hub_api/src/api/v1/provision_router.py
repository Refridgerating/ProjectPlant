from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.provisioning import ProvisionedDeviceSnapshot, normalize_device_id, provisioning_store

router = APIRouter(prefix="/provision", tags=["provisioning"])


class ProvisionWaitRequest(BaseModel):
    timeout: float = Field(default=120.0, ge=0.5, le=600.0)
    require_fresh: bool = Field(default=True)
    device_id: Optional[str] = Field(
        default=None,
        description="Optional 12-hex device identifier (case-insensitive).",
    )
    method: Optional[str] = Field(
        default=None,
        description="Provisioning transport identifier, e.g. 'ble' or 'softap'.",
        max_length=32,
    )


class ProvisionedDeviceModel(BaseModel):
    id: str
    topic: str
    online: bool
    state: Optional[str] = None
    last_seen: int
    first_seen: int
    retained: bool = False
    fresh: bool = False
    method: Optional[str] = None


class ProvisionWaitResponse(BaseModel):
    status: Literal["online", "timeout"]
    device: Optional[ProvisionedDeviceModel] = None
    elapsed: float
    method: Optional[str] = None


@router.post("/wait", response_model=ProvisionWaitResponse)
async def provision_wait(request: ProvisionWaitRequest) -> ProvisionWaitResponse:
    normalized_id = normalize_device_id(request.device_id)
    if request.device_id and normalized_id is None:
        raise HTTPException(status_code=422, detail="device_id must be a 12-digit hexadecimal string")

    timeout = max(0.5, min(request.timeout, 600.0))
    method = request.method.lower() if isinstance(request.method, str) else None
    event, elapsed = await provisioning_store.wait_for_device(
        timeout=timeout,
        device_id=normalized_id,
        require_fresh=request.require_fresh,
        method=method,
    )

    if event is None:
        return ProvisionWaitResponse(status="timeout", device=None, elapsed=elapsed, method=method)

    snapshot = _serialize_snapshot(event.device)
    return ProvisionWaitResponse(status="online", device=snapshot, elapsed=elapsed, method=snapshot.method or method)


def _serialize_snapshot(snapshot: ProvisionedDeviceSnapshot) -> ProvisionedDeviceModel:
    return ProvisionedDeviceModel(
        id=snapshot.id,
        topic=snapshot.topic,
        online=snapshot.online,
        state=snapshot.state,
        last_seen=int(snapshot.last_seen),
        first_seen=int(snapshot.first_seen),
        retained=bool(snapshot.retained),
        fresh=bool(snapshot.fresh),
        method=snapshot.method,
    )
