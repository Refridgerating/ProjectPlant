from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from config import settings
from mqtt.client import get_mqtt_manager
from services.alerts import alerts_service
from services.device_registry import device_registry
from services.pot_ids import normalize_pot_id
from services.pump_status import pump_status_cache
from services.weather import cache as weather_cache
from services.weather_hrrr import hrrr_weather_service

HEARTBEAT_WARN_SECONDS = 180.0
HEARTBEAT_CRITICAL_SECONDS = 300.0
HRRR_STALE_WARN_SECONDS = 3 * 3600.0
HRRR_STALE_CRITICAL_SECONDS = 6 * 3600.0

router = APIRouter(prefix="/health", tags=["health"])
logger = logging.getLogger("projectplant.hub.health")

class CacheEntryModel(BaseModel):
    path: str = Field(description="Path relative to the HRRR cache directory.")
    bytes: int = Field(ge=0, description="Size of the file in bytes.")
    modified: str = Field(description="Last modification time (ISO-8601).")
    kind: Literal["grib", "metadata", "log", "other"] = Field(
        description="File classification (grib, metadata, log, other)."
    )
    cycle: str | None = Field(default=None, description="Cycle timestamp parsed from metadata, when available.")
    forecast_hour: int | None = Field(default=None, description="Forecast hour parsed from metadata.")
    valid_time: str | None = Field(default=None, description="Valid timestamp parsed from metadata.")
    domain: str | None = Field(default=None, description="Domain parsed from metadata.")
    has_metadata: bool | None = Field(default=None, description="True when a paired metadata file exists.")


class CacheEntriesResponse(BaseModel):
    cache_dir: str
    total_files: int
    total_bytes: int
    order: str
    limit: int
    entries: list[CacheEntryModel]


class CacheMutationDetail(BaseModel):
    path: str
    bytes: int | None = None
    status: str
    detail: str | None = None


class CacheDeletionResponse(BaseModel):
    processed: int
    bytes_removed: int
    details: list[CacheMutationDetail]


class CacheStoreResponse(BaseModel):
    processed: int
    bytes_moved: int
    destination: str
    label: str | None = None
    details: list[CacheMutationDetail]


class CacheMutationRequest(BaseModel):
    entries: List[str] = Field(min_length=1, description="Relative file paths within the HRRR cache.")
    include_metadata: bool = Field(
        default=True,
        description="Also act on associated .grib2.json metadata files when touching GRIB assets.",
    )


class CacheStoreRequest(CacheMutationRequest):
    label: str | None = Field(
        default=None,
        description="Optional label appended to the archive folder name when storing files.",
        max_length=64,
    )


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    iso = value.astimezone(timezone.utc).isoformat(timespec="seconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        cleaned = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _status_rank(status: str) -> int:
    mapping = {"critical": 3, "warning": 2, "ok": 1, "disabled": 0, "unknown": 0}
    return mapping.get(status, 0)


def _combine_status(statuses: Iterable[str]) -> str:
    result = "ok"
    for status in statuses:
        if _status_rank(status) > _status_rank(result):
            result = status
    return result


@router.get("")
async def health_summary(request: Request) -> Dict[str, object]:
    uptime = _uptime_payload(request)
    database = await _check_database()
    overall = _combine_status([database["status"]])
    return {
        "status": overall,
        "version": settings.app_version,
        "uptime": uptime,
        "database": database,
    }


@router.get("/mqtt")
async def health_mqtt() -> Dict[str, object]:
    enabled = settings.mqtt_enabled
    now = _utc_now()
    heartbeat = await _gather_heartbeat(now)

    if not enabled:
        return {
            "enabled": False,
            "status": "disabled",
            "connection": None,
            "heartbeat": heartbeat,
        }

    manager = get_mqtt_manager()
    if manager is None:
        connection = {
            "connected": False,
            "reconnecting": False,
            "host": settings.mqtt_host,
            "port": settings.mqtt_port,
            "client_id": settings.mqtt_client_id,
            "last_connect_time": None,
            "last_disconnect_time": None,
            "last_disconnect_reason": "manager_unavailable",
        }
        status = "critical"
    else:
        connection = manager.status_snapshot()
        status = "ok" if connection.get("connected") else "critical"

    overall = _combine_status([status, heartbeat["status"]])
    return {
        "enabled": True,
        "status": overall,
        "connection": connection,
        "heartbeat": heartbeat,
    }


@router.get("/weather_cache")
async def health_weather_cache() -> Dict[str, object]:
    cache_dir = Path(settings.hrrr_cache_dir)
    stats = await asyncio.to_thread(
        weather_cache.scan_solar_history_store,
        Path(settings.hrrr_solar_history_db),
        float(settings.hrrr_solar_retention_hours),
    )
    active_location = await hrrr_weather_service.get_active_location()
    now = _utc_now()
    latest = stats["newest_valid_time"]
    age_seconds = (now - latest).total_seconds() if latest else None

    if stats["row_count"] == 0:
        status = "ok"
        state = "empty"
        age_seconds = None
    elif age_seconds is None:
        status = "unknown"
        state = None
    elif age_seconds >= HRRR_STALE_CRITICAL_SECONDS:
        status = "critical"
        state = None
    elif age_seconds >= HRRR_STALE_WARN_SECONDS:
        status = "warning"
        state = None
    else:
        status = "ok"
        state = None

    context = {
        "cache_dir": str(cache_dir),
        "db_path": stats["db_path"],
        "row_count": stats["row_count"],
        "bytes": stats["size_bytes"],
        "latest_valid_time": _isoformat(latest),
        "location_source": active_location.source if active_location is not None else None,
        "location_lat": active_location.lat if active_location is not None else None,
        "location_lon": active_location.lon if active_location is not None else None,
    }

    if status == "critical":
        await alerts_service.transition(
            key="hrrr.solar_history",
            healthy=False,
            event_type="hrrr.solar_history_stale",
            severity="critical",
            message="HRRR solar history stale beyond 6 hours",
            detail=None,
            context=context,
            recovery_message="HRRR solar history refreshed",
            notify=True,
            recovery_notify=False,
        )
    elif status == "ok":
        await alerts_service.transition(
            key="hrrr.solar_history",
            healthy=True,
            event_type="hrrr.solar_history_stale",
            severity="critical",
            message="HRRR solar history stale beyond 6 hours",
            detail=None,
            context=context,
            recovery_message="HRRR solar history refreshed",
            notify=True,
            recovery_notify=False,
        )
    elif status == "warning":
        await alerts_service.emit(
            "hrrr.solar_history_warn",
            severity="warning",
            message="HRRR solar history older than 3 hours",
            detail=None,
            context=context,
            notify=False,
        )

    payload = {
        "status": status,
        "cache_dir": str(cache_dir),
        "file_count": stats["row_count"],
        "bytes": stats["size_bytes"],
        "latest_modified": _isoformat(latest),
        "oldest_modified": _isoformat(stats["oldest_valid_time"]),
        "age_seconds": age_seconds,
        "state": state,
        "db_path": stats["db_path"],
        "row_count": stats["row_count"],
        "retention_hours": stats["retention_hours"],
        "newest_valid_time": _isoformat(stats["newest_valid_time"]),
        "oldest_valid_time": _isoformat(stats["oldest_valid_time"]),
        "active_location": {
            "lat": active_location.lat,
            "lon": active_location.lon,
        } if active_location is not None else None,
        "location_source": active_location.source if active_location is not None else None,
        "location_observed_at": _isoformat(active_location.observed_at) if active_location is not None else None,
        "location_updated_at": _isoformat(active_location.updated_at) if active_location is not None else None,
    }
    return payload


@router.get("/weather_cache/entries", response_model=CacheEntriesResponse)
async def list_weather_cache_entries(
    limit: int = Query(100, ge=10, le=2000, description="Maximum number of entries to return."),
    order: str = Query(
        "newest",
        description="Ordering applied to the listing (newest, oldest, largest, smallest).",
    ),
    kind: List[str] | None = Query(
        default=None,
        description="Optional list of file kinds to include (grib, metadata, log, other).",
    ),
) -> CacheEntriesResponse:
    normalized_order = order.lower()
    if normalized_order not in weather_cache.CACHE_ENTRY_ORDERS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported order value: {order}",
        )
    try:
        kind_filter = weather_cache.normalize_kind_filter(kind)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    cache_dir = Path(settings.hrrr_cache_dir)
    payload = await asyncio.to_thread(
        weather_cache.collect_cache_entries,
        cache_dir,
        limit=limit,
        order=normalized_order,
        kinds=kind_filter,
        create=False,
    )
    return CacheEntriesResponse(
        cache_dir=str(cache_dir),
        total_files=payload["file_count"],
        total_bytes=payload["total_bytes"],
        order=normalized_order,
        limit=limit,
        entries=payload["entries"],
    )


@router.post(
    "/weather_cache/delete",
    response_model=CacheDeletionResponse,
    status_code=status.HTTP_200_OK,
)
async def delete_weather_cache_entries(request: CacheMutationRequest) -> CacheDeletionResponse:
    cache_dir = Path(settings.hrrr_cache_dir)
    result = await asyncio.to_thread(
        weather_cache.delete_cache_entries,
        cache_dir,
        request.entries,
        request.include_metadata,
        count_metadata_processed=False,
    )
    return CacheDeletionResponse(**result)


@router.post(
    "/weather_cache/store",
    response_model=CacheStoreResponse,
    status_code=status.HTTP_200_OK,
)
async def store_weather_cache_entries(request: CacheStoreRequest) -> CacheStoreResponse:
    cache_dir = Path(settings.hrrr_cache_dir)
    archive_dir = Path(settings.hrrr_archive_dir)
    result = await asyncio.to_thread(
        weather_cache.store_cache_entries,
        cache_dir,
        archive_dir,
        request.entries,
        request.include_metadata,
        request.label,
        count_metadata_processed=False,
    )
    return CacheStoreResponse(**result)


@router.get("/storage")
async def health_storage() -> Dict[str, object]:
    target = Path(settings.hrrr_cache_dir)
    if not target.exists():
        target = target.parent if target.parent.exists() else Path(os.getcwd())
    usage = await asyncio.to_thread(_disk_usage, target)
    free_percent = 100.0 - usage["used_percent"]
    if free_percent < 10.0:
        status = "critical"
    elif free_percent < 20.0:
        status = "warning"
    else:
        status = "ok"
    return {
        "status": status,
        "path_checked": str(target),
        "total_bytes": usage["total_bytes"],
        "used_bytes": usage["used_bytes"],
        "free_bytes": usage["free_bytes"],
        "used_percent": usage["used_percent"],
        "free_percent": free_percent,
    }


@router.get("/events")
async def list_alert_events(
    limit: int = Query(50, ge=1, le=500),
    severity: str | None = Query(default=None),
    event_type: List[str] | None = Query(default=None),
) -> Dict[str, object]:
    events = await alerts_service.list_events(limit=limit, severity=severity, event_types=event_type)
    return {
        "count": len(events),
        "events": events,
    }


def _uptime_payload(request: Request) -> Dict[str, object]:
    started_at: Optional[datetime] = getattr(request.app.state, "started_at", None)
    if started_at is None:
        return {"started_at": None, "seconds": None}
    now = _utc_now()
    seconds = (now - started_at).total_seconds()
    return {"started_at": _isoformat(started_at), "seconds": seconds}


async def _check_database() -> Dict[str, object]:
    db_path = Path(settings.pot_telemetry_db)
    exists = db_path.exists()
    size_bytes = db_path.stat().st_size if exists else None
    start = time.perf_counter()
    if not exists:
        return {
            "status": "warning",
            "path": str(db_path),
            "exists": False,
            "size_bytes": None,
            "latency_ms": None,
            "error": "Database file not found.",
        }
    try:
        await asyncio.to_thread(_ping_sqlite, db_path)
        status = "ok"
        error = None
    except Exception as exc:
        status = "critical"
        error = str(exc)
    duration_ms = (time.perf_counter() - start) * 1000.0
    return {
        "status": status,
        "path": str(db_path),
        "exists": exists,
        "size_bytes": size_bytes,
        "latency_ms": round(duration_ms, 2),
        "error": error,
    }


def _ping_sqlite(db_path: Path) -> None:
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=1.0)
    try:
        conn.execute("SELECT 1;")
    finally:
        conn.close()


async def _gather_heartbeat(now: datetime) -> Dict[str, object]:
    snapshots = pump_status_cache.list()
    manual_entries = device_registry.list_entries()
    manual_ids = {entry.pot_id for entry in manual_entries}

    latest_by_pot: Dict[str, tuple[datetime, object]] = {}
    for snapshot in snapshots:
        received_dt = _parse_iso(snapshot.received_at)
        if received_dt is None:
            continue
        pot_id = normalize_pot_id(snapshot.pot_id) or snapshot.pot_id
        existing = latest_by_pot.get(pot_id)
        if existing is None or received_dt > existing[0]:
            latest_by_pot[pot_id] = (received_dt, snapshot)

    entries: List[Dict[str, object]] = []
    worst_status = "ok"
    latest_seen: Optional[datetime] = None

    for pot_id, (received_dt, snapshot) in latest_by_pot.items():
        age_seconds = (now - received_dt).total_seconds()
        if age_seconds >= HEARTBEAT_CRITICAL_SECONDS:
            status = "critical"
        elif age_seconds >= HEARTBEAT_WARN_SECONDS:
            status = "warning"
        else:
            status = "ok"

        entries.append(
            {
                "pot_id": pot_id,
                "received_at": snapshot.received_at,
                "age_seconds": age_seconds,
                "status": status,
                "pump_on": snapshot.pump_on,
                "fan_on": snapshot.fan_on,
                "mister_on": snapshot.mister_on,
                "light_on": snapshot.light_on,
                "deviceName": snapshot.device_name,
                "isNamed": snapshot.is_named,
                "manual": pot_id in manual_ids,
            }
        )

        if latest_seen is None or received_dt > latest_seen:
            latest_seen = received_dt

        if _status_rank(status) > _status_rank(worst_status):
            worst_status = status

        await _update_heartbeat_alert(pot_id, status, age_seconds, snapshot.received_at)

    for entry in manual_entries:
        if entry.pot_id in latest_by_pot:
            continue
        entries.append(
            {
                "pot_id": entry.pot_id,
                "received_at": None,
                "age_seconds": None,
                "status": "unknown",
                "pump_on": None,
                "fan_on": None,
                "mister_on": None,
                "light_on": None,
                "deviceName": None,
                "isNamed": None,
                "manual": True,
            }
        )

    entries.sort(key=lambda entry: entry["pot_id"])

    return {
        "status": worst_status if latest_by_pot else "unknown",
        "count": len(latest_by_pot),
        "pots": entries,
        "latest_received_at": _isoformat(latest_seen),
    }


async def _update_heartbeat_alert(pot_id: str, status: str, age_seconds: float, received_at: str) -> None:
    context = {
        "pot_id": pot_id,
        "age_seconds": age_seconds,
        "received_at": received_at,
    }
    key = f"heartbeat:{pot_id.lower()}"
    if status == "critical":
        await alerts_service.transition(
            key=key,
            healthy=False,
            event_type="heartbeat.missed",
            severity="critical",
            message=f"No heartbeat from {pot_id} in {int(age_seconds)} seconds",
            detail=None,
            context=context,
            recovery_message=f"Heartbeat restored for {pot_id}",
            notify=True,
            recovery_notify=False,
        )
    elif status == "ok":
        await alerts_service.transition(
            key=key,
            healthy=True,
            event_type="heartbeat.missed",
            severity="critical",
            message=f"No heartbeat from {pot_id}",
            detail=None,
            context=context,
            recovery_message=f"Heartbeat restored for {pot_id}",
            notify=True,
            recovery_notify=False,
        )
    elif status == "warning":
        await alerts_service.emit(
            "heartbeat.warning",
            severity="warning",
            message=f"Heartbeat latency for {pot_id} is {int(age_seconds)} seconds",
            detail=None,
            context=context,
            notify=False,
        )



def _disk_usage(path: Path) -> Dict[str, float]:
    usage = shutil.disk_usage(path)
    total = float(usage.total)
    used = float(usage.used)
    free = float(usage.free)
    used_percent = (used / total) * 100.0 if total > 0 else 0.0
    return {
        "path": str(path),
        "total_bytes": int(total),
        "used_bytes": int(used),
        "free_bytes": int(free),
        "used_percent": used_percent,
    }


__all__ = ["router"]
