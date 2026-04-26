import json
import os
from pathlib import Path

from services.weather import cache as weather_cache


def _write(path: Path, content: str = "data") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_collect_cache_entries_pairs_grib_metadata_and_sorts(tmp_path: Path) -> None:
    grib = _write(tmp_path / "hrrr.20251028" / "conus" / "hrrr.t16z.wrfsfcf01.grib2")
    metadata = {
        "cycle": "2025-10-28T16:00:00Z",
        "forecast_hour": 1,
        "valid_time": "2025-10-28T17:00:00Z",
        "domain": "conus",
    }
    _write(grib.with_suffix(grib.suffix + ".json"), json.dumps(metadata))
    older = _write(tmp_path / "fetch_status.jsonl", "{}\n")
    os.utime(older, (1_700_000_000, 1_700_000_000))
    os.utime(grib, (1_700_000_100, 1_700_000_100))

    payload = weather_cache.collect_cache_entries(tmp_path, limit=10, order="largest")

    grib_entry = next(entry for entry in payload["entries"] if entry["kind"] == "grib")
    assert grib_entry["path"] == "hrrr.20251028/conus/hrrr.t16z.wrfsfcf01.grib2"
    assert grib_entry["has_metadata"] is True
    assert grib_entry["cycle"] == "2025-10-28T16:00:00Z"
    assert grib_entry["forecast_hour"] == 1
    assert payload["total_files"] == 3


def test_delete_cache_entries_rejects_traversal_and_deletes_metadata(tmp_path: Path) -> None:
    grib = _write(tmp_path / "run.grib2")
    metadata = _write(tmp_path / "run.grib2.json", "{}")

    result = weather_cache.delete_cache_entries(
        tmp_path,
        ["../outside.grib2", "run.grib2"],
        include_metadata=True,
        invalid_status="invalid",
    )

    assert result["processed"] == 2
    assert result["details"][0]["status"] == "invalid"
    assert not grib.exists()
    assert not metadata.exists()


def test_store_cache_entries_moves_metadata_and_preserves_health_count(tmp_path: Path) -> None:
    cache_dir = tmp_path / "cache"
    archive_dir = tmp_path / "archive"
    grib = _write(cache_dir / "run.grib2", "grib")
    metadata = _write(cache_dir / "run.grib2.json", "{}")

    result = weather_cache.store_cache_entries(
        cache_dir,
        archive_dir,
        ["run.grib2"],
        include_metadata=True,
        label="Sample Label",
        count_metadata_processed=False,
    )

    assert result["processed"] == 1
    assert result["label"] == "Sample-Label"
    assert not grib.exists()
    assert not metadata.exists()
    assert any(detail["path"] == "run.grib2" and detail["status"] == "stored" for detail in result["details"])
    assert any(detail["path"] == "run.grib2.json" and detail["status"] == "stored" for detail in result["details"])


def test_scan_solar_history_store_empty_db(tmp_path: Path) -> None:
    stats = weather_cache.scan_solar_history_store(tmp_path / "solar.sqlite", retention_hours=72.0)

    assert stats["db_path"].endswith("solar.sqlite")
    assert stats["row_count"] == 0
    assert stats["retention_hours"] == 72.0
