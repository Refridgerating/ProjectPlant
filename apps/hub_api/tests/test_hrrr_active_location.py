from datetime import datetime, timezone

from services.hrrr_active_location import HrrrActiveLocationStore
from services.weather_hrrr import HrrrWeatherService


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def test_hrrr_active_location_store_overwrites_atomically(tmp_path):
    store = HrrrActiveLocationStore(tmp_path / "active_location.json")

    first = store.upsert(
        lat=38.9,
        lon=-77.0,
        accuracy_m=24.0,
        source="browser_geolocation",
        observed_at=_ts("2026-03-17T21:00:00"),
        updated_at=_ts("2026-03-17T21:01:00"),
    )
    second = store.upsert(
        lat=38.944184,
        lon=-77.062402,
        accuracy_m=12.0,
        source="browser_geolocation",
        observed_at=_ts("2026-03-17T22:00:00"),
        updated_at=_ts("2026-03-17T22:01:00"),
    )

    loaded = store.get()

    assert first.lat == 38.9
    assert loaded is not None
    assert loaded.lat == second.lat
    assert loaded.lon == second.lon
    assert loaded.accuracy_m == second.accuracy_m
    assert loaded.source == "browser_geolocation"


def test_hrrr_weather_service_prefers_persisted_active_location_over_env_fallback(tmp_path, monkeypatch):
    store = HrrrActiveLocationStore(tmp_path / "active_location.json")
    persisted = store.upsert(
        lat=47.6097,
        lon=-122.3331,
        accuracy_m=18.0,
        source="browser_geolocation",
        observed_at=_ts("2026-03-17T19:00:00"),
        updated_at=_ts("2026-03-17T19:01:00"),
    )
    monkeypatch.setattr("services.weather_hrrr.settings.hrrr_default_lat", 38.9)
    monkeypatch.setattr("services.weather_hrrr.settings.hrrr_default_lon", -77.0)

    service = HrrrWeatherService(
        cache_dir=tmp_path / "cache",
        solar_history_db=tmp_path / "solar.sqlite",
        active_location_path=tmp_path / "active_location.json",
    )

    assert service._active_location is not None
    assert service._active_location.lat == persisted.lat
    assert service._active_location.lon == persisted.lon
    assert service._active_location.source == "browser_geolocation"
