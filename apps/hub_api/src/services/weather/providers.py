import asyncio
import logging
import json
import math
import time as time_utils
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone, time as dt_time
from typing import Any, Optional

import httpx

from config import settings
from etkc.reference import sat_vapor_pressure_kPa

logger = logging.getLogger("projectplant.hub.weather")

MJ_M2_H_TO_W_M2 = 1_000_000.0 / 3600.0
NASA_ENDPOINT_PATH = "/api/temporal/hourly/point"
NASA_PARAMETERS = [
    "ALLSKY_SFC_SW_DWN",
    "CLRSKY_SFC_SW_DWN",
    "T2M",
    "RH2M",
    "T2MDEW",
    "QV2M",
    "WS2M",
    "PS",
    "PRECTOTCORR",
]
NASA_PRIMARY_FIELDS = {"temperature_c", "humidity_pct", "pressure_hpa", "solar_radiation_w_m2", "wind_speed_m_s"}
NASA_MISSING_THRESHOLD = -900.0

@dataclass
class CachedWeather:
    data: list[dict[str, Any]]
    station: dict[str, Any] | None
    expires_at: float

@dataclass
class CachedNASAHourly:
    data: dict[datetime, dict[str, Any]]
    range_start: datetime
    range_end: datetime
    expires_at: datetime

class WeatherService:
    def __init__(self) -> None:
        self._noaa_client: Optional[httpx.AsyncClient] = None
        self._nasa_client: Optional[httpx.AsyncClient] = None
        self._cache: dict[tuple[float, float, float], CachedWeather] = {}
        self._nasa_cache: dict[tuple[float, float], CachedNASAHourly] = {}
        self._lock = asyncio.Lock()

    async def _get_noaa_client(self) -> httpx.AsyncClient:
        if self._noaa_client is None:
            headers = {
                "User-Agent": settings.weather_user_agent,
                "Accept": "application/geo+json",
            }
            self._noaa_client = httpx.AsyncClient(headers=headers, timeout=settings.weather_request_timeout)
        return self._noaa_client

    async def _get_nasa_client(self) -> httpx.AsyncClient:
        if self._nasa_client is None:
            headers = {
                "User-Agent": settings.weather_user_agent,
                "Accept": "application/json",
            }
            self._nasa_client = httpx.AsyncClient(
                base_url=settings.nasa_power_base_url,
                headers=headers,
                timeout=settings.weather_request_timeout,
            )
        return self._nasa_client

    async def close(self) -> None:
        if self._noaa_client:
            await self._noaa_client.aclose()
            self._noaa_client = None
        if self._nasa_client:
            await self._nasa_client.aclose()
            self._nasa_client = None

    async def get_observations(self, lat: float, lon: float, hours: float) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        window = max(hours, 0.5)
        key = (round(lat, 4), round(lon, 4), round(window, 1))
        ttl = settings.weather_cache_ttl
        now = time_utils.monotonic()
        if ttl > 0:
            cached = self._cache.get(key)
            if cached and cached.expires_at > now:
                return cached.data, cached.station

        async with self._lock:
            if ttl > 0:
                cached = self._cache.get(key)
                if cached and cached.expires_at > now:
                    return cached.data, cached.station

            noaa_client = await self._get_noaa_client()
            station_url, station_info = await self._resolve_station(noaa_client, lat, lon)
            observations = await self._fetch_observations(noaa_client, station_url, window)

            now_utc = datetime.now(timezone.utc)
            end_hour = now_utc.replace(minute=0, second=0, microsecond=0)
            start_cutoff = now_utc - timedelta(hours=window)
            start_hour = start_cutoff.replace(minute=0, second=0, microsecond=0)
            if start_hour > end_hour:
                start_hour = end_hour

            nasa_hourly: dict[datetime, dict[str, Any]] = {}
            historical_cutoff = now_utc - timedelta(days=3)
            if end_hour < historical_cutoff:
                try:
                    nasa_hourly = await self._get_cached_nasa_hourly(lat, lon, start_hour, end_hour)
                except Exception:  # noqa: BLE001 - we want to log and continue
                    logger.warning("Failed to fetch NASA POWER data", exc_info=True)
            merged = self._merge_observations_with_nasa(observations, nasa_hourly, start_hour, end_hour)

            if ttl > 0:
                self._cache[key] = CachedWeather(data=merged, station=station_info, expires_at=now + ttl)
            return merged, station_info

    async def _resolve_station(self, client: httpx.AsyncClient, lat: float, lon: float) -> tuple[str, dict[str, Any] | None]:
        points_url = f"{settings.weather_base_url}/points/{lat:.4f},{lon:.4f}"
        logger.debug("Fetching station list from %s", points_url)
        points_resp = await client.get(points_url)
        points_resp.raise_for_status()
        points_data = points_resp.json()
        stations_url = points_data.get("properties", {}).get("observationStations")
        if not stations_url:
            raise RuntimeError("No observation stations available for provided location")

        stations_resp = await client.get(stations_url)
        stations_resp.raise_for_status()
        stations_data = stations_resp.json()
        station_features = stations_data.get("features", [])
        if not station_features:
            raise RuntimeError("No stations returned by upstream provider")

        station_feature = station_features[0]
        station_url = station_feature.get("id")
        if not station_url:
            raise RuntimeError("Station response missing identifier")
        station_info: dict[str, Any] | None = None
        if isinstance(station_feature, dict):
            props = station_feature.get("properties", {}) if isinstance(station_feature.get("properties"), dict) else {}
            geometry = station_feature.get("geometry", {}) if isinstance(station_feature.get("geometry"), dict) else {}
            coordinates = geometry.get("coordinates")
            station_lat: float | None = None
            station_lon: float | None = None
            if isinstance(coordinates, (list, tuple)) and len(coordinates) >= 2:
                lon_val, lat_val = coordinates[0], coordinates[1]
                try:
                    station_lon = float(lon_val)
                    station_lat = float(lat_val)
                except (TypeError, ValueError):
                    station_lat = None
                    station_lon = None
            distance_km: float | None = None
            if station_lat is not None and station_lon is not None:
                distance_km = self._haversine_km(lat, lon, station_lat, station_lon)
            station_info = {
                "id": station_url,
                "name": props.get("name"),
                "identifier": props.get("stationIdentifier"),
                "lat": station_lat,
                "lon": station_lon,
                "distance_km": distance_km,
            }
        return station_url, station_info

    async def _fetch_observations(
        self,
        client: httpx.AsyncClient,
        station_url: str,
        hours: float,
    ) -> list[dict[str, Any]]:
        end_dt = datetime.now(timezone.utc)
        start_dt = end_dt - timedelta(hours=hours)
        params = {
            "start": start_dt.isoformat(),
            "end": end_dt.isoformat(),
            "limit": min(max(int(hours * 8) + 20, 100), 1000),
        }

        results: list[dict[str, Any]] = []
        next_url: Optional[str] = f"{station_url}/observations"
        first_request = True

        while next_url:
            logger.debug("Fetching observations from %s", next_url)
            response = await client.get(next_url, params=params if first_request else None)
            first_request = False
            response.raise_for_status()
            payload = response.json()
            features = payload.get("features", [])
            if not features:
                break

            for feature in features:
                entry = self._transform_weather(feature)
                ts = self._parse_timestamp(entry["timestamp"])
                if ts is None or ts < start_dt or ts > end_dt:
                    continue
                results.append(entry)

            oldest_in_batch = min(
                (self._parse_timestamp(feature.get("properties", {}).get("timestamp")) for feature in features),
                default=None,
            )
            next_url = payload.get("pagination", {}).get("next")
            if not next_url or (oldest_in_batch and oldest_in_batch <= start_dt):
                break

        results.sort(key=lambda entry: entry["timestamp"] or "")
        return results

    async def _get_cached_nasa_hourly(
        self,
        lat: float,
        lon: float,
        requested_start: datetime,
        requested_end: datetime,
    ) -> dict[datetime, dict[str, Any]]:
        key = (round(lat, 4), round(lon, 4))
        now_utc = datetime.now(timezone.utc)
        default_start_date = (now_utc - timedelta(days=1)).date()
        default_end_date = (now_utc + timedelta(days=1)).date()
        range_start_date = min(default_start_date, requested_start.date())
        range_end_date = max(default_end_date, requested_end.date())
        today_date = now_utc.date()
        if range_end_date > today_date:
            range_end_date = today_date
        if range_start_date > range_end_date:
            range_start_date = range_end_date
        range_start = datetime.combine(range_start_date, dt_time(0, 0), tzinfo=timezone.utc)
        range_end = datetime.combine(range_end_date, dt_time(23, 0), tzinfo=timezone.utc)

        cached = self._nasa_cache.get(key)
        if (
            cached
            and cached.expires_at > now_utc
            and cached.range_start <= range_start
            and cached.range_end >= range_end
        ):
            return cached.data

        hourly = await self._fetch_nasa_power(lat, lon, range_start, range_end)
        refresh_date = (now_utc + timedelta(days=1)).date()
        expires_at = datetime.combine(refresh_date, dt_time(0, 0), tzinfo=timezone.utc)
        self._nasa_cache[key] = CachedNASAHourly(
            data=hourly,
            range_start=range_start,
            range_end=range_end,
            expires_at=expires_at,
        )
        return hourly

    async def _fetch_nasa_power(
        self,
        lat: float,
        lon: float,
        start_hour: datetime,
        end_hour: datetime,
    ) -> dict[datetime, dict[str, Any]]:
        if start_hour.tzinfo is None:
            start_hour = start_hour.replace(tzinfo=timezone.utc)
        else:
            start_hour = start_hour.astimezone(timezone.utc)
        if end_hour.tzinfo is None:
            end_hour = end_hour.replace(tzinfo=timezone.utc)
        else:
            end_hour = end_hour.astimezone(timezone.utc)
        if start_hour > end_hour:
            start_hour = end_hour

        client = await self._get_nasa_client()
        params = {
            "latitude": f"{lat:.4f}",
            "longitude": f"{lon:.4f}",
            "start": start_hour.date().strftime("%Y%m%d"),
            "end": end_hour.date().strftime("%Y%m%d"),
            "parameters": ",".join(NASA_PARAMETERS),
            "community": "ag",
            "format": "JSON",
            "time-standard": "UTC",
        }
        logger.debug("Fetching NASA POWER data with params %s", params)
        response: httpx.Response | None = None
        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            try:
                response = await client.get(NASA_ENDPOINT_PATH, params=params)
                response.raise_for_status()
                break
            except httpx.TimeoutException as exc:
                logger.warning(
                    "NASA POWER request timed out (attempt %s/%s): %s",
                    attempt,
                    max_attempts,
                    exc,
                )
                if attempt >= max_attempts:
                    raise
                await asyncio.sleep(0.5 * attempt)
            except httpx.HTTPStatusError as exc:
                problem_text: str | None = None
                try:
                    problem_json = response.json() if response is not None else None
                    problem_text = json.dumps(problem_json) if problem_json is not None else None
                except Exception:
                    problem_text = response.text[:2_048] if (response is not None and response.text) else None
                logger.error(
                    "NASA POWER request failed (%s): params=%s body=%s",
                    exc,
                    params,
                    problem_text,
                )
                raise
        else:
            raise httpx.TimeoutException("NASA POWER request exceeded retry attempts")
        assert response is not None
        payload = response.json()
        parameter_block = payload.get("properties", {}).get("parameter", {})
        if not isinstance(parameter_block, dict):
            return {}

        hourly_values: dict[datetime, dict[str, float]] = {}
        for parameter_name, timeseries in parameter_block.items():
            if not isinstance(timeseries, dict):
                continue
            for ts_key, raw_value in timeseries.items():
                timestamp = self._parse_nasa_timestamp(ts_key)
                if timestamp is None:
                    continue
                if timestamp < start_hour - timedelta(hours=1) or timestamp > end_hour + timedelta(hours=1):
                    continue
                value = self._sanitize_nasa_value(raw_value)
                if value is None:
                    continue
                hourly_values.setdefault(timestamp, {})[parameter_name] = value

        hourly_data: dict[datetime, dict[str, Any]] = {}
        for timestamp, values in hourly_values.items():
            if timestamp < start_hour or timestamp > end_hour:
                continue
            entry = self._convert_nasa_values(values)
            if entry:
                hourly_data[timestamp] = entry
        return hourly_data

    def _convert_nasa_values(self, values: dict[str, float]) -> dict[str, Any]:
        temperature = values.get("T2M")
        dewpoint = values.get("T2MDEW")
        rh_direct = values.get("RH2M")
        specific_humidity = values.get("QV2M")
        pressure_kpa = values.get("PS")
        humidity_pct = self._derive_relative_humidity(
            temperature,
            rh_direct,
            dewpoint,
            specific_humidity,
            pressure_kpa,
        )

        solar_mj = values.get("ALLSKY_SFC_SW_DWN")
        solar_w_m2 = solar_mj * MJ_M2_H_TO_W_M2 if solar_mj is not None else None

        entry: dict[str, Any] = {
            "temperature_c": temperature,
            "temperature_max_c": values.get("T2M_MAX"),
            "temperature_min_c": values.get("T2M_MIN"),
            "humidity_pct": humidity_pct,
            "dewpoint_c": dewpoint,
            "specific_humidity_g_kg": specific_humidity,
            "pressure_kpa": pressure_kpa,
            "pressure_hpa": pressure_kpa * 10.0 if pressure_kpa is not None else None,
            "solar_radiation_mj_m2_h": solar_mj,
            "solar_radiation_w_m2": solar_w_m2,
            "solar_radiation_clear_mj_m2_h": values.get("CLRSKY_SFC_SW_DWN"),
            "solar_radiation_diffuse_mj_m2_h": values.get("ALLSKY_SFC_SW_DWN_DIFF"),
            "solar_radiation_direct_mj_m2_h": values.get("ALLSKY_SFC_SW_DWN_DIRECT"),
            "wind_speed_m_s": values.get("WS2M"),
            "precip_mm_h": values.get("PRECTOTCORR"),
        }
        return entry

    def _merge_observations_with_nasa(
        self,
        noaa_observations: list[dict[str, Any]],
        nasa_hourly: dict[datetime, dict[str, Any]],
        start_hour: datetime,
        end_hour: datetime,
    ) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        noaa_by_hour: dict[datetime, dict[str, Any]] = {}
        for entry in noaa_observations:
            entry_copy = dict(entry)
            entry_copy.setdefault("source", "noaa_nws")
            timestamp = self._parse_timestamp(entry_copy.get("timestamp"))
            if timestamp is None:
                merged.append(entry_copy)
                continue
            hour_bucket = timestamp.replace(minute=0, second=0, microsecond=0)
            existing = noaa_by_hour.get(hour_bucket)
            if existing is None:
                noaa_by_hour[hour_bucket] = entry_copy
            else:
                existing_ts = self._parse_timestamp(existing.get("timestamp"))
                if existing_ts is None or timestamp > existing_ts:
                    merged.append(existing)
                    noaa_by_hour[hour_bucket] = entry_copy
                else:
                    merged.append(entry_copy)

        for hour, nasa_entry in sorted(nasa_hourly.items()):
            if hour < start_hour or hour > end_hour:
                continue
            match_hour = hour
            base_entry = noaa_by_hour.pop(match_hour, None)
            if base_entry is None:
                alt_hour = hour - timedelta(hours=1)
                if start_hour <= alt_hour <= end_hour:
                    base_entry = noaa_by_hour.pop(alt_hour, None)
                    if base_entry is not None:
                        match_hour = alt_hour
            if base_entry is not None:
                for key, value in nasa_entry.items():
                    if value is None:
                        continue
                    if key in NASA_PRIMARY_FIELDS or key not in base_entry:
                        base_entry[key] = value
                source = base_entry.get("source") or ""
                if "nasa_power" not in source:
                    base_entry["source"] = f"{source},nasa_power" if source else "nasa_power"
                merged.append(base_entry)
            else:
                timestamp_iso = hour.isoformat().replace("+00:00", "Z")
                new_entry: dict[str, Any] = {
                    "timestamp": timestamp_iso,
                    "station": "NASA POWER",
                    "temperature_c": nasa_entry.get("temperature_c"),
                    "humidity_pct": nasa_entry.get("humidity_pct"),
                    "pressure_hpa": nasa_entry.get("pressure_hpa"),
                    "solar_radiation_w_m2": nasa_entry.get("solar_radiation_w_m2"),
                    "wind_speed_m_s": nasa_entry.get("wind_speed_m_s"),
                    "source": "nasa_power",
                }
                for key, value in nasa_entry.items():
                    if key in NASA_PRIMARY_FIELDS:
                        continue
                    new_entry[key] = value
                merged.append(new_entry)

        for leftover in noaa_by_hour.values():
            if not leftover.get("source"):
                leftover["source"] = "noaa_nws"
            merged.append(leftover)

        merged.sort(key=lambda item: item.get("timestamp") or "")
        return merged

    def _derive_relative_humidity(
        self,
        temperature: Optional[float],
        rh_direct: Optional[float],
        dewpoint: Optional[float],
        specific_humidity_g_kg: Optional[float],
        pressure_kpa: Optional[float],
    ) -> Optional[float]:
        if rh_direct is not None:
            return max(0.0, min(100.0, rh_direct))
        if temperature is None:
            return None
        if dewpoint is not None:
            try:
                es_t = sat_vapor_pressure_kPa(temperature)
                es_td = sat_vapor_pressure_kPa(dewpoint)
            except ValueError:
                return None
            if es_t <= 0.0:
                return None
            rh = (es_td / es_t) * 100.0
            return max(0.0, min(100.0, rh))
        if specific_humidity_g_kg is not None and pressure_kpa is not None and pressure_kpa > 0.0:
            q = specific_humidity_g_kg / 1000.0
            denom = 0.622 + 0.378 * q
            if denom <= 0.0:
                return None
            vapor_pressure = (q * pressure_kpa) / denom
            try:
                es_t = sat_vapor_pressure_kPa(temperature)
            except ValueError:
                return None
            if es_t <= 0.0:
                return None
            rh = (vapor_pressure / es_t) * 100.0
            return max(0.0, min(100.0, rh))
        return None

    @staticmethod
    def _parse_nasa_timestamp(label: Any) -> Optional[datetime]:
        if not isinstance(label, str):
            return None
        try:
            parsed = datetime.strptime(label, "%Y%m%d%H")
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc)

    @staticmethod
    def _sanitize_nasa_value(value: Any) -> Optional[float]:
        if value is None:
            return None
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(numeric):
            return None
        if numeric <= NASA_MISSING_THRESHOLD:
            return None
        return numeric

    @staticmethod
    def _safe_value(container: dict[str, Any], *path: str) -> Optional[float]:
        data: Any = container
        for key in path:
            if not isinstance(data, dict) or key not in data:
                return None
            data = data[key]
        if data is None:
            return None
        try:
            return float(data)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    def _transform_weather(self, raw: dict[str, Any]) -> dict[str, Any]:
        props = raw.get("properties", {})
        temperature = self._safe_value(props, "temperature", "value")  # °C
        humidity = self._safe_value(props, "relativeHumidity", "value")  # %
        pressure_pa = self._safe_value(props, "barometricPressure", "value")  # Pa
        solar_w_m2 = self._safe_value(props, "solarRadiation", "value")  # W/m² or None
        wind_speed = self._safe_value(props, "windSpeed", "value")
        wind_unit_code = ""
        wind_meta = props.get("windSpeed")
        if isinstance(wind_meta, dict):
            unit_code = wind_meta.get("unitCode")
            if isinstance(unit_code, str):
                wind_unit_code = unit_code
        wind_speed_m_s = self._normalize_wind_speed(wind_speed, wind_unit_code)

        observation_time = props.get("timestamp")
        station = props.get("station")

        pressure_hpa = pressure_pa / 100.0 if pressure_pa is not None else None

        return {
            "timestamp": observation_time,
            "station": station,
            "temperature_c": temperature,
            "humidity_pct": humidity,
            "pressure_hpa": pressure_hpa,
            "solar_radiation_w_m2": solar_w_m2,
            "wind_speed_m_s": wind_speed_m_s,
        }

    @staticmethod
    def _normalize_wind_speed(value: Optional[float], unit_code: str) -> Optional[float]:
        if value is None:
            return None
        if not unit_code:
            return value

        normalized = unit_code.strip().lower()
        if "km" in normalized and ("/h" in normalized or "_h-1" in normalized):
            return value / 3.6
        if "knot" in normalized or "kt" in normalized:
            return value * 0.514444
        if "mph" in normalized:
            return value * 0.44704
        if "ft" in normalized and ("s-1" in normalized or "/s" in normalized):
            return value * 0.3048
        return value

    @staticmethod
    def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Compute great-circle distance between two points in kilometers."""
        radius_km = 6371.0
        lat1_rad = math.radians(lat1)
        lon1_rad = math.radians(lon1)
        lat2_rad = math.radians(lat2)
        lon2_rad = math.radians(lon2)

        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad

        a = math.sin(dlat / 2) ** 2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return round(radius_km * c, 3)

weather_service = WeatherService()
