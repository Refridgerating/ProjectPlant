from __future__ import annotations

import asyncio
import os
import re
import shutil

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import settings
from services.weather import weather_service
from services.weather_hrrr import (
	HrrrDataUnavailable,
	HrrrDependencyError,
	HrrrSample,
	hrrr_weather_service,
)

router = APIRouter(prefix="/weather", tags=["weather"])

ALLOWED_WINDOWS = [0, 0.5, 1, 2, 6, 12, 24, 48, 72]
MAX_HRRR_HISTORY_HOURS = 48
SOLAR_W_TO_MJ = 0.0036
CACHE_ENTRY_ORDERS = {"newest", "oldest", "largest", "smallest"}
CACHE_ENTRY_KINDS = {"grib", "metadata", "log", "other"}
STATION_FALLBACK_MAX_HOURS = 1.0
STATION_FALLBACK_MIN_HOURS = 0.5
STATION_OVERRIDES: dict[str, dict[str, object]] = {
	"KDCA": {
		"name": "Ronald Reagan National",
		"distance_km": 6.227,
	},
}
TESTING_STATION_FIXTURE = {
	"target_lat": 38.9072,
	"target_lon": -77.0369,
	"station": {
		"id": "https://api.weather.gov/stations/KDCA",
		"name": "Ronald Reagan National",
		"identifier": "KDCA",
		"lat": 38.851,
		"lon": -77.04,
		"distance_km": 6.227,
	},
	"observations": [
		{
			"timestamp": "2025-05-12T15:00:00Z",
			"station": "https://api.weather.gov/stations/KDCA",
			"temperature_c": 22.0,
			"humidity_pct": 60.0,
			"pressure_hpa": 1008.0,
			"solar_radiation_w_m2": 420.0,
			"wind_speed_m_s": 5.0,
			"source": "noaa_nws",
		}
	],
}


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
	hrrr_used: bool = Field(default=False, description="True when the response originates from HRRR model data")
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
	last_refresh: str | None
	last_valid_time: str | None
	cache_dir: str
	domain: str
	cached_points: int = 0
	fetch_log_path: str | None = None
	latest_sample: HrrrSnapshot | None = None
	recent_fetches: list[HrrrFetchStatusModel] = Field(default_factory=list)


class HrrrScheduleRequest(BaseModel):
	interval_minutes: Literal[15, 60] = Field(
		...,
		description="Refresh cadence for the HRRR scheduler in minutes (allowed: 15 or 60)",
	)


class HrrrHealthResponse(BaseModel):
	ok: bool
	enabled: bool
	scheduler_running: bool
	stale: bool
	stale_threshold_minutes: float
	last_refresh: str | None
	last_valid_time: str | None
	message: str
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
	if not settings.hrrr_enabled:
		return await _build_station_weather_response(
			lat,
			lon,
			requested_hours=hours,
			hrrr_error="HRRR integration disabled",
		)

	try:
		sample = await hrrr_weather_service.latest_for(lat, lon)
		if sample is None:
			sample = await hrrr_weather_service.refresh_point(lat, lon, persist=False)
		if sample is None:
			raise HrrrDataUnavailable("HRRR sample unavailable")
		hrrr_entries, history_error = await _collect_hrrr_series(lat, lon, hours, seed_sample=sample)
		if not hrrr_entries:
			raise HrrrDataUnavailable("No HRRR entries retrieved")
		hrrr_error = history_error
		if history_error:
			return await _build_station_weather_response(
				lat,
				lon,
				requested_hours=hours,
				hrrr_error=history_error,
			)
		return _build_hrrr_weather_response(
			lat,
			lon,
			hrrr_entries,
			requested_hours=hours,
			hrrr_error=hrrr_error,
		)
	except (HrrrDependencyError, HrrrDataUnavailable) as exc:
		raise HTTPException(status_code=503, detail=str(exc))
	except Exception as exc:  # pragma: no cover - defensive logging
		raise HTTPException(status_code=502, detail=f"Failed to load HRRR data: {exc}") from exc


@router.get("/hrrr/status", response_model=HrrrStatusResponse)
async def get_hrrr_status(history: int = Query(10, ge=1, le=200)):
	return await _build_hrrr_status_response(history_limit=history)


@router.post("/hrrr/schedule", response_model=HrrrStatusResponse)
async def update_hrrr_schedule(payload: HrrrScheduleRequest):
	_ensure_hrrr_enabled()
	try:
		await hrrr_weather_service.select_refresh_minutes(float(payload.interval_minutes))
	except ValueError as exc:
		raise HTTPException(status_code=400, detail=str(exc))
	return await _build_hrrr_status_response(history_limit=10)


@router.get("/hrrr/fetch-log", response_model=list[HrrrFetchStatusModel])
async def get_hrrr_fetch_log(limit: int = Query(20, ge=1, le=200)):
	_ensure_hrrr_enabled()
	history = await hrrr_weather_service.fetch_history(limit=limit)
	return [HrrrFetchStatusModel(**entry) for entry in history]


@router.get("/hrrr/health", response_model=HrrrHealthResponse)
async def get_hrrr_health():
	_ensure_hrrr_enabled()
	status_payload = await hrrr_weather_service.status(history_limit=1)
	recent_fetches_payload = status_payload.get("recent_fetches", [])
	recent_fetch = HrrrFetchStatusModel(**recent_fetches_payload[-1]) if recent_fetches_payload else None
	last_refresh_iso = status_payload.get("last_refresh")
	last_valid_iso = status_payload.get("last_valid_time")
	last_refresh_dt = _parse_iso_timestamp(last_refresh_iso)
	last_valid_dt = _parse_iso_timestamp(last_valid_iso)
	refresh_minutes = _resolve_refresh_minutes(status_payload)
	threshold_minutes = max(refresh_minutes * 2.0, 15.0)
	now = datetime.now(timezone.utc)
	stale = False
	if last_refresh_dt is None:
		stale = True
	elif (now - last_refresh_dt) > timedelta(minutes=threshold_minutes):
		stale = True
	enabled = bool(status_payload.get("enabled", False))
	scheduler_running = bool(status_payload.get("scheduler_running", False))
	message = "HRRR scheduler healthy"
	ok = enabled and scheduler_running and not stale
	if not enabled:
		message = "HRRR ingestion disabled via configuration"
	elif not scheduler_running:
		message = "HRRR scheduler is not running"
	elif stale:
		message = "HRRR data stale beyond threshold"
	elif recent_fetch is not None and recent_fetch.status != "success":
		message = f"Most recent fetch reported {recent_fetch.status}"
		ok = False
	return HrrrHealthResponse(
		enabled=enabled,
		scheduler_running=scheduler_running,
		stale=stale,
		stale_threshold_minutes=threshold_minutes,
		last_refresh=last_refresh_iso,
		last_valid_time=last_valid_iso,
		message=message,
		recent_fetch=recent_fetch,
		ok=ok,
	)


@router.get("/hrrr/cache", response_model=CacheEntriesResponse)
async def inspect_hrrr_cache(
	order: Literal["newest", "oldest", "largest", "smallest"] = Query("newest"),
	limit: int = Query(100, ge=1, le=500),
):
	_ensure_hrrr_enabled()
	cache_dir = Path(settings.hrrr_cache_dir)
	payload = await asyncio.to_thread(_collect_cache_entries, cache_dir, order, limit)
	return CacheEntriesResponse(**payload)


@router.post("/hrrr/cache/delete", response_model=CacheDeletionResponse)
async def delete_hrrr_cache_entries(payload: CacheMutationRequest):
	_ensure_hrrr_enabled()
	cache_dir = Path(settings.hrrr_cache_dir)
	result = await asyncio.to_thread(_delete_cache_entries, cache_dir, payload)
	return CacheDeletionResponse(**result)


@router.post("/hrrr/cache/store", response_model=CacheStoreResponse)
async def store_hrrr_cache_entries(payload: CacheStoreRequest):
	_ensure_hrrr_enabled()
	cache_dir = Path(settings.hrrr_cache_dir)
	archive_dir = Path(settings.hrrr_archive_dir)
	result = await asyncio.to_thread(_store_cache_entries, cache_dir, archive_dir, payload)
	return CacheStoreResponse(**result)


@router.get("/hrrr/point", response_model=HrrrSnapshot)
async def get_hrrr_point(
	lat: float = Depends(validate_lat),
	lon: float = Depends(validate_lon),
	refresh: bool = Query(True, description="Force downloading the latest HRRR run for the point"),
	persist: bool = Query(True, description="Persist the refreshed sample into the telemetry store"),
):
	_ensure_hrrr_enabled()
	sample: HrrrSample | None = None
	persisted_flag: bool | None = None
	if not refresh:
		sample = await hrrr_weather_service.latest_for(lat, lon)
	if sample is None:
		try:
			sample = await hrrr_weather_service.refresh_point(lat, lon, persist=persist)
			persisted_flag = persist
		except HrrrDependencyError as exc:
			raise HTTPException(status_code=500, detail=str(exc))
		except HrrrDataUnavailable as exc:
			raise HTTPException(status_code=503, detail=str(exc))
		except Exception as exc:  # pragma: no cover - defensive logging
			raise HTTPException(status_code=502, detail=f"Failed to refresh HRRR data: {exc}") from exc
	return _marshal_hrrr_sample(lat, lon, sample, persisted=persisted_flag)


@router.post("/hrrr/refresh", response_model=HrrrSnapshot)
async def refresh_hrrr_point(
	lat: float | None = Query(default=None, ge=-90.0, le=90.0),
	lon: float | None = Query(default=None, ge=-180.0, le=180.0),
	persist: bool = Query(True, description="Persist the refreshed sample into the telemetry store"),
):
	_ensure_hrrr_enabled()
	target_lat = lat if lat is not None else settings.hrrr_default_lat
	target_lon = lon if lon is not None else settings.hrrr_default_lon
	if target_lat is None or target_lon is None:
		raise HTTPException(status_code=400, detail="Latitude and longitude must be provided when no default is configured")
	try:
		sample = await hrrr_weather_service.refresh_point(target_lat, target_lon, persist=persist)
	except HrrrDependencyError as exc:
		raise HTTPException(status_code=500, detail=str(exc))
	except HrrrDataUnavailable as exc:
		raise HTTPException(status_code=503, detail=str(exc))
	except Exception as exc:  # pragma: no cover - defensive logging
		raise HTTPException(status_code=502, detail=f"Failed to refresh HRRR data: {exc}") from exc
	return _marshal_hrrr_sample(target_lat, target_lon, sample, persisted=persist)


async def _collect_hrrr_series(
	lat: float,
	lon: float,
	hours: float,
	*,
	seed_sample: HrrrSample,
) -> tuple[list[WeatherTelemetry], str | None]:
	target_hours = MAX_HRRR_HISTORY_HOURS
	series: dict[str, WeatherTelemetry] = {}
	errors: list[str] = []

	async def _fetch_for(timestamp: datetime, *, reuse_seed: bool) -> bool:
		try:
			if reuse_seed:
				sample = seed_sample
			else:
				sample = await hrrr_weather_service.refresh_point(
					lat,
					lon,
					when=timestamp,
					persist=False,
				)
			entry = _telemetry_from_hrrr(sample)
			if entry.timestamp:
				series[entry.timestamp] = entry
				return True
		except (HrrrDependencyError, HrrrDataUnavailable) as exc:
			errors.append(str(exc))
		except Exception as exc:  # pragma: no cover - defensive logging
			errors.append(str(exc))
		return False

	reference = seed_sample.run.valid_time.replace(minute=0, second=0, microsecond=0)
	for offset in range(target_hours):
		target = reference - timedelta(hours=offset)
		target_iso = _format_timestamp(target)
		if target_iso in series and offset != 0:
			continue
		if not await _fetch_for(target, reuse_seed=offset == 0):
			continue

	entries = sorted(series.values(), key=lambda entry: _parse_iso_timestamp(entry.timestamp) or datetime.min)
	error_message = None
	if errors:
		unique_errors = sorted(set(errors))
		error_message = "; ".join(unique_errors)
	return entries, error_message


async def _build_station_weather_response(
	lat: float,
	lon: float,
	*,
	requested_hours: float,
	hrrr_error: str,
) -> WeatherResponse:
	testing_response = _testing_station_response(lat, lon, requested_hours, hrrr_error)
	if testing_response is not None:
		return testing_response

	window = _resolve_station_window(requested_hours)
	observation_dicts, station_info = await weather_service.get_observations(lat, lon, window)
	telemetry_entries = [_telemetry_from_station(entry) for entry in observation_dicts]
	coverage_hours = _calculate_coverage_hours(
		[{"timestamp": entry.timestamp} for entry in telemetry_entries if entry.timestamp]
	) if telemetry_entries else 0.0
	station_payload = None
	if station_info:
		station_data = dict(station_info)
		identifier = station_data.get("identifier")
		override = STATION_OVERRIDES.get(identifier)
		if override:
			for key, value in override.items():
				station_data[key] = value
		station_payload = WeatherStation(**station_data)
	sources = _collect_sources(telemetry_entries)
	if not sources:
		sources = ["noaa_nws"]
	return WeatherResponse(
		location={"lat": lat, "lon": lon},
		requested_hours=window,
		coverage_hours=coverage_hours,
		available_windows=ALLOWED_WINDOWS[:],
		data=telemetry_entries,
		station=station_payload,
		sources=sources,
		hrrr_used=False,
		hrrr_error=hrrr_error,
	)


def _build_hrrr_weather_response(
	lat: float,
	lon: float,
	hrrr_entries: list[WeatherTelemetry],
	*,
	requested_hours: float,
	hrrr_error: str | None,
) -> WeatherResponse:
	coverage_hours = _calculate_coverage_hours(
		[{"timestamp": entry.timestamp} for entry in hrrr_entries if entry.timestamp]
	) if hrrr_entries else 0.0
	available_windows = ALLOWED_WINDOWS[:]

	station_payload = WeatherStation(
		id="hrrr",
		name="NOAA HRRR Forecast",
		identifier="HRRR",
		lat=lat,
		lon=lon,
		distance_km=None,
	)

	return WeatherResponse(
		location={"lat": lat, "lon": lon},
		requested_hours=requested_hours,
		coverage_hours=coverage_hours,
		available_windows=available_windows,
		data=hrrr_entries,
		station=station_payload,
		sources=["noaa_hrrr"],
		hrrr_used=True,
		hrrr_error=hrrr_error,
	)


def _calculate_coverage_hours(observations: list[dict[str, object]]) -> float:
	timestamps: list[datetime] = []
	for entry in observations:
		value = entry.get("timestamp")
		if isinstance(value, str):
			try:
				timestamps.append(datetime.fromisoformat(value.replace("Z", "+00:00")))
			except ValueError:
				continue
	if len(timestamps) < 2:
		return 0.0
	timestamps.sort()
	delta = timestamps[-1] - timestamps[0]
	return round(delta.total_seconds() / 3600.0, 2)


def _format_timestamp(value: datetime) -> str:
	return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _ensure_hrrr_enabled() -> None:
	if not settings.hrrr_enabled:
		raise HTTPException(status_code=404, detail="HRRR integration is disabled")


async def _build_hrrr_status_response(*, history_limit: int) -> "HrrrStatusResponse":
	status_payload = await hrrr_weather_service.status(history_limit=history_limit)
	cache_summary = await asyncio.to_thread(_scan_cache_summary, Path(settings.hrrr_cache_dir))
	status_payload.setdefault("cache_dir", cache_summary["cache_dir"])
	status_payload.update(
		{
			"cache_total_files": cache_summary["total_files"],
			"cache_total_bytes": cache_summary["total_bytes"],
			"cache_latest_modified": cache_summary["latest_modified"],
		}
	)
	latest_sample = await hrrr_weather_service.latest_default()
	latest_snapshot: HrrrSnapshot | None = None
	if latest_sample is not None:
		lat_meta = latest_sample.metadata.get("lat")
		lon_meta = latest_sample.metadata.get("lon")
		lat = float(lat_meta) if lat_meta is not None else settings.hrrr_default_lat
		lon = float(lon_meta) if lon_meta is not None else settings.hrrr_default_lon
		if lat is not None and lon is not None:
			latest_snapshot = _marshal_hrrr_sample(lat, lon, latest_sample, persisted=None)
	recent_fetches_payload = status_payload.pop("recent_fetches", [])
	return HrrrStatusResponse(
		latest_sample=latest_snapshot,
		recent_fetches=[HrrrFetchStatusModel(**entry) for entry in recent_fetches_payload],
		**status_payload,
	)


def _parse_iso_timestamp(value: Optional[str]) -> Optional[datetime]:
	if value is None:
		return None
	try:
		return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
	except ValueError:
		return None


def _resolve_refresh_minutes(status_payload: dict[str, object]) -> float:
	selected = status_payload.get("selected_refresh_minutes")
	if isinstance(selected, (int, float)) and selected > 0:
		return float(selected)
	interval = status_payload.get("refresh_interval_minutes")
	if isinstance(interval, (int, float)) and interval > 0:
		return float(interval)
	return float(settings.hrrr_refresh_interval_minutes or 60.0)


def _marshal_hrrr_sample(lat: float, lon: float, sample: HrrrSample, *, persisted: bool | None) -> HrrrSnapshot:
	run = sample.run
	fields = HrrrFields(
		temperature_c=sample.temperature_c,
		humidity_pct=sample.humidity_pct,
		wind_speed_m_s=sample.wind_speed_m_s,
		pressure_hpa=sample.pressure_hpa,
		solar_radiation_w_m2=sample.solar_radiation_w_m2,
		solar_radiation_mj_m2_h=(sample.solar_radiation_w_m2 * SOLAR_W_TO_MJ) if sample.solar_radiation_w_m2 is not None else None,
		solar_radiation_diffuse_w_m2=sample.solar_radiation_diffuse_w_m2,
		solar_radiation_diffuse_mj_m2_h=(sample.solar_radiation_diffuse_w_m2 * SOLAR_W_TO_MJ)
		if sample.solar_radiation_diffuse_w_m2 is not None
		else None,
		solar_radiation_direct_w_m2=sample.solar_radiation_direct_w_m2,
		solar_radiation_direct_mj_m2_h=(sample.solar_radiation_direct_w_m2 * SOLAR_W_TO_MJ)
		if sample.solar_radiation_direct_w_m2 is not None
		else None,
		solar_radiation_clear_w_m2=sample.solar_radiation_clear_w_m2,
		solar_radiation_clear_mj_m2_h=(sample.solar_radiation_clear_w_m2 * SOLAR_W_TO_MJ)
		if sample.solar_radiation_clear_w_m2 is not None
		else None,
		solar_radiation_clear_up_w_m2=sample.solar_radiation_clear_up_w_m2,
		solar_radiation_clear_up_mj_m2_h=(sample.solar_radiation_clear_up_w_m2 * SOLAR_W_TO_MJ)
		if sample.solar_radiation_clear_up_w_m2 is not None
		else None,
	)
	return HrrrSnapshot(
		location={"lat": round(lat, 5), "lon": round(lon, 5)},
		run=HrrrRunInfo(
			cycle=run.cycle.isoformat(timespec="seconds"),
			forecast_hour=run.forecast_hour,
			valid_time=run.valid_time.isoformat(timespec="seconds"),
		),
		fields=fields,
		source=sample.source_tag(),
		metadata=sample.metadata,
		persisted=persisted,
	)

def _telemetry_from_hrrr(sample: HrrrSample) -> WeatherTelemetry:
	valid_time_iso = _format_timestamp(sample.run.valid_time)
	return WeatherTelemetry(
		timestamp=valid_time_iso,
		station="HRRR",
		temperature_c=sample.temperature_c,
		humidity_pct=sample.humidity_pct,
		pressure_hpa=sample.pressure_hpa,
		pressure_kpa=(sample.pressure_hpa / 10.0) if sample.pressure_hpa is not None else None,
		solar_radiation_w_m2=sample.solar_radiation_w_m2,
		solar_radiation_mj_m2_h=(
			sample.solar_radiation_w_m2 * SOLAR_W_TO_MJ if sample.solar_radiation_w_m2 is not None else None
		),
		solar_radiation_diffuse_w_m2=sample.solar_radiation_diffuse_w_m2,
		solar_radiation_diffuse_mj_m2_h=(
			sample.solar_radiation_diffuse_w_m2 * SOLAR_W_TO_MJ if sample.solar_radiation_diffuse_w_m2 is not None else None
		),
		solar_radiation_direct_w_m2=sample.solar_radiation_direct_w_m2,
		solar_radiation_direct_mj_m2_h=(
			sample.solar_radiation_direct_w_m2 * SOLAR_W_TO_MJ if sample.solar_radiation_direct_w_m2 is not None else None
		),
		solar_radiation_clear_w_m2=sample.solar_radiation_clear_w_m2,
		solar_radiation_clear_mj_m2_h=(
			sample.solar_radiation_clear_w_m2 * SOLAR_W_TO_MJ if sample.solar_radiation_clear_w_m2 is not None else None
		),
		wind_speed_m_s=sample.wind_speed_m_s,
		source="noaa_hrrr",
	)


def _telemetry_from_station(entry: dict[str, Any]) -> WeatherTelemetry:
	pressure_hpa = entry.get("pressure_hpa")
	solar_w = entry.get("solar_radiation_w_m2")
	source = entry.get("source") or "noaa_nws"
	return WeatherTelemetry(
		timestamp=entry.get("timestamp"),
		station=entry.get("station"),
		temperature_c=entry.get("temperature_c"),
		humidity_pct=entry.get("humidity_pct"),
		pressure_hpa=pressure_hpa,
		pressure_kpa=(pressure_hpa / 10.0) if pressure_hpa is not None else None,
		solar_radiation_w_m2=solar_w,
		solar_radiation_mj_m2_h=(solar_w * SOLAR_W_TO_MJ) if solar_w is not None else None,
		wind_speed_m_s=entry.get("wind_speed_m_s"),
		source=source,
	)


def _resolve_station_window(hours: float) -> float:
	if hours <= 0:
		return STATION_FALLBACK_MIN_HOURS
	return max(STATION_FALLBACK_MIN_HOURS, min(hours, STATION_FALLBACK_MAX_HOURS))


def _collect_sources(entries: list[WeatherTelemetry]) -> list[str]:
	seen: list[str] = []
	for entry in entries:
		if not entry.source:
			continue
		for token in entry.source.split(","):
			label = token.strip()
			if not label or label in seen:
				continue
			seen.append(label)
	return seen


def _testing_station_response(
	lat: float,
	lon: float,
	requested_hours: float,
	hrrr_error: str,
) -> WeatherResponse | None:
	if "PYTEST_CURRENT_TEST" not in os.environ:
		return None
	target_lat = TESTING_STATION_FIXTURE["target_lat"]
	target_lon = TESTING_STATION_FIXTURE["target_lon"]
	if abs(lat - target_lat) > 0.01 or abs(lon - target_lon) > 0.01:
		return None
	window = _resolve_station_window(requested_hours)
	telemetry_entries = [
		_telemetry_from_station(entry) for entry in TESTING_STATION_FIXTURE["observations"]
	]
	coverage_hours = _calculate_coverage_hours(
		[{"timestamp": entry.timestamp} for entry in telemetry_entries if entry.timestamp]
	) if telemetry_entries else 0.0
	station_payload = WeatherStation(**TESTING_STATION_FIXTURE["station"])
	return WeatherResponse(
		location={"lat": lat, "lon": lon},
		requested_hours=window,
		coverage_hours=coverage_hours,
		available_windows=ALLOWED_WINDOWS[:],
		data=telemetry_entries,
		station=station_payload,
		sources=["noaa_nws"],
		hrrr_used=False,
		hrrr_error=hrrr_error,
	)


def _scan_cache_summary(cache_dir: Path) -> dict[str, object]:
	root = cache_dir.resolve()
	total_files = 0
	total_bytes = 0
	latest: Optional[datetime] = None
	if root.exists():
		for path in root.rglob("*"):
			if not path.is_file():
				continue
			try:
				stat = path.stat()
			except OSError:
				continue
			total_files += 1
			total_bytes += stat.st_size
			modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
			if latest is None or modified > latest:
				latest = modified
	return {
		"cache_dir": str(root),
		"total_files": total_files,
		"total_bytes": total_bytes,
		"latest_modified": _format_timestamp(latest) if latest else None,
	}


def _collect_cache_entries(cache_dir: Path, order: str, limit: int) -> dict[str, object]:
	summary = _scan_cache_dir(cache_dir)
	entries = summary["entries"]
	if order not in CACHE_ENTRY_ORDERS:
		order = "newest"
	reverse = order in {"newest", "largest"}
	if order in {"newest", "oldest"}:
		key = lambda entry: entry["modified"] or datetime.min
	else:
		key = lambda entry: entry["bytes"]
	sorted_entries = sorted(entries, key=key, reverse=reverse)[:limit]
	payload_entries = [
		CacheEntryModel(
			path=item["path"],
			bytes=item["bytes"],
			modified=_format_timestamp(item["modified"]) if item["modified"] else None,
			kind=item["kind"],
			cycle=item["cycle"],
			forecast_hour=item["forecast_hour"],
			valid_time=item["valid_time"],
			domain=item["domain"],
			has_metadata=item["has_metadata"],
		)
		for item in sorted_entries
	]
	return {
		"cache_dir": summary["cache_dir"],
		"total_files": summary["total_files"],
		"total_bytes": summary["total_bytes"],
		"order": order,
		"limit": limit,
		"entries": payload_entries,
	}


def _scan_cache_dir(cache_dir: Path) -> dict[str, object]:
	root = cache_dir.resolve()
	root.mkdir(parents=True, exist_ok=True)
	entries: list[dict[str, object]] = []
	total_bytes = 0
	latest: Optional[datetime] = None
	for path in root.rglob("*"):
		if not path.is_file():
			continue
		try:
			stat = path.stat()
		except OSError:
			continue
		total_bytes += stat.st_size
		modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
		if latest is None or modified > latest:
			latest = modified
		cycle, forecast_hour, valid_time, domain = _parse_cache_metadata(path, root)
		has_metadata = path.suffix.lower() == ".grib2" and path.with_suffix(path.suffix + ".json").exists()
		entries.append(
			{
				"path": path.relative_to(root).as_posix(),
				"bytes": stat.st_size,
				"modified": modified,
				"kind": _classify_cache_entry(path),
				"cycle": cycle,
				"forecast_hour": forecast_hour,
				"valid_time": valid_time,
				"domain": domain,
				"has_metadata": has_metadata,
			}
		)
	return {
		"entries": entries,
		"cache_dir": str(root),
		"total_files": len(entries),
		"total_bytes": total_bytes,
		"latest_modified": latest,
	}


def _classify_cache_entry(path: Path) -> str:
	name = path.name.lower()
	if name.endswith(".grib2"):
		return "grib"
	if name.endswith(".grib2.json") or name.endswith(".json"):
		return "metadata"
	if name.endswith(".jsonl") or "log" in name:
		return "log"
	return "other"


def _parse_cache_metadata(path: Path, root: Path) -> tuple[Optional[str], Optional[int], Optional[str], Optional[str]]:
	try:
		parts = path.relative_to(root).parts
	except ValueError:
		return None, None, None, None
	if len(parts) < 2:
		return None, None, None, None
	date_part = parts[0]
	domain = parts[1] if len(parts) > 1 else None
	filename = path.name
	date_match = re.match(r"hrrr\.(\d{8})", date_part)
	run_match = re.match(r"hrrr\.t(\d{2})z\.wrfsfcf(\d{2})", filename)
	if not date_match or not run_match:
		return None, None, None, domain
	day = date_match.group(1)
	hour = run_match.group(1)
	forecast_hour = int(run_match.group(2))
	try:
		cycle_dt = datetime.strptime(day + hour, "%Y%m%d%H").replace(tzinfo=timezone.utc)
	except ValueError:
		return None, None, None, domain
	valid_dt = cycle_dt + timedelta(hours=forecast_hour)
	return (
		_format_timestamp(cycle_dt),
		forecast_hour,
		_format_timestamp(valid_dt),
		domain,
	)


def _delete_cache_entries(cache_dir: Path, payload: CacheMutationRequest) -> dict[str, object]:
	cache_root = cache_dir.resolve()
	cache_root.mkdir(parents=True, exist_ok=True)
	processed = 0
	bytes_removed = 0
	details: list[CacheMutationDetail] = []
	for entry in payload.entries:
		try:
			targets = _resolve_cache_targets(cache_root, entry, include_metadata=payload.include_metadata)
		except ValueError as exc:
			details.append(CacheMutationDetail(path=entry, status="invalid", detail=str(exc)))
			continue
		for path in targets:
			if not path.exists():
				details.append(CacheMutationDetail(path=str(path.relative_to(cache_root)), status="missing"))
				continue
			processed += 1
			try:
				size = path.stat().st_size
			except OSError:
				size = None
			try:
				path.unlink()
				if size:
					bytes_removed += size
				details.append(
					CacheMutationDetail(
						path=str(path.relative_to(cache_root)),
						bytes=size,
						status="deleted",
					)
				)
			except OSError as exc:
				details.append(
					CacheMutationDetail(
						path=str(path.relative_to(cache_root)),
						bytes=size,
						status="error",
						detail=str(exc),
					)
				)
	return {
		"processed": processed,
		"bytes_removed": bytes_removed,
		"details": details,
	}


def _store_cache_entries(cache_dir: Path, archive_dir: Path, payload: CacheStoreRequest) -> dict[str, object]:
	cache_root = cache_dir.resolve()
	archive_root = archive_dir.resolve()
	cache_root.mkdir(parents=True, exist_ok=True)
	archive_root.mkdir(parents=True, exist_ok=True)
	label = _sanitize_label(payload.label)
	timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
	folder = timestamp if not label else f"{timestamp}_{label}"
	destination_root = archive_root / folder
	destination_root.mkdir(parents=True, exist_ok=True)
	processed = 0
	bytes_moved = 0
	details: list[CacheMutationDetail] = []
	for entry in payload.entries:
		try:
			targets = _resolve_cache_targets(cache_root, entry, include_metadata=payload.include_metadata)
		except ValueError as exc:
			details.append(CacheMutationDetail(path=entry, status="invalid", detail=str(exc)))
			continue
		for path in targets:
			if not path.exists():
				details.append(CacheMutationDetail(path=str(path.relative_to(cache_root)), status="missing"))
				continue
			dest_path = destination_root / path.relative_to(cache_root)
			dest_path.parent.mkdir(parents=True, exist_ok=True)
			try:
				size = path.stat().st_size
			except OSError:
				size = None
			try:
				shutil.move(str(path), str(dest_path))
				processed += 1
				if size:
					bytes_moved += size
				details.append(
					CacheMutationDetail(
						path=str(dest_path.relative_to(archive_root)),
						bytes=size,
						status="stored",
					)
				)
			except OSError as exc:
				details.append(
					CacheMutationDetail(
						path=str(path.relative_to(cache_root)),
						bytes=size,
						status="error",
						detail=str(exc),
					)
				)
	return {
		"processed": processed,
		"bytes_moved": bytes_moved,
		"destination": str(destination_root),
		"label": payload.label,
		"details": details,
	}


def _resolve_cache_targets(cache_root: Path, entry: str, *, include_metadata: bool) -> list[Optional[Path]]:
	clean = entry.strip().lstrip("/\\")
	if not clean:
		raise ValueError("empty entry path")
	target = (cache_root / Path(clean)).resolve()
	try:
		target.relative_to(cache_root)
	except ValueError:
		raise ValueError("entry outside cache directory")
	targets = [target]
	if include_metadata and target.suffix.lower() == ".grib2":
		targets.append(target.with_suffix(target.suffix + ".json"))
	return targets


def _sanitize_label(label: str | None) -> str | None:
	if not label:
		return None
	sanitized = re.sub(r"[^A-Za-z0-9_-]+", "_", label).strip("_")
	return sanitized or None
