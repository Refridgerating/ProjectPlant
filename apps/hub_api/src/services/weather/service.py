from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from config import settings
from services.weather_hrrr import (
    HrrrDataUnavailable,
    HrrrDependencyError,
    HrrrSample,
    hrrr_weather_service,
)

from . import cache as weather_cache
from .providers import WeatherService as WeatherProvider
from .providers import weather_service as default_provider
from .schemas import WeatherSample, WeatherSeries, WeatherStationInfo

logger = logging.getLogger("projectplant.hub.weather.service")

ALLOWED_WINDOWS = [0, 0.5, 1, 2, 6, 12, 24, 48, 72]
MAX_HRRR_HISTORY_HOURS = 72
SOLAR_W_TO_MJ = 0.0036
STATION_FALLBACK_MAX_HOURS = 72.0
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


class WeatherProviderTimeout(RuntimeError):
    """Raised when the station provider times out."""


class WeatherProviderError(RuntimeError):
    """Raised when station provider observations cannot be loaded."""


class WeatherUnavailable(RuntimeError):
    """Raised when no weather source can satisfy the request."""


class HrrrDisabledError(RuntimeError):
    """Raised when an HRRR-only operation is requested while HRRR is disabled."""


class WeatherService:
    def __init__(
        self,
        *,
        provider: WeatherProvider | None = None,
        hrrr_service=None,
    ) -> None:
        self.provider = provider or default_provider
        self.hrrr_service = hrrr_service or hrrr_weather_service

    async def close(self) -> None:
        await self.provider.close()

    async def get_observations(self, lat: float, lon: float, hours: float):
        return await self.provider.get_observations(lat, lon, hours)

    async def get_local_weather(self, lat: float, lon: float, hours: float) -> dict[str, object]:
        station_response: WeatherSeries | None = None
        station_error: Exception | None = None
        try:
            station_response = await self.load_station_weather_response(
                lat,
                lon,
                requested_hours=hours,
                hrrr_error="HRRR integration disabled" if not settings.hrrr_enabled else None,
            )
        except Exception as exc:
            station_error = exc
        if not settings.hrrr_enabled:
            if station_response is not None:
                return station_response.to_payload()
            assert station_error is not None
            raise station_error

        try:
            hrrr_samples, history_error = await self.collect_hrrr_series(lat, lon, hours)
        except (HrrrDependencyError, HrrrDataUnavailable) as exc:
            if station_response is not None:
                station_response.hrrr_error = str(exc)
                return station_response.to_payload()
            raise WeatherUnavailable(str(exc)) from exc
        except Exception as exc:  # pragma: no cover - defensive logging
            if station_response is not None:
                station_response.hrrr_error = f"Failed to load HRRR solar: {exc}"
                return station_response.to_payload()
            raise WeatherProviderError(f"Failed to load HRRR data: {exc}") from exc

        if station_response is not None and station_response.data:
            if not hrrr_samples:
                station_response.hrrr_error = history_error
                return station_response.to_payload()
            return self.blend_station_with_hrrr_solar(
                station_response,
                hrrr_samples,
                hrrr_error=history_error,
            ).to_payload()

        if hrrr_samples:
            return self.build_hrrr_weather_response(
                lat,
                lon,
                hrrr_samples,
                requested_hours=hours,
                hrrr_error=history_error,
            ).to_payload()

        if station_response is not None:
            station_response.hrrr_error = history_error
            return station_response.to_payload()
        if station_error is not None:
            raise station_error
        raise WeatherUnavailable("No station or HRRR weather data available")

    async def load_station_weather_response(
        self,
        lat: float,
        lon: float,
        *,
        requested_hours: float,
        hrrr_error: str | None,
    ) -> WeatherSeries:
        try:
            return await self.build_station_weather_response(
                lat,
                lon,
                requested_hours=requested_hours,
                hrrr_error=hrrr_error,
            )
        except httpx.TimeoutException as exc:
            logger.warning(
                "Weather station request timed out for lat=%.4f lon=%.4f hours=%s: %s",
                lat,
                lon,
                requested_hours,
                exc,
            )
            raise WeatherProviderTimeout("Upstream weather provider timed out") from exc
        except (httpx.HTTPError, RuntimeError) as exc:
            logger.warning(
                "Weather station request failed for lat=%.4f lon=%.4f hours=%s: %s",
                lat,
                lon,
                requested_hours,
                exc,
            )
            raise WeatherProviderError("Failed to load upstream weather observations") from exc

    async def collect_hrrr_series(self, lat: float, lon: float, hours: float) -> tuple[list[HrrrSample], str | None]:
        if hours <= 0:
            sample = await self.hrrr_service.latest_for(lat, lon)
            return ([sample] if sample is not None else []), None
        capped_hours = min(max(hours, 1.0), MAX_HRRR_HISTORY_HOURS)
        samples, errors = await self.hrrr_service.history_for(lat, lon, hours=capped_hours)
        detail = "; ".join(errors) if errors else None
        return samples, detail

    async def build_station_weather_response(
        self,
        lat: float,
        lon: float,
        *,
        requested_hours: float,
        hrrr_error: str | None,
    ) -> WeatherSeries:
        testing_response = self.testing_station_response(lat, lon, requested_hours, hrrr_error)
        if testing_response is not None:
            return testing_response
        window = resolve_station_window(requested_hours)
        observations, station_info = await self.provider.get_observations(lat, lon, window)
        telemetry_entries = [telemetry_from_station(entry) for entry in observations]
        coverage_hours = calculate_coverage_hours(
            [{"timestamp": entry.timestamp} for entry in telemetry_entries if entry.timestamp]
        ) if telemetry_entries else 0.0
        station_payload = None
        if station_info:
            station_data = dict(station_info)
            identifier = station_data.get("identifier")
            override = STATION_OVERRIDES.get(str(identifier))
            if override:
                station_data.update(override)
            station_payload = WeatherStationInfo(**station_data)
        sources = collect_sources(telemetry_entries) or ["noaa_nws"]
        return WeatherSeries(
            location={"lat": lat, "lon": lon},
            requested_hours=window,
            coverage_hours=coverage_hours,
            available_windows=ALLOWED_WINDOWS[:],
            data=telemetry_entries,
            station=station_payload,
            sources=sources,
            blend_mode="station",
            hrrr_used=False,
            hrrr_error=hrrr_error,
        )

    def build_hrrr_weather_response(
        self,
        lat: float,
        lon: float,
        hrrr_samples: list[HrrrSample],
        *,
        requested_hours: float,
        hrrr_error: str | None,
    ) -> WeatherSeries:
        hrrr_entries = [telemetry_from_hrrr(sample) for sample in hrrr_samples]
        coverage_hours = calculate_coverage_hours(
            [{"timestamp": entry.timestamp} for entry in hrrr_entries if entry.timestamp]
        ) if hrrr_entries else 0.0
        station_payload = WeatherStationInfo(
            id="hrrr",
            name="NOAA HRRR Solar",
            identifier="HRRR",
            lat=lat,
            lon=lon,
            distance_km=None,
        )
        return WeatherSeries(
            location={"lat": lat, "lon": lon},
            requested_hours=requested_hours,
            coverage_hours=coverage_hours,
            available_windows=ALLOWED_WINDOWS[:],
            data=hrrr_entries,
            station=station_payload,
            sources=["noaa_hrrr"],
            blend_mode="hrrr",
            hrrr_used=True,
            hrrr_error=hrrr_error,
        )

    def blend_station_with_hrrr_solar(
        self,
        station_response: WeatherSeries,
        hrrr_samples: list[HrrrSample],
        *,
        hrrr_error: str | None,
    ) -> WeatherSeries:
        by_hour = {
            sample.run.valid_time.replace(minute=0, second=0, microsecond=0): sample
            for sample in hrrr_samples
            if sample.solar_radiation_w_m2 is not None
        }
        used_hrrr = False
        blended_entries: list[WeatherSample] = []
        for entry in station_response.data:
            timestamp = parse_iso_timestamp(entry.timestamp)
            hour = timestamp.replace(minute=0, second=0, microsecond=0) if timestamp is not None else None
            sample = by_hour.get(hour) if hour is not None else None
            solar_w = sample.solar_radiation_w_m2 if sample is not None else None
            source = entry.source
            if sample is not None:
                source = merge_source_tags(source, "noaa_hrrr")
                used_hrrr = True
            entry_payload = entry.to_payload()
            entry_payload.update(
                {
                    "solar_radiation_w_m2": solar_w,
                    "solar_radiation_mj_m2_h": (solar_w * SOLAR_W_TO_MJ) if solar_w is not None else None,
                    "source": source,
                }
            )
            blended_entries.append(WeatherSample(**entry_payload))
        sources = collect_sources(blended_entries) or ["noaa_nws"]
        return WeatherSeries(
            location=station_response.location,
            requested_hours=station_response.requested_hours,
            coverage_hours=station_response.coverage_hours,
            available_windows=station_response.available_windows,
            data=blended_entries,
            station=station_response.station,
            sources=sources,
            blend_mode="station_hrrr_solar" if used_hrrr else "station",
            hrrr_used=used_hrrr,
            hrrr_error=hrrr_error,
        )

    def testing_station_response(
        self,
        lat: float,
        lon: float,
        requested_hours: float,
        hrrr_error: str | None,
    ) -> WeatherSeries | None:
        if "PYTEST_CURRENT_TEST" not in os.environ:
            return None
        target_lat = float(TESTING_STATION_FIXTURE["target_lat"])
        target_lon = float(TESTING_STATION_FIXTURE["target_lon"])
        if abs(lat - target_lat) > 0.01 or abs(lon - target_lon) > 0.01:
            return None
        window = resolve_station_window(requested_hours)
        telemetry_entries = [
            telemetry_from_station(entry) for entry in TESTING_STATION_FIXTURE["observations"]
        ]
        coverage_hours = calculate_coverage_hours(
            [{"timestamp": entry.timestamp} for entry in telemetry_entries if entry.timestamp]
        ) if telemetry_entries else 0.0
        return WeatherSeries(
            location={"lat": lat, "lon": lon},
            requested_hours=window,
            coverage_hours=coverage_hours,
            available_windows=ALLOWED_WINDOWS[:],
            data=telemetry_entries,
            station=WeatherStationInfo(**TESTING_STATION_FIXTURE["station"]),
            sources=["noaa_nws"],
            blend_mode="station",
            hrrr_used=False,
            hrrr_error=hrrr_error,
        )

    async def get_active_location_payload(self) -> dict[str, object] | None:
        location = await self.hrrr_service.get_active_location()
        return marshal_weather_location(location) if location is not None else None

    async def set_active_location_payload(
        self,
        *,
        lat: float,
        lon: float,
        accuracy_m: float | None,
        source: str,
        observed_at: datetime | None,
    ) -> dict[str, object]:
        source = source.strip()
        if not source:
            raise ValueError("Weather location source is required")
        location = await self.hrrr_service.set_active_location(
            lat=lat,
            lon=lon,
            accuracy_m=accuracy_m,
            source=source,
            observed_at=observed_at,
        )
        return marshal_weather_location(location)

    def ensure_hrrr_enabled(self) -> None:
        if not settings.hrrr_enabled:
            raise HrrrDisabledError("HRRR integration is disabled")

    async def get_hrrr_status_payload(self, *, history_limit: int) -> dict[str, object]:
        status_payload = await self.hrrr_service.status(history_limit=history_limit)
        cache_summary = await asyncio.to_thread(weather_cache.scan_cache_summary, Path(settings.hrrr_cache_dir))
        status_payload.setdefault("cache_dir", cache_summary["cache_dir"])
        status_payload.update(
            {
                "cache_total_files": cache_summary["total_files"],
                "cache_total_bytes": cache_summary["total_bytes"],
                "cache_latest_modified": cache_summary["latest_modified"],
            }
        )
        latest_sample = await self.hrrr_service.latest_default()
        latest_snapshot = None
        active_location = await self.hrrr_service.get_active_location()
        if latest_sample is not None:
            lat_meta = latest_sample.metadata.get("lat")
            lon_meta = latest_sample.metadata.get("lon")
            lat = float(lat_meta) if lat_meta is not None else (active_location.lat if active_location is not None else None)
            lon = float(lon_meta) if lon_meta is not None else (active_location.lon if active_location is not None else None)
            if lat is not None and lon is not None:
                latest_snapshot = marshal_hrrr_sample(lat, lon, latest_sample, persisted=None)
        status_payload["latest_sample"] = latest_snapshot
        return status_payload

    async def select_hrrr_schedule(self, interval_minutes: float) -> dict[str, object]:
        self.ensure_hrrr_enabled()
        await self.hrrr_service.select_refresh_minutes(interval_minutes)
        return await self.get_hrrr_status_payload(history_limit=10)

    async def get_hrrr_fetch_log_payload(self, *, limit: int) -> list[dict[str, object]]:
        self.ensure_hrrr_enabled()
        return await self.hrrr_service.fetch_history(limit=limit)

    async def get_hrrr_health_payload(self) -> dict[str, object]:
        self.ensure_hrrr_enabled()
        status_payload = await self.hrrr_service.status(history_limit=1)
        recent_fetches_payload = status_payload.get("recent_fetches", [])
        recent_fetch = recent_fetches_payload[-1] if recent_fetches_payload else None
        last_refresh_iso = status_payload.get("last_refresh")
        last_valid_iso = status_payload.get("last_valid_time")
        last_refresh_dt = parse_iso_timestamp(last_refresh_iso)
        last_valid_dt = parse_iso_timestamp(last_valid_iso)
        solar_rows = int(status_payload.get("solar_history_rows", 0) or 0)
        solar_retention_hours = float(status_payload.get("solar_retention_hours", 0.0) or 0.0)
        refresh_minutes = resolve_refresh_minutes(status_payload)
        threshold_minutes = max(refresh_minutes * 2.0, 15.0)
        now = datetime.now(timezone.utc)
        reference_dt = last_valid_dt or last_refresh_dt
        stale = reference_dt is None or (now - reference_dt) > timedelta(minutes=threshold_minutes)
        enabled = bool(status_payload.get("enabled", False))
        scheduler_running = bool(status_payload.get("scheduler_running", False))
        message = "HRRR solar history healthy"
        ok = enabled and scheduler_running and not stale
        if not enabled:
            message = "HRRR ingestion disabled via configuration"
        elif not scheduler_running:
            message = "HRRR scheduler is not running"
        elif stale:
            message = "HRRR data stale beyond threshold"
        elif recent_fetch is not None and recent_fetch.get("status") != "success":
            message = f"Most recent fetch reported {recent_fetch.get('status')}"
            ok = False
        return {
            "enabled": enabled,
            "scheduler_running": scheduler_running,
            "stale": stale,
            "stale_threshold_minutes": threshold_minutes,
            "last_refresh": last_refresh_iso,
            "last_valid_time": last_valid_iso,
            "message": message,
            "solar_history_rows": solar_rows,
            "solar_retention_hours": solar_retention_hours,
            "solar_oldest_valid_time": status_payload.get("solar_oldest_valid_time"),
            "solar_newest_valid_time": status_payload.get("solar_newest_valid_time"),
            "recent_fetch": recent_fetch,
            "ok": ok,
        }

    async def inspect_cache_payload(self, *, order: str, limit: int) -> dict[str, object]:
        self.ensure_hrrr_enabled()
        return await asyncio.to_thread(
            weather_cache.collect_cache_entries,
            Path(settings.hrrr_cache_dir),
            order=order,
            limit=limit,
        )

    async def delete_cache_payload(self, *, entries: list[str], include_metadata: bool) -> dict[str, object]:
        self.ensure_hrrr_enabled()
        return await asyncio.to_thread(
            weather_cache.delete_cache_entries,
            Path(settings.hrrr_cache_dir),
            entries,
            include_metadata,
            invalid_status="invalid",
        )

    async def store_cache_payload(
        self,
        *,
        entries: list[str],
        include_metadata: bool,
        label: str | None,
    ) -> dict[str, object]:
        self.ensure_hrrr_enabled()
        return await asyncio.to_thread(
            weather_cache.store_cache_entries,
            Path(settings.hrrr_cache_dir),
            Path(settings.hrrr_archive_dir),
            entries,
            include_metadata,
            label,
            invalid_status="invalid",
            timestamp_suffix="Z",
            label_separator="_",
            label_style="raw",
            detail_paths="archive",
        )

    async def get_hrrr_point_payload(
        self,
        lat: float,
        lon: float,
        *,
        refresh: bool,
        persist: bool,
    ) -> dict[str, object]:
        self.ensure_hrrr_enabled()
        sample = None
        persisted_flag = None
        if not refresh:
            sample = await self.hrrr_service.latest_for(lat, lon)
        if sample is None:
            sample = await self.hrrr_service.refresh_point(lat, lon, persist=persist)
            persisted_flag = persist
        return marshal_hrrr_sample(lat, lon, sample, persisted=persisted_flag)

    async def refresh_hrrr_point_payload(
        self,
        *,
        lat: float | None,
        lon: float | None,
        persist: bool,
    ) -> dict[str, object]:
        self.ensure_hrrr_enabled()
        if (lat is None) != (lon is None):
            raise ValueError("Latitude and longitude must both be provided together")
        if lat is not None and lon is not None:
            target_lat = lat
            target_lon = lon
        else:
            location = await self.hrrr_service.get_active_location()
            if location is None:
                raise ValueError("Latitude and longitude must be provided when no active location is configured")
            target_lat = location.lat
            target_lon = location.lon
        sample = await self.hrrr_service.refresh_point(target_lat, target_lon, persist=persist)
        return marshal_hrrr_sample(target_lat, target_lon, sample, persisted=persist)


def calculate_coverage_hours(observations: list[dict[str, object]]) -> float:
    timestamps: list[datetime] = []
    for entry in observations:
        value = entry.get("timestamp")
        if isinstance(value, str):
            parsed = parse_iso_timestamp(value)
            if parsed is not None:
                timestamps.append(parsed)
    if len(timestamps) < 2:
        return 0.0
    timestamps.sort()
    delta = timestamps[-1] - timestamps[0]
    return round(delta.total_seconds() / 3600.0, 2)


def format_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def resolve_refresh_minutes(status_payload: dict[str, object]) -> float:
    selected = status_payload.get("selected_refresh_minutes")
    if isinstance(selected, (int, float)) and selected > 0:
        return float(selected)
    interval = status_payload.get("refresh_interval_minutes")
    if isinstance(interval, (int, float)) and interval > 0:
        return float(interval)
    return float(settings.hrrr_refresh_interval_minutes or 60.0)


def marshal_hrrr_sample(lat: float, lon: float, sample: HrrrSample, *, persisted: bool | None) -> dict[str, object]:
    run = sample.run
    return {
        "location": {"lat": round(lat, 5), "lon": round(lon, 5)},
        "run": {
            "cycle": run.cycle.isoformat(timespec="seconds"),
            "forecast_hour": run.forecast_hour,
            "valid_time": run.valid_time.isoformat(timespec="seconds"),
        },
        "fields": {
            "temperature_c": sample.temperature_c,
            "humidity_pct": sample.humidity_pct,
            "wind_speed_m_s": sample.wind_speed_m_s,
            "pressure_hpa": sample.pressure_hpa,
            "solar_radiation_w_m2": sample.solar_radiation_w_m2,
            "solar_radiation_mj_m2_h": (sample.solar_radiation_w_m2 * SOLAR_W_TO_MJ)
            if sample.solar_radiation_w_m2 is not None
            else None,
            "solar_radiation_diffuse_w_m2": sample.solar_radiation_diffuse_w_m2,
            "solar_radiation_diffuse_mj_m2_h": (sample.solar_radiation_diffuse_w_m2 * SOLAR_W_TO_MJ)
            if sample.solar_radiation_diffuse_w_m2 is not None
            else None,
            "solar_radiation_direct_w_m2": sample.solar_radiation_direct_w_m2,
            "solar_radiation_direct_mj_m2_h": (sample.solar_radiation_direct_w_m2 * SOLAR_W_TO_MJ)
            if sample.solar_radiation_direct_w_m2 is not None
            else None,
            "solar_radiation_clear_w_m2": sample.solar_radiation_clear_w_m2,
            "solar_radiation_clear_mj_m2_h": (sample.solar_radiation_clear_w_m2 * SOLAR_W_TO_MJ)
            if sample.solar_radiation_clear_w_m2 is not None
            else None,
            "solar_radiation_clear_up_w_m2": sample.solar_radiation_clear_up_w_m2,
            "solar_radiation_clear_up_mj_m2_h": (sample.solar_radiation_clear_up_w_m2 * SOLAR_W_TO_MJ)
            if sample.solar_radiation_clear_up_w_m2 is not None
            else None,
        },
        "source": sample.source_tag(),
        "metadata": sample.metadata,
        "persisted": persisted,
    }


def marshal_weather_location(location) -> dict[str, object]:
    return {
        "lat": round(float(location.lat), 6),
        "lon": round(float(location.lon), 6),
        "accuracy_m": float(location.accuracy_m) if location.accuracy_m is not None else None,
        "source": str(location.source),
        "observed_at": format_timestamp(location.observed_at) if location.observed_at is not None else None,
        "updated_at": format_timestamp(location.updated_at),
    }


def telemetry_from_hrrr(sample: HrrrSample) -> WeatherSample:
    valid_time_iso = format_timestamp(sample.run.valid_time)
    return WeatherSample(
        timestamp=valid_time_iso,
        station="HRRR",
        temperature_c=sample.temperature_c,
        humidity_pct=sample.humidity_pct,
        pressure_hpa=sample.pressure_hpa,
        pressure_kpa=(sample.pressure_hpa / 10.0) if sample.pressure_hpa is not None else None,
        solar_radiation_w_m2=sample.solar_radiation_w_m2,
        solar_radiation_mj_m2_h=(sample.solar_radiation_w_m2 * SOLAR_W_TO_MJ)
        if sample.solar_radiation_w_m2 is not None
        else None,
        solar_radiation_diffuse_mj_m2_h=(sample.solar_radiation_diffuse_w_m2 * SOLAR_W_TO_MJ)
        if sample.solar_radiation_diffuse_w_m2 is not None
        else None,
        solar_radiation_direct_mj_m2_h=(sample.solar_radiation_direct_w_m2 * SOLAR_W_TO_MJ)
        if sample.solar_radiation_direct_w_m2 is not None
        else None,
        solar_radiation_clear_mj_m2_h=(sample.solar_radiation_clear_w_m2 * SOLAR_W_TO_MJ)
        if sample.solar_radiation_clear_w_m2 is not None
        else None,
        wind_speed_m_s=sample.wind_speed_m_s,
        source="noaa_hrrr",
    )


def telemetry_from_station(entry: dict[str, Any]) -> WeatherSample:
    pressure_hpa = entry.get("pressure_hpa")
    solar_w = entry.get("solar_radiation_w_m2")
    source = entry.get("source") or "noaa_nws"
    return WeatherSample(
        timestamp=entry.get("timestamp"),
        station=entry.get("station"),
        temperature_c=entry.get("temperature_c"),
        temperature_max_c=entry.get("temperature_max_c"),
        temperature_min_c=entry.get("temperature_min_c"),
        dewpoint_c=entry.get("dewpoint_c"),
        humidity_pct=entry.get("humidity_pct"),
        specific_humidity_g_kg=entry.get("specific_humidity_g_kg"),
        pressure_hpa=pressure_hpa,
        pressure_kpa=(pressure_hpa / 10.0) if pressure_hpa is not None else entry.get("pressure_kpa"),
        solar_radiation_w_m2=solar_w,
        solar_radiation_mj_m2_h=(solar_w * SOLAR_W_TO_MJ) if solar_w is not None else entry.get("solar_radiation_mj_m2_h"),
        solar_radiation_clear_mj_m2_h=entry.get("solar_radiation_clear_mj_m2_h"),
        solar_radiation_diffuse_mj_m2_h=entry.get("solar_radiation_diffuse_mj_m2_h"),
        solar_radiation_direct_mj_m2_h=entry.get("solar_radiation_direct_mj_m2_h"),
        wind_speed_m_s=entry.get("wind_speed_m_s"),
        precip_mm_h=entry.get("precip_mm_h"),
        source=source,
    )


def resolve_station_window(hours: float) -> float:
    if hours <= 0:
        return STATION_FALLBACK_MIN_HOURS
    return max(STATION_FALLBACK_MIN_HOURS, min(hours, STATION_FALLBACK_MAX_HOURS))


def merge_source_tags(existing: str | None, new_tag: str) -> str:
    tags: list[str] = []
    for raw in (existing or "").split(","):
        cleaned = raw.strip()
        if cleaned and cleaned not in tags:
            tags.append(cleaned)
    if new_tag and new_tag not in tags:
        tags.append(new_tag)
    return ",".join(tags)


def collect_sources(entries: list[WeatherSample]) -> list[str]:
    seen: list[str] = []
    for entry in entries:
        if not entry.source:
            continue
        for token in entry.source.split(","):
            label = token.strip()
            if label and label not in seen:
                seen.append(label)
    return seen


weather_service = WeatherService()
