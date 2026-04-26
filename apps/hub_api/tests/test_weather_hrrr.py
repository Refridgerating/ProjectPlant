import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from services.weather_hrrr import HrrrRun, HrrrWeatherService, compute_target_run


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def test_compute_target_run_applies_publication_delay():
    when = _ts("2025-10-27T16:45:00")
    run = compute_target_run(when, availability_delay=timedelta(minutes=90), max_forecast_hour=18)
    assert run.cycle == _ts("2025-10-27T15:00:00")
    assert run.forecast_hour == 1
    assert run.valid_time == _ts("2025-10-27T16:00:00")


def test_compute_target_run_handles_naive_timestamp():
    when = datetime(2025, 10, 27, 3, 5, 0)
    run = compute_target_run(when, availability_delay=timedelta(minutes=75), max_forecast_hour=18)
    assert run.cycle.tzinfo is timezone.utc
    assert run.valid_time.tzinfo is timezone.utc


def test_compute_target_run_respects_max_forecast_hour():
    when = _ts("2025-10-27T20:10:00")
    run = compute_target_run(when, availability_delay=timedelta(hours=10), max_forecast_hour=3)
    assert run == HrrrRun(cycle=_ts("2025-10-27T17:00:00"), forecast_hour=3)


def test_compute_target_run_prefers_recent_available_cycle():
    when = datetime(2025, 10, 27, 8, 5, 0, tzinfo=timezone.utc)
    run = compute_target_run(when, availability_delay=timedelta(minutes=30), max_forecast_hour=18)
    assert run.cycle == datetime(2025, 10, 27, 7, 0, 0, tzinfo=timezone.utc)
    assert run.forecast_hour == 1
    assert run.valid_time == datetime(2025, 10, 27, 8, 0, 0, tzinfo=timezone.utc)


def test_build_filtered_request_targets_dswrf_only(tmp_path):
    service = HrrrWeatherService(cache_dir=tmp_path, solar_history_db=tmp_path / "solar.sqlite")
    run = HrrrRun(cycle=_ts("2025-10-27T12:00:00"), forecast_hour=2)

    url, params = service._build_filtered_request(run, 38.9072, -77.0369)

    assert url.endswith("/cgi-bin/filter_hrrr_2d.pl")
    assert params["file"] == "hrrr.t12z.wrfsfcf02.grib2"
    assert params["dir"] == "/hrrr.20251027/conus"
    assert params["var_DSWRF"] == "on"
    assert params["lev_surface"] == "on"
    assert "toplat" in params
    assert "leftlon" in params


def test_convert_values_only_populates_total_solar(tmp_path):
    service = HrrrWeatherService(cache_dir=tmp_path, solar_history_db=tmp_path / "solar.sqlite")
    cycle = _ts("2025-10-27T12:00:00")
    run = HrrrRun(cycle=cycle, forecast_hour=2)

    sample = service._convert_values(run, {"solar_down_w_m2": 550.0}, lat=38.9072, lon=-77.0369)

    assert sample.temperature_c is None
    assert sample.humidity_pct is None
    assert sample.wind_speed_m_s is None
    assert sample.pressure_hpa is None
    assert sample.solar_radiation_w_m2 == 550.0
    assert sample.solar_radiation_diffuse_w_m2 is None
    assert sample.metadata["lat"] == round(38.9072, 5)
    assert sample.metadata["lon"] == round(-77.0369, 5)


@pytest.mark.anyio
async def test_refresh_point_records_fetch_history_and_store(tmp_path, monkeypatch):
    service = HrrrWeatherService(cache_dir=tmp_path, solar_history_db=tmp_path / "solar.sqlite")

    async def _download_stub(self, run, lat, lon, target):
        target.write_bytes(b"data")

    def _extract_stub(self, grib_file, lat, lon):
        return {"solar_down_w_m2": 250.0}

    monkeypatch.setattr(service, "_download_grib", _download_stub.__get__(service, HrrrWeatherService))
    monkeypatch.setattr(service, "_extract_point_fields", _extract_stub.__get__(service, HrrrWeatherService))

    when = datetime.now(timezone.utc)
    sample = await service.refresh_point(38.9, -77.0, persist=False, when=when)
    history = await service.fetch_history(limit=1)
    stored = service._solar_store.get(38.9, -77.0, sample.run.valid_time)

    assert history
    assert history[-1]["status"] == "success"
    assert history[-1]["persisted"] is False
    assert history[-1]["run_cycle"] is not None
    assert stored is not None
    assert stored.solar_radiation_w_m2 == pytest.approx(250.0)
    assert service._fetch_log_path.exists()


@pytest.mark.anyio
async def test_refresh_point_reuses_stored_hour_without_redownload(tmp_path, monkeypatch):
    service = HrrrWeatherService(cache_dir=tmp_path, solar_history_db=tmp_path / "solar.sqlite")
    download_calls = 0

    async def _download_stub(self, run, lat, lon, target):
        nonlocal download_calls
        download_calls += 1
        target.write_bytes(b"data")

    def _extract_stub(self, grib_file, lat, lon):
        return {"solar_down_w_m2": 275.0}

    monkeypatch.setattr(service, "_download_grib", _download_stub.__get__(service, HrrrWeatherService))
    monkeypatch.setattr(service, "_extract_point_fields", _extract_stub.__get__(service, HrrrWeatherService))

    when = datetime.now(timezone.utc)
    first = await service.refresh_point(38.9, -77.0, persist=False, when=when)
    second = await service.refresh_point(38.9, -77.0, persist=False, when=when)

    assert download_calls == 1
    assert first.solar_radiation_w_m2 == second.solar_radiation_w_m2 == pytest.approx(275.0)


@pytest.mark.anyio
async def test_set_active_location_triggers_refresh_only_when_hrrr_key_changes(tmp_path, monkeypatch):
    service = HrrrWeatherService(
        cache_dir=tmp_path / "cache",
        solar_history_db=tmp_path / "solar.sqlite",
        active_location_path=tmp_path / "active_location.json",
    )
    monkeypatch.setattr("services.weather_hrrr.settings.hrrr_enabled", True)
    calls: list[str] = []

    async def _refresh_stub() -> None:
        calls.append("refresh")

    monkeypatch.setattr(service, "_refresh_default_in_background", _refresh_stub)

    await service.set_active_location(
        lat=38.90001,
        lon=-77.00001,
        accuracy_m=10.0,
        source="browser_geolocation",
        observed_at=datetime.now(timezone.utc),
    )
    await asyncio.sleep(0)
    await service.set_active_location(
        lat=38.90004,
        lon=-77.00004,
        accuracy_m=8.0,
        source="browser_geolocation",
        observed_at=datetime.now(timezone.utc),
    )
    await asyncio.sleep(0)
    await service.set_active_location(
        lat=38.9123,
        lon=-77.015,
        accuracy_m=8.0,
        source="browser_geolocation",
        observed_at=datetime.now(timezone.utc),
    )
    await asyncio.sleep(0)

    active_location = await service.get_active_location()

    assert calls == ["refresh", "refresh"]
    assert active_location is not None
    assert active_location.lat == pytest.approx(38.9123)
    assert active_location.lon == pytest.approx(-77.015)


@pytest.mark.anyio
async def test_cache_eviction_removes_stale_files(tmp_path):
    cache_dir = tmp_path / "hrrr"
    service = HrrrWeatherService(
        cache_dir=cache_dir,
        solar_history_db=tmp_path / "solar.sqlite",
        cache_max_age=timedelta(minutes=1),
    )

    old_file = cache_dir / "old.grib2"
    new_file = cache_dir / "new.grib2"
    old_file.parent.mkdir(parents=True, exist_ok=True)
    new_file.parent.mkdir(parents=True, exist_ok=True)
    old_file.write_bytes(b"old")
    new_file.write_bytes(b"new")
    old_meta = service._metadata_path(old_file)
    new_meta = service._metadata_path(new_file)
    old_meta.write_text("{}")
    new_meta.write_text("{}")

    stale_ts = (datetime.now(timezone.utc) - timedelta(hours=2)).timestamp()
    old_file.touch()
    old_meta.touch()
    old_file.write_bytes(b"old")
    old_meta.write_text("{}")
    old_file_stat_time = stale_ts
    import os

    os.utime(old_file, (old_file_stat_time, old_file_stat_time))
    os.utime(old_meta, (old_file_stat_time, old_file_stat_time))

    await service._maybe_cleanup_cache()

    assert not old_file.exists()
    assert not old_meta.exists()
    assert new_file.exists()
    assert new_meta.exists()
