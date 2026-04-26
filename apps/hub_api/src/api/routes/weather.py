from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import settings
from services.weather import (
    ALLOWED_WINDOWS,
    HrrrDisabledError,
    WeatherProviderError,
    WeatherProviderTimeout,
    WeatherUnavailable,
    weather_service,
)
from services.weather.service import SOLAR_W_TO_MJ
from services.weather_hrrr import HrrrDataUnavailable, HrrrDependencyError

router = APIRouter(prefix="/weather", tags=["weather"])
hrrr_weather_service = weather_service.hrrr_service


def validate_lat(lat: float = Query(..., ge=-90.0, le=90.0)) -> float:
    return lat


def validate_lon(lon: float = Query(..., ge=-180.0, le=180.0)) -> float:
    return lon


def validate_hours(hours: float = Query(6.0, description="Lookback window in hours")) -> float:
    if hours not in ALLOWED_WINDOWS:
        raise HTTPException(status_code=400, detail="Unsupported hours window")
    return hours


class WeatherTelemetry(BaseModel):
    timestamp: str | None = None
    station: str | None = None
    temperature_c: float | None = Field(default=None, description="Ambient temperature in degC")
    temperature_max_c: float | None = Field(default=None, description="Hourly maximum temperature in degC (NASA POWER)")
    temperature_min_c: float | None = Field(default=None, description="Hourly minimum temperature in degC (NASA POWER)")
    dewpoint_c: float | None = Field(default=None, description="Dew point temperature in degC")
    humidity_pct: float | None = Field(default=None, description="Relative humidity %")
    specific_humidity_g_kg: float | None = Field(default=None, description="Specific humidity in g/kg derived from NASA POWER")
    pressure_hpa: float | None = Field(default=None, description="Barometric pressure in hPa")
    pressure_kpa: float | None = Field(default=None, description="Barometric pressure in kPa (NASA POWER)")
    solar_radiation_mj_m2_h: float | None = Field(default=None, description="Shortwave solar radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_clear_mj_m2_h: float | None = Field(default=None, description="Clear sky shortwave radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_diffuse_mj_m2_h: float | None = Field(default=None, description="Diffuse shortwave radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_direct_mj_m2_h: float | None = Field(default=None, description="Direct shortwave radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_w_m2: float | None = Field(default=None, description="Solar radiation in W/m^2")
    wind_speed_m_s: float | None = Field(default=None, description="Wind speed in m/s at observation height")
    precip_mm_h: float | None = Field(default=None, description="Precipitation rate in mm/h (NASA POWER)")
    source: str | None = Field(default=None, description="Comma-delimited data sources contributing to this record")


class WeatherStation(BaseModel):
    id: str | None = None
    name: str | None = None
    identifier: str | None = None
    lat: float | None = None
    lon: float | None = None
    distance_km: float | None = Field(default=None, description="Distance from requested location in kilometers")


class WeatherResponse(BaseModel):
    location: dict[str, float]
    requested_hours: float
    coverage_hours: float
    available_windows: list[float]
    data: list[WeatherTelemetry]
    station: WeatherStation | None = None
    sources: list[str] = Field(default_factory=list, description="Unique data providers contributing to this series")
    blend_mode: Literal["station", "station_hrrr_solar", "hrrr"] = Field(
        default="station",
        description="How the response was assembled from station and HRRR sources.",
    )
    hrrr_used: bool = Field(default=False, description="True when HRRR contributed data to the response")
    hrrr_error: str | None = Field(
        default=None,
        description="Reason HRRR data is unavailable when falling back to station-based observations",
    )


class HrrrRunInfo(BaseModel):
    cycle: str
    forecast_hour: int
    valid_time: str


class HrrrFields(BaseModel):
    temperature_c: float | None = None
    humidity_pct: float | None = None
    wind_speed_m_s: float | None = None
    pressure_hpa: float | None = None
    solar_radiation_w_m2: float | None = None
    solar_radiation_mj_m2_h: float | None = None
    solar_radiation_diffuse_w_m2: float | None = None
    solar_radiation_diffuse_mj_m2_h: float | None = None
    solar_radiation_direct_w_m2: float | None = None
    solar_radiation_direct_mj_m2_h: float | None = None
    solar_radiation_clear_w_m2: float | None = None
    solar_radiation_clear_mj_m2_h: float | None = None
    solar_radiation_clear_up_w_m2: float | None = None
    solar_radiation_clear_up_mj_m2_h: float | None = None


class HrrrSnapshot(BaseModel):
    location: dict[str, float]
    run: HrrrRunInfo
    fields: HrrrFields
    source: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    persisted: bool | None = Field(default=None, description="Indicates whether the refresh persisted to telemetry")


class HrrrFetchStatusModel(BaseModel):
    timestamp: str
    lat: float
    lon: float
    run_cycle: str | None = None
    forecast_hour: int | None = None
    valid_time: str | None = None
    status: str
    detail: str | None = None
    persisted: bool | None = None
    duration_s: float | None = Field(default=None, ge=0.0)


class HrrrStatusResponse(BaseModel):
    enabled: bool
    scheduler_running: bool
    refresh_interval_minutes: float | None
    selected_refresh_minutes: float | None = Field(default=None, description="Currently selected scheduler preset in minutes")
    refresh_options: list[float] = Field(default_factory=list)
    default_location: dict[str, float] | None
    location_source: str | None = None
    location_observed_at: str | None = None
    location_updated_at: str | None = None
    last_refresh: str | None
    last_valid_time: str | None
    cache_dir: str
    domain: str
    cached_points: int = 0
    fetch_log_path: str | None = None
    solar_history_db: str
    solar_history_bytes: int = 0
    solar_history_rows: int = 0
    solar_retention_hours: float
    solar_oldest_valid_time: str | None = None
    solar_newest_valid_time: str | None = None
    latest_sample: HrrrSnapshot | None = None
    recent_fetches: list[HrrrFetchStatusModel] = Field(default_factory=list)


class HrrrScheduleRequest(BaseModel):
    interval_minutes: Literal[15, 60] = Field(
        ...,
        description="Refresh cadence for the HRRR scheduler in minutes (allowed: 15 or 60)",
    )


class WeatherLocationUpsertRequest(BaseModel):
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    accuracy_m: float | None = Field(default=None, ge=0.0)
    source: str = Field(default="browser_geolocation", min_length=1, max_length=64)
    observed_at: datetime | None = Field(default=None)


class WeatherLocationResponse(BaseModel):
    lat: float
    lon: float
    accuracy_m: float | None = None
    source: str
    observed_at: str | None = None
    updated_at: str


class HrrrHealthResponse(BaseModel):
    ok: bool
    enabled: bool
    scheduler_running: bool
    stale: bool
    stale_threshold_minutes: float
    last_refresh: str | None
    last_valid_time: str | None
    message: str
    solar_history_rows: int = 0
    solar_retention_hours: float = 0.0
    solar_oldest_valid_time: str | None = None
    solar_newest_valid_time: str | None = None
    recent_fetch: HrrrFetchStatusModel | None = None


class CacheEntryModel(BaseModel):
    path: str = Field(description="Path relative to the HRRR cache directory.")
    bytes: int = Field(ge=0, description="Size of the file in bytes.")
    modified: str = Field(description="Last modification time (ISO-8601).")
    kind: Literal["grib", "metadata", "log", "other"]
    cycle: str | None = Field(default=None, description="Cycle timestamp parsed from the filename.")
    forecast_hour: int | None = None
    valid_time: str | None = Field(default=None, description="Derived valid timestamp when available.")
    domain: str | None = Field(default=None, description="Domain portion inferred from the cache path.")
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
    entries: list[str] = Field(min_length=1, description="Relative file paths within the HRRR cache.")
    include_metadata: bool = Field(
        default=True,
        description="Also act on associated .grib2.json metadata files when touching GRIB assets.",
    )


class CacheStoreRequest(CacheMutationRequest):
    label: str | None = Field(
        default=None,
        max_length=64,
        description="Optional label appended to the archive folder name when storing files.",
    )


@router.get("/local", response_model=WeatherResponse)
async def get_local_weather(
    lat: float = Depends(validate_lat),
    lon: float = Depends(validate_lon),
    hours: float = Depends(validate_hours),
):
    try:
        return WeatherResponse(**await weather_service.get_local_weather(lat, lon, hours))
    except WeatherProviderTimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except WeatherProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except WeatherUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/location", response_model=WeatherLocationResponse)
async def get_active_weather_location():
    location = await weather_service.get_active_location_payload()
    if location is None:
        raise HTTPException(status_code=404, detail="No active weather location is configured")
    return WeatherLocationResponse(**location)


@router.put("/location", response_model=WeatherLocationResponse)
async def upsert_active_weather_location(payload: WeatherLocationUpsertRequest):
    try:
        location = await weather_service.set_active_location_payload(
            lat=payload.lat,
            lon=payload.lon,
            accuracy_m=payload.accuracy_m,
            source=payload.source,
            observed_at=payload.observed_at,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return WeatherLocationResponse(**location)


@router.get("/hrrr/status", response_model=HrrrStatusResponse)
async def get_hrrr_status(history: int = Query(10, ge=1, le=200)):
    return HrrrStatusResponse(**await weather_service.get_hrrr_status_payload(history_limit=history))


@router.post("/hrrr/schedule", response_model=HrrrStatusResponse)
async def update_hrrr_schedule(payload: HrrrScheduleRequest):
    try:
        return HrrrStatusResponse(**await weather_service.select_hrrr_schedule(float(payload.interval_minutes)))
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/hrrr/fetch-log", response_model=list[HrrrFetchStatusModel])
async def get_hrrr_fetch_log(limit: int = Query(20, ge=1, le=200)):
    try:
        return [HrrrFetchStatusModel(**entry) for entry in await weather_service.get_hrrr_fetch_log_payload(limit=limit)]
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/hrrr/health", response_model=HrrrHealthResponse)
async def get_hrrr_health():
    try:
        return HrrrHealthResponse(**await weather_service.get_hrrr_health_payload())
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/hrrr/cache", response_model=CacheEntriesResponse)
async def inspect_hrrr_cache(
    order: Literal["newest", "oldest", "largest", "smallest"] = Query("newest"),
    limit: int = Query(100, ge=1, le=500),
):
    try:
        return CacheEntriesResponse(**await weather_service.inspect_cache_payload(order=order, limit=limit))
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/hrrr/cache/delete", response_model=CacheDeletionResponse)
async def delete_hrrr_cache_entries(payload: CacheMutationRequest):
    try:
        return CacheDeletionResponse(
            **await weather_service.delete_cache_payload(
                entries=payload.entries,
                include_metadata=payload.include_metadata,
            )
        )
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/hrrr/cache/store", response_model=CacheStoreResponse)
async def store_hrrr_cache_entries(payload: CacheStoreRequest):
    try:
        return CacheStoreResponse(
            **await weather_service.store_cache_payload(
                entries=payload.entries,
                include_metadata=payload.include_metadata,
                label=payload.label,
            )
        )
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/hrrr/point", response_model=HrrrSnapshot)
async def get_hrrr_point(
    lat: float = Depends(validate_lat),
    lon: float = Depends(validate_lon),
    refresh: bool = Query(True, description="Force downloading the latest HRRR run for the point"),
    persist: bool = Query(True, description="Persist the refreshed sample into the telemetry store"),
):
    try:
        return HrrrSnapshot(
            **await weather_service.get_hrrr_point_payload(
                lat,
                lon,
                refresh=refresh,
                persist=persist,
            )
        )
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except HrrrDependencyError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except HrrrDataUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive logging
        raise HTTPException(status_code=502, detail=f"Failed to refresh HRRR data: {exc}") from exc


@router.post("/hrrr/refresh", response_model=HrrrSnapshot)
async def refresh_hrrr_point(
    lat: float | None = Query(default=None, ge=-90.0, le=90.0),
    lon: float | None = Query(default=None, ge=-180.0, le=180.0),
    persist: bool = Query(True, description="Persist the refreshed sample into the telemetry store"),
):
    try:
        return HrrrSnapshot(
            **await weather_service.refresh_hrrr_point_payload(
                lat=lat,
                lon=lon,
                persist=persist,
            )
        )
    except HrrrDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HrrrDependencyError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except HrrrDataUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive logging
        raise HTTPException(status_code=502, detail=f"Failed to refresh HRRR data: {exc}") from exc


__all__ = [
    "ALLOWED_WINDOWS",
    "SOLAR_W_TO_MJ",
    "hrrr_weather_service",
    "router",
    "settings",
    "weather_service",
]
