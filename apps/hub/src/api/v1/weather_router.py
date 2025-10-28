from datetime import datetime, timedelta, timezone
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

ALLOWED_WINDOWS = [0.5, 1, 2, 6, 12, 24, 48]
SOLAR_W_TO_MJ = 0.0036


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


@router.get("/local", response_model=WeatherResponse)
async def get_local_weather(
	lat: float = Depends(validate_lat),
	lon: float = Depends(validate_lon),
	hours: float = Depends(validate_hours),
):
	if not settings.hrrr_enabled:
		raise HTTPException(status_code=503, detail="HRRR integration disabled")
	try:
		sample = await hrrr_weather_service.latest_for(lat, lon)
		if sample is None:
			sample = await hrrr_weather_service.refresh_point(lat, lon, persist=False)
		if sample is None:
			raise HrrrDataUnavailable("HRRR sample unavailable")
		hrrr_entries, history_error = await _collect_hrrr_series(lat, lon, hours, seed_sample=sample)
		if not hrrr_entries:
			raise HrrrDataUnavailable("No HRRR entries retrieved")
		return WeatherResponse(
			location={"lat": lat, "lon": lon},
			requested_hours=hours,
			coverage_hours=_calculate_coverage_hours(
				[{"timestamp": entry.timestamp} for entry in hrrr_entries if entry.timestamp]
			),
			available_windows=ALLOWED_WINDOWS[:],
			data=hrrr_entries,
			station=WeatherStation(
				id="hrrr",
				name="NOAA HRRR Forecast",
				identifier="HRRR",
				lat=lat,
				lon=lon,
				distance_km=None,
			),
			sources=["noaa_hrrr"],
			hrrr_used=True,
			hrrr_error=history_error,
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
	target_hours = max(1, min(int(hours if hours.is_integer() else hours + 1), 48))
	now = datetime.now(timezone.utc)
	series: dict[str, WeatherTelemetry] = {}
	errors: list[str] = []

	async def _fetch_for(timestamp: datetime, *, reuse_seed: bool) -> None:
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
		except (HrrrDependencyError, HrrrDataUnavailable) as exc:
			errors.append(str(exc))
		except Exception as exc:  # pragma: no cover - defensive logging
			errors.append(str(exc))

	reference = seed_sample.run.valid_time.replace(minute=0, second=0, microsecond=0)
	await _fetch_for(reference, reuse_seed=True)

	for offset in range(1, target_hours):
		target = (now - timedelta(hours=offset)).replace(minute=0, second=0, microsecond=0)
		target_iso = _format_timestamp(target)
		if target_iso in series:
			continue
		await _fetch_for(target, reuse_seed=False)

	entries = sorted(series.values(), key=lambda entry: _parse_iso_timestamp(entry.timestamp) or datetime.min)
	error_message = None
	if errors:
		unique_errors = sorted(set(errors))
		error_message = "; ".join(unique_errors)
	return entries, error_message


def _build_hrrr_weather_response(
	lat: float,
	lon: float,
	hrrr_entries: list[WeatherTelemetry],
	*,
	requested_hours: float,
	observations: list[dict[str, object]],
	station_info: dict[str, object] | None,
	hrrr_error: str | None,
) -> WeatherResponse:
	telemetry_entries = [WeatherTelemetry(**entry) for entry in observations]
	existing_timestamps = {entry.timestamp for entry in telemetry_entries if entry.timestamp}
	for entry in hrrr_entries:
		if entry.timestamp not in existing_timestamps:
			telemetry_entries.append(entry)
			if entry.timestamp:
				existing_timestamps.add(entry.timestamp)
	telemetry_entries.sort(key=lambda entry: _parse_iso_timestamp(entry.timestamp) or datetime.min)

	combined_payload = list(observations)
	if hrrr_entries:
		combined_payload.extend(
			{"timestamp": entry.timestamp}
			for entry in hrrr_entries
			if entry.timestamp is not None
		)
	coverage_hours = _calculate_coverage_hours(combined_payload) if combined_payload else 0.0
	available_windows = ALLOWED_WINDOWS[:]

	fallback_sources = {
		part.strip()
		for entry in observations
		for part in (entry.get("source") or "").split(",")
		if part and part.strip()
	}
	sources = sorted({*fallback_sources, "noaa_hrrr"})

	if station_info:
		station_payload = WeatherStation(**station_info)
	else:
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
		data=telemetry_entries,
		station=station_payload,
		sources=sources,
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


async def _build_hrrr_status_response(*, history_limit: int) -> HrrrStatusResponse:
	status_payload = await hrrr_weather_service.status(history_limit=history_limit)
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
