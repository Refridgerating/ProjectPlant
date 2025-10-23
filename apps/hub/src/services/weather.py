import asyncio
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from config import settings

logger = logging.getLogger("projectplant.hub.weather")

@dataclass
class CachedWeather:
    data: list[dict[str, Any]]
    station: dict[str, Any] | None
    expires_at: float

class WeatherService:
    def __init__(self) -> None:
        self._client: Optional[httpx.AsyncClient] = None
        self._cache: dict[tuple[float, float, float], CachedWeather] = {}
        self._lock = asyncio.Lock()

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            headers = {
                "User-Agent": settings.weather_user_agent,
                "Accept": "application/geo+json",
            }
            self._client = httpx.AsyncClient(headers=headers, timeout=settings.weather_request_timeout)
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get_observations(self, lat: float, lon: float, hours: float) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        window = max(hours, 0.5)
        key = (round(lat, 4), round(lon, 4), round(window, 1))
        ttl = settings.weather_cache_ttl
        now = time.monotonic()
        if ttl > 0:
            cached = self._cache.get(key)
            if cached and cached.expires_at > now:
                return cached.data, cached.station

        async with self._lock:
            if ttl > 0:
                cached = self._cache.get(key)
                if cached and cached.expires_at > now:
                    return cached.data, cached.station

            client = await self._get_client()
            station_url, station_info = await self._resolve_station(client, lat, lon)
            observations = await self._fetch_observations(client, station_url, window)
            if ttl > 0:
                self._cache[key] = CachedWeather(data=observations, station=station_info, expires_at=now + ttl)
            return observations, station_info

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
