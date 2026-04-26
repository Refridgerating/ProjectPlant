from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.device_registry import device_registry
from services.pot_ids import normalize_pot_id
from services.pump_status import pump_status_cache

router = APIRouter(prefix="/devices", tags=["devices"])


class DeviceRegistryEntryModel(BaseModel):
    potId: str
    addedAt: str


class DeviceRegistryResponse(BaseModel):
    devices: list[DeviceRegistryEntryModel]


class DeviceRegistryRequest(BaseModel):
    potId: str = Field(..., description="Pot identifier to track manually.")


class DeviceRegistryUpdateResponse(BaseModel):
    device: DeviceRegistryEntryModel
    created: bool


class DeviceRegistryDeleteResponse(BaseModel):
    removed: bool
    purged: bool


@router.get("", response_model=DeviceRegistryResponse)
async def list_devices() -> DeviceRegistryResponse:
    entries = device_registry.list_entries()
    return DeviceRegistryResponse(devices=[DeviceRegistryEntryModel(**entry.to_payload()) for entry in entries])


@router.post("", response_model=DeviceRegistryUpdateResponse)
async def add_device(request: DeviceRegistryRequest) -> DeviceRegistryUpdateResponse:
    normalized = normalize_pot_id(request.potId)
    if not normalized:
        raise HTTPException(status_code=422, detail="potId is required")
    try:
        entry, created = device_registry.add(normalized)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return DeviceRegistryUpdateResponse(device=DeviceRegistryEntryModel(**entry.to_payload()), created=created)


@router.delete("/{pot_id}", response_model=DeviceRegistryDeleteResponse)
async def delete_device(
    pot_id: str,
    purge_cache: bool = Query(True, alias="purgeCache"),
) -> DeviceRegistryDeleteResponse:
    normalized = normalize_pot_id(pot_id)
    if not normalized:
        raise HTTPException(status_code=422, detail="pot_id is required")
    removed = device_registry.remove(normalized)
    purged = pump_status_cache.delete(normalized) if purge_cache else False
    if not removed and not purged:
        raise HTTPException(status_code=404, detail="Device not found")
    return DeviceRegistryDeleteResponse(removed=removed, purged=purged)
