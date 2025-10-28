from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from api.v1 import weather_router
from services.weather_hrrr import HrrrDataUnavailable, HrrrRun, HrrrSample


class _StubHrrrService:
    def __init__(self, sample: HrrrSample | None = None, error: Exception | None = None) -> None:
        self._sample = sample
        self._error = error
        self.latest_calls: list[tuple[float, float]] = []
        self.refresh_calls: list[tuple[float, float]] = []

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


def _build_sample(valid_time: datetime | None = None) -> HrrrSample:
    cycle = datetime(2025, 10, 28, 14, 0, tzinfo=timezone.utc)
    if valid_time is None:
        valid_time = cycle + timedelta(hours=2)
    run = HrrrRun(cycle=cycle, forecast_hour=int((valid_time - cycle).total_seconds() // 3600))
    return HrrrSample(
        run=run,
        temperature_c=18.5,
        humidity_pct=55.0,
        wind_speed_m_s=4.2,
        pressure_hpa=1017.0,
        solar_radiation_w_m2=320.0,
        solar_radiation_diffuse_w_m2=120.0,
        solar_radiation_direct_w_m2=200.0,
        solar_radiation_clear_w_m2=340.0,
        solar_radiation_clear_up_w_m2=50.0,
        metadata={"lat": 38.9072, "lon": -77.0369},
    )


@pytest.fixture(autouse=True)
def _ensure_hrrr_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(weather_router.settings, "hrrr_enabled", True)


def test_weather_endpoint_returns_hrrr_series(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    sample = _build_sample(datetime(2025, 10, 28, 16, 0, tzinfo=timezone.utc))

    async def _fake_collect(lat: float, lon: float, hours: float, *, seed_sample: HrrrSample):
        entries = []
        for offset in range(3):
            run_time = sample.run.valid_time - timedelta(hours=offset)
            derived = _build_sample(run_time)
            entries.append(weather_router._telemetry_from_hrrr(derived))
        entries.sort(key=lambda entry: entry.timestamp or "")
        return entries, None

    stub_hrrr = _StubHrrrService(sample=sample)
    monkeypatch.setattr(weather_router, "hrrr_weather_service", stub_hrrr)
    monkeypatch.setattr(weather_router, "_collect_hrrr_series", _fake_collect)

    response = client.get(
        "/api/v1/weather/local",
        params={"lat": 38.9072, "lon": -77.0369, "hours": 24},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["hrrr_used"] is True
    assert payload["hrrr_error"] is None
    assert payload["station"] == {
        "id": "hrrr",
        "name": "NOAA HRRR Forecast",
        "identifier": "HRRR",
        "lat": 38.9072,
        "lon": -77.0369,
        "distance_km": None,
    }
    assert payload["sources"] == ["noaa_hrrr"]
    assert len(payload["data"]) == 3
    timestamps = [entry["timestamp"] for entry in payload["data"]]
    assert timestamps == sorted(timestamps)
    assert stub_hrrr.latest_calls
    assert stub_hrrr.refresh_calls == []


def test_weather_endpoint_surfaces_history_error(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    sample = _build_sample()
    async def _fake_collect(lat: float, lon: float, hours: float, *, seed_sample: HrrrSample):
        entry = weather_router._telemetry_from_hrrr(seed_sample)
        return [entry], "partial failure"

    stub_hrrr = _StubHrrrService(sample=sample)
    monkeypatch.setattr(weather_router, "hrrr_weather_service", stub_hrrr)
    monkeypatch.setattr(weather_router, "_collect_hrrr_series", _fake_collect)

    response = client.get(
        "/api/v1/weather/local",
        params={"lat": 38.0, "lon": -77.0, "hours": 6},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["hrrr_used"] is True
    assert payload["hrrr_error"] == "partial failure"
    assert len(payload["data"]) == 1


def test_weather_endpoint_returns_503_when_hrrr_disabled(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    monkeypatch.setattr(weather_router.settings, "hrrr_enabled", False)

    response = client.get("/api/v1/weather/local", params={"lat": 38.9, "lon": -77.0, "hours": 6})

    assert response.status_code == 503
    assert response.json()["detail"] == "HRRR integration disabled"


def test_weather_endpoint_returns_503_when_hrrr_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    error = HrrrDataUnavailable("HRRR grid not ready")
    stub_hrrr = _StubHrrrService(sample=None, error=error)

    monkeypatch.setattr(weather_router, "hrrr_weather_service", stub_hrrr)

    response = client.get("/api/v1/weather/local", params={"lat": 38.9, "lon": -77.0, "hours": 6})

    assert response.status_code == 503
    assert response.json()["detail"] == str(error)
    assert stub_hrrr.latest_calls
