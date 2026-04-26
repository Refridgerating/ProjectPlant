from datetime import datetime, timedelta, timezone

from services.hrrr_solar_history import HrrrSolarHistoryStore


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def test_hrrr_solar_history_store_range_and_prune(tmp_path):
    store = HrrrSolarHistoryStore(db_path=tmp_path / "solar.sqlite", retention_hours=72)

    older = store.upsert(
        lat=38.9,
        lon=-77.0,
        valid_time=_ts("2025-10-24T12:00:00"),
        solar_radiation_w_m2=200.0,
        run_cycle=_ts("2025-10-24T11:00:00"),
        forecast_hour=1,
    )
    newer = store.upsert(
        lat=38.9,
        lon=-77.0,
        valid_time=_ts("2025-10-27T12:00:00"),
        solar_radiation_w_m2=450.0,
        run_cycle=_ts("2025-10-27T11:00:00"),
        forecast_hour=1,
    )

    rows = store.list_range(
        38.9,
        -77.0,
        start=_ts("2025-10-24T00:00:00"),
        end=_ts("2025-10-27T23:00:00"),
    )
    assert [row.valid_time for row in rows] == [older.valid_time, newer.valid_time]

    removed = store.prune(now=_ts("2025-10-27T13:00:00"))
    assert removed == 1

    remaining = store.list_range(
        38.9,
        -77.0,
        start=_ts("2025-10-24T00:00:00"),
        end=_ts("2025-10-27T23:00:00"),
    )
    assert [row.valid_time for row in remaining] == [newer.valid_time]
