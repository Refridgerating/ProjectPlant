from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from api.v1 import weather_router
from services.hrrr_active_location import HrrrActiveLocation
from services.weather_hrrr import HrrrDataUnavailable, HrrrRun, HrrrSample


class _PointStubHrrrService:
    def __init__(
        self,
        sample: HrrrSample | None = None,
        error: Exception | None = None,
        active_location: HrrrActiveLocation | None = None,
    ) -> None:
        self._sample = sample
        self._error = error
        self._active_location = active_location
        self.latest_calls: list[tuple[float, float]] = []
        self.refresh_calls: list[tuple[float, float]] = []
        self.set_location_calls: list[tuple[float, float]] = []

    async def latest_for(self, lat: float, lon: float) -> HrrrSample | None:
        self.latest_calls.append((lat, lon))
        if self._error is not None:
            raise self._error
        return self._sample

    async def refresh_point(
        self,
        lat: float,
        lon: float,
        *,
        persist: bool = False,
        when: datetime | None = None,
    ) -> HrrrSample:
        self.refresh_calls.append((lat, lon))
        if self._error is not None:
            raise self._error
        if self._sample is None:
            raise RuntimeError("No sample configured for refresh")
        return self._sample

    async def get_active_location(self) -> HrrrActiveLocation | None:
        return self._active_location

    async def set_active_location(
        self,
        *,
        lat: float,
        lon: float,
        accuracy_m: float | None,
        source: str,
        observed_at: datetime | None = None,
    ) -> HrrrActiveLocation:
        self.set_location_calls.append((lat, lon))
        self._active_location = HrrrActiveLocation(
            lat=lat,
            lon=lon,
            accuracy_m=accuracy_m,
            source=source,
            observed_at=observed_at,
            updated_at=observed_at or datetime.now(timezone.utc),
        )
        return self._active_location


def _build_sample(valid_time: datetime, solar: float = 320.0) -> HrrrSample:
    cycle = valid_time - timedelta(hours=1)
    run = HrrrRun(cycle=cycle, forecast_hour=1)
    return HrrrSample(
        run=run,
        temperature_c=None,
        humidity_pct=None,
        wind_speed_m_s=None,
        pressure_hpa=None,
        solar_radiation_w_m2=solar,
        solar_radiation_diffuse_w_m2=None,
        solar_radiation_direct_w_m2=None,
        solar_radiation_clear_w_m2=None,
        solar_radiation_clear_up_w_m2=None,
        metadata={"lat": 38.9072, "lon": -77.0369},
    )


def _build_active_location(
    *,
    lat: float = 38.9072,
    lon: float = -77.0369,
    source: str = "browser_geolocation",
) -> HrrrActiveLocation:
    return HrrrActiveLocation(
        lat=lat,
        lon=lon,
        accuracy_m=12.0,
        source=source,
        observed_at=datetime(2026, 3, 17, 22, 0, tzinfo=timezone.utc),
        updated_at=datetime(2026, 3, 17, 22, 1, tzinfo=timezone.utc),
    )


@pytest.fixture(autouse=True)
def _ensure_hrrr_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(weather_router.settings, "hrrr_enabled", True)


def test_weather_endpoint_returns_station_series_with_hrrr_solar_overlay(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    sample = _build_sample(datetime(2025, 5, 12, 15, 0, tzinfo=timezone.utc), solar=510.0)

    async def _fake_collect(lat: float, lon: float, hours: float):
        return [sample], None

    monkeypatch.setattr(weather_router.weather_service, "collect_hrrr_series", _fake_collect)

    response = client.get(
        "/api/v1/weather/local",
        params={"lat": 38.9072, "lon": -77.0369, "hours": 6},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["blend_mode"] == "station_hrrr_solar"
    assert payload["hrrr_used"] is True
    assert payload["hrrr_error"] is None
    assert payload["station"]["identifier"] == "KDCA"
    assert payload["sources"] == ["noaa_nws", "noaa_hrrr"]
    entry = payload["data"][0]
    assert entry["temperature_c"] == pytest.approx(22.0)
    assert entry["humidity_pct"] == pytest.approx(60.0)
    assert entry["solar_radiation_w_m2"] == pytest.approx(510.0)
    assert entry["source"] == "noaa_nws,noaa_hrrr"


def test_weather_endpoint_partial_hrrr_gaps_leave_station_fields_and_null_solar(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    station_info = {
        "id": "https://api.weather.gov/stations/KXYZ",
        "name": "Mock Station",
        "identifier": "KXYZ",
        "lat": 38.851,
        "lon": -77.04,
        "distance_km": 6.227,
    }
    observations = [
        {
            "timestamp": "2025-10-28T15:00:00Z",
            "station": "https://api.weather.gov/stations/KXYZ",
            "temperature_c": 21.0,
            "humidity_pct": 62.0,
            "pressure_hpa": 1008.0,
            "solar_radiation_w_m2": 430.0,
            "wind_speed_m_s": 4.0,
            "source": "noaa_nws",
        },
        {
            "timestamp": "2025-10-28T16:00:00Z",
            "station": "https://api.weather.gov/stations/KXYZ",
            "temperature_c": 22.0,
            "humidity_pct": 58.0,
            "pressure_hpa": 1007.5,
            "solar_radiation_w_m2": 440.0,
            "wind_speed_m_s": 4.5,
            "source": "noaa_nws",
        },
    ]
    sample = _build_sample(datetime(2025, 10, 28, 16, 0, tzinfo=timezone.utc), solar=610.0)

    async def _fake_get_observations(lat: float, lon: float, hours: float):
        return observations, station_info

    async def _fake_collect(lat: float, lon: float, hours: float):
        return [sample], "partial history unavailable"

    monkeypatch.setattr(weather_router.weather_service.provider, "get_observations", _fake_get_observations)
    monkeypatch.setattr(weather_router.weather_service, "collect_hrrr_series", _fake_collect)

    response = client.get("/api/v1/weather/local", params={"lat": 38.85, "lon": -77.04, "hours": 6})

    assert response.status_code == 200
    payload = response.json()
    assert payload["blend_mode"] == "station_hrrr_solar"
    assert payload["hrrr_used"] is True
    assert payload["hrrr_error"] == "partial history unavailable"
    assert payload["sources"] == ["noaa_nws", "noaa_hrrr"]
    first, second = payload["data"]
    assert first["temperature_c"] == pytest.approx(21.0)
    assert first["wind_speed_m_s"] == pytest.approx(4.0)
    assert first["solar_radiation_w_m2"] is None
    assert first["source"] == "noaa_nws"
    assert second["temperature_c"] == pytest.approx(22.0)
    assert second["solar_radiation_w_m2"] == pytest.approx(610.0)
    assert second["source"] == "noaa_nws,noaa_hrrr"


def test_weather_endpoint_uses_station_when_hrrr_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    async def _raise_hrrr(lat: float, lon: float, hours: float):
        raise HrrrDataUnavailable("HRRR grid not ready")

    monkeypatch.setattr(weather_router.weather_service, "collect_hrrr_series", _raise_hrrr)

    response = client.get("/api/v1/weather/local", params={"lat": 38.9072, "lon": -77.0369, "hours": 6})

    assert response.status_code == 200
    payload = response.json()
    assert payload["blend_mode"] == "station"
    assert payload["hrrr_used"] is False
    assert payload["hrrr_error"] == "HRRR grid not ready"
    assert payload["station"]["identifier"] == "KDCA"
    assert payload["sources"] == ["noaa_nws"]


def test_weather_endpoint_uses_station_when_hrrr_disabled(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    monkeypatch.setattr(weather_router.settings, "hrrr_enabled", False)

    response = client.get("/api/v1/weather/local", params={"lat": 38.9072, "lon": -77.0369, "hours": 6})

    assert response.status_code == 200
    payload = response.json()
    assert payload["blend_mode"] == "station"
    assert payload["hrrr_used"] is False
    assert payload["hrrr_error"] == "HRRR integration disabled"
    assert payload["station"]["identifier"] == "KDCA"
    assert payload["sources"] == ["noaa_nws"]
    assert payload["requested_hours"] == pytest.approx(6.0)


def test_hrrr_point_endpoint_only_populates_total_solar(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    sample = _build_sample(datetime(2025, 10, 28, 16, 0, tzinfo=timezone.utc), solar=480.0)
    stub = _PointStubHrrrService(sample=sample)

    monkeypatch.setattr(weather_router.weather_service, "hrrr_service", stub)

    response = client.get(
        "/api/v1/weather/hrrr/point",
        params={"lat": 38.9072, "lon": -77.0369, "refresh": "false"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["fields"]["solar_radiation_w_m2"] == pytest.approx(480.0)
    assert payload["fields"]["solar_radiation_mj_m2_h"] == pytest.approx(480.0 * weather_router.SOLAR_W_TO_MJ)
    assert payload["fields"]["temperature_c"] is None
    assert payload["fields"]["solar_radiation_diffuse_w_m2"] is None
    assert stub.latest_calls
    assert not stub.refresh_calls


def test_weather_location_endpoints_round_trip_active_location(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    stub = _PointStubHrrrService(active_location=None)

    monkeypatch.setattr(weather_router.weather_service, "hrrr_service", stub)

    put_response = client.put(
        "/api/v1/weather/location",
        json={
            "lat": 38.944184,
            "lon": -77.062402,
            "accuracy_m": 14.0,
            "source": "browser_geolocation",
            "observed_at": "2026-03-17T22:13:00Z",
        },
    )

    assert put_response.status_code == 200
    put_payload = put_response.json()
    assert put_payload["lat"] == pytest.approx(38.944184)
    assert put_payload["lon"] == pytest.approx(-77.062402)
    assert put_payload["source"] == "browser_geolocation"
    assert stub.set_location_calls == [(38.944184, -77.062402)]

    get_response = client.get("/api/v1/weather/location")

    assert get_response.status_code == 200
    get_payload = get_response.json()
    assert get_payload["lat"] == pytest.approx(38.944184)
    assert get_payload["lon"] == pytest.approx(-77.062402)
    assert get_payload["source"] == "browser_geolocation"


def test_hrrr_refresh_uses_active_location_when_lat_lon_omitted(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    sample = _build_sample(datetime(2025, 10, 28, 16, 0, tzinfo=timezone.utc), solar=500.0)
    active_location = _build_active_location(lat=38.944184, lon=-77.062402)
    stub = _PointStubHrrrService(sample=sample, active_location=active_location)

    monkeypatch.setattr(weather_router.weather_service, "hrrr_service", stub)

    response = client.post("/api/v1/weather/hrrr/refresh")

    assert response.status_code == 200
    payload = response.json()
    assert payload["location"]["lat"] == pytest.approx(38.94418, abs=1e-5)
    assert payload["location"]["lon"] == pytest.approx(-77.0624, abs=1e-5)
    assert stub.refresh_calls == [(38.944184, -77.062402)]


def test_hrrr_status_exposes_solar_store_metrics(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    async def _status_stub(*, history_limit: int):
        return {
            "enabled": True,
            "scheduler_running": True,
            "refresh_interval_minutes": 60.0,
            "selected_refresh_minutes": 60.0,
            "refresh_options": [15.0, 60.0],
            "default_location": {"lat": 38.9, "lon": -77.0},
            "location_source": "browser_geolocation",
            "location_observed_at": "2025-10-28T15:59:00Z",
            "location_updated_at": "2025-10-28T16:01:00Z",
            "last_refresh": "2025-10-28T16:05:00Z",
            "last_valid_time": "2025-10-28T16:00:00Z",
            "cache_dir": "data/hrrr/cache",
            "domain": "conus",
            "cached_points": 1,
            "fetch_log_path": "data/hrrr/cache/fetch_status.jsonl",
            "solar_history_db": "data/hrrr/solar_history.sqlite",
            "solar_history_bytes": 8192,
            "solar_history_rows": 24,
            "solar_retention_hours": 72.0,
            "solar_oldest_valid_time": "2025-10-27T17:00:00Z",
            "solar_newest_valid_time": "2025-10-28T16:00:00Z",
            "recent_fetches": [],
        }

    async def _latest_default_stub():
        return None

    monkeypatch.setattr(weather_router.weather_service.hrrr_service, "status", _status_stub)
    monkeypatch.setattr(weather_router.weather_service.hrrr_service, "latest_default", _latest_default_stub)

    response = client.get("/api/v1/weather/hrrr/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["solar_history_db"] == "data/hrrr/solar_history.sqlite"
    assert payload["solar_history_rows"] == 24
    assert payload["solar_retention_hours"] == pytest.approx(72.0)
    assert payload["location_source"] == "browser_geolocation"
    assert payload["location_observed_at"] == "2025-10-28T15:59:00Z"
    assert payload["location_updated_at"] == "2025-10-28T16:01:00Z"


def test_weather_endpoint_returns_504_when_station_fetch_times_out(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    async def _raise_timeout(lat: float, lon: float, hours: float):
        raise httpx.TimeoutException("weather.gov timed out")

    monkeypatch.setattr(weather_router.settings, "hrrr_enabled", False)
    monkeypatch.setattr(weather_router.weather_service.provider, "get_observations", _raise_timeout)

    response = client.get("/api/v1/weather/local", params={"lat": 38.85, "lon": -77.04, "hours": 6})

    assert response.status_code == 504
    assert response.json()["detail"] == "Upstream weather provider timed out"


def test_weather_endpoint_returns_502_when_station_fetch_fails(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    async def _raise_request_error(lat: float, lon: float, hours: float):
        raise httpx.RequestError("weather.gov request failed")

    monkeypatch.setattr(weather_router.settings, "hrrr_enabled", False)
    monkeypatch.setattr(weather_router.weather_service.provider, "get_observations", _raise_request_error)

    response = client.get("/api/v1/weather/local", params={"lat": 38.85, "lon": -77.04, "hours": 6})

    assert response.status_code == 502
    assert response.json()["detail"] == "Failed to load upstream weather observations"
