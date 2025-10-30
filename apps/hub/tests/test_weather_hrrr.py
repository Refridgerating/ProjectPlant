import os
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


def test_convert_values_transforms_units_and_metadata(tmp_path):
    service = HrrrWeatherService(cache_dir=tmp_path)
    cycle = _ts("2025-10-27T12:00:00")
    run = HrrrRun(cycle=cycle, forecast_hour=2)
    raw = {
        "temperature_k": 295.25,
        "humidity_pct": 45.0,
        "wind_u": 3.0,
        "wind_v": 4.0,
        "pressure_pa": 101325.0,
        "solar_down_w_m2": 550.0,
        "solar_diffuse_w_m2": 120.0,
        "solar_direct_w_m2": 410.0,
        "solar_clear_w_m2": 600.0,
        "solar_clear_up_w_m2": 35.0,
    }

    sample = service._convert_values(run, raw, lat=38.9072, lon=-77.0369)

    assert pytest.approx(sample.temperature_c, rel=1e-3) == 22.10
    assert pytest.approx(sample.wind_speed_m_s, rel=1e-6) == 5.0
    assert pytest.approx(sample.pressure_hpa, rel=1e-6) == 1013.25
    assert sample.solar_radiation_w_m2 == 550.0
    assert sample.solar_radiation_diffuse_w_m2 == 120.0
    assert sample.solar_radiation_direct_w_m2 == 410.0
    assert sample.solar_radiation_clear_w_m2 == 600.0
    assert sample.solar_radiation_clear_up_w_m2 == 35.0
    assert sample.metadata["lat"] == round(38.9072, 5)
    assert sample.metadata["lon"] == round(-77.0369, 5)


@pytest.mark.anyio
async def test_refresh_point_records_fetch_history(tmp_path, monkeypatch):
    service = HrrrWeatherService(cache_dir=tmp_path)
    grib_path = tmp_path / "mock.grib2"
    grib_path.parent.mkdir(parents=True, exist_ok=True)
    grib_path.write_bytes(b"data")

    async def _ensure_grib_stub(self, run):
        return grib_path

    def _extract_stub(self, grib_file, lat, lon):
        return {
            "temperature_k": 298.0,
            "humidity_pct": 40.0,
            "wind_u": 0.0,
            "wind_v": 0.0,
            "pressure_pa": 101000.0,
            "solar_down_w_m2": 250.0,
            "solar_diffuse_w_m2": 90.0,
            "solar_direct_w_m2": 180.0,
            "solar_clear_w_m2": 260.0,
            "solar_clear_up_w_m2": 20.0,
        }

    monkeypatch.setattr(service, "_ensure_grib", _ensure_grib_stub.__get__(service, HrrrWeatherService))
    monkeypatch.setattr(service, "_extract_point_fields", _extract_stub.__get__(service, HrrrWeatherService))

    await service.refresh_point(38.9, -77.0, persist=False)
    history = await service.fetch_history(limit=1)
    assert history
    last_entry = history[-1]
    assert last_entry["status"] == "success"
    assert last_entry["persisted"] is False
    assert last_entry["run_cycle"] is not None
    assert service._fetch_log_path.exists()


@pytest.mark.anyio
async def test_refresh_point_failure_is_logged(tmp_path, monkeypatch):
    service = HrrrWeatherService(cache_dir=tmp_path)
    grib_path = tmp_path / "fail.grib2"
    grib_path.parent.mkdir(parents=True, exist_ok=True)
    grib_path.write_bytes(b"data")

    async def _ensure_grib_stub(self, run):
        return grib_path

    def _extract_stub(self, grib_file, lat, lon):
        raise RuntimeError("boom")

    monkeypatch.setattr(service, "_ensure_grib", _ensure_grib_stub.__get__(service, HrrrWeatherService))
    monkeypatch.setattr(service, "_extract_point_fields", _extract_stub.__get__(service, HrrrWeatherService))

    with pytest.raises(RuntimeError):
        await service.refresh_point(38.0, -77.0, persist=True)

    history = await service.fetch_history(limit=1)
    assert history[-1]["status"] == "error"
    assert history[-1]["persisted"] is False


@pytest.mark.anyio
async def test_cache_eviction_removes_stale_files(tmp_path):
    cache_dir = tmp_path / "hrrr"
    service = HrrrWeatherService(cache_dir=cache_dir, cache_max_age=timedelta(minutes=1))

    old_file = cache_dir / "hrrr.20250101" / "conus" / "old.grib2"
    new_file = cache_dir / "hrrr.20250102" / "conus" / "new.grib2"
    old_file.parent.mkdir(parents=True, exist_ok=True)
    new_file.parent.mkdir(parents=True, exist_ok=True)
    old_file.write_bytes(b"old")
    new_file.write_bytes(b"new")
    old_meta = service._metadata_path(old_file)
    new_meta = service._metadata_path(new_file)
    old_meta.write_text("{}")
    new_meta.write_text("{}")

    stale_ts = (datetime.now(timezone.utc) - timedelta(hours=2)).timestamp()
    os.utime(old_file, (stale_ts, stale_ts))
    os.utime(old_meta, (stale_ts, stale_ts))

    await service._maybe_cleanup_cache()

    assert not old_file.exists()
    assert not old_meta.exists()
    assert new_file.exists()
    assert new_meta.exists()
