import asyncio
import logging
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

    async def get_observations(self, lat: float, lon: float, hours: float) -> list[dict[str, Any]]:
        window = max(hours, 0.5)
        key = (round(lat, 4), round(lon, 4), round(window, 1))
        ttl = settings.weather_cache_ttl
        now = time.monotonic()
        if ttl > 0:
            cached = self._cache.get(key)
            if cached and cached.expires_at > now:
                return cached.data

        async with self._lock:
            if ttl > 0:
                cached = self._cache.get(key)
                if cached and cached.expires_at > now:
                    return cached.data

            client = await self._get_client()
            station_url = await self._resolve_station(client, lat, lon)
            observations = await self._fetch_observations(client, station_url, window)
            if ttl > 0:
                self._cache[key] = CachedWeather(data=observations, expires_at=now + ttl)
            return observations

    async def _resolve_station(self, client: httpx.AsyncClient, lat: float, lon: float) -> str:
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

        station_url = station_features[0].get("id")
        if not station_url:
            raise RuntimeError("Station response missing identifier")
        return station_url

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
        }

weather_service = WeatherService()
