from __future__ import annotations

import asyncio
import csv
import gzip
import io
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest

from services.telemetry import telemetry_store
from services.plant_telemetry import PotTelemetryStore


@contextmanager
def _override_pot_store(tmp_path, filename: str, *, retention_hours: int, max_rows: int):
    from services import plant_telemetry as plant_telemetry_module
    from api.v1 import telemetry_router as telemetry_router_module

    test_store = PotTelemetryStore(
        db_path=tmp_path / filename,
        retention_hours=retention_hours,
        max_rows=max_rows,
    )
    original_service_store = plant_telemetry_module.plant_telemetry_store
    original_router_store = telemetry_router_module.plant_telemetry_store
    plant_telemetry_module.plant_telemetry_store = test_store
    telemetry_router_module.plant_telemetry_store = test_store
    try:
        yield test_store
    finally:
        plant_telemetry_module.plant_telemetry_store = original_service_store
        telemetry_router_module.plant_telemetry_store = original_router_store


@pytest.mark.anyio
async def test_telemetry_store_records_samples():
    await telemetry_store.clear()
    ts_older = datetime.now(timezone.utc) - timedelta(hours=1)
    ts_latest = datetime.now(timezone.utc)

    await telemetry_store.record_environment(timestamp=ts_older, temperature_c=21.5, humidity_pct=48.2)
    await telemetry_store.record_environment(
        timestamp=ts_latest,
        temperature_c=22.3,
        humidity_pct=49.1,
        pressure_hpa=1012.4,
        wind_speed_m_s=1.5,
    )

    samples = await telemetry_store.list_samples(hours=2)
    assert len(samples) == 2
    assert samples[0].temperature_c == pytest.approx(21.5)
    assert samples[1].pressure_hpa == pytest.approx(1012.4)


@pytest.mark.anyio
async def test_telemetry_store_latest_matching_prefers_fresh_sensor():
    await telemetry_store.clear()
    now = datetime.now(timezone.utc)

    await telemetry_store.record_environment(
        timestamp=now - timedelta(minutes=10),
        temperature_c=20.0,
        humidity_pct=55.0,
        source="sensor",
    )
    await telemetry_store.record_environment(
        timestamp=now - timedelta(minutes=5),
        temperature_c=21.0,
        humidity_pct=48.0,
        source="weather",
    )

    sensor_sample = await telemetry_store.latest_matching(
        source_filter=("sensor",),
        max_age=timedelta(minutes=15),
        require=("temperature_c", "humidity_pct"),
    )
    assert sensor_sample is not None
    assert sensor_sample.source == "sensor"

    stale_sensor = await telemetry_store.latest_matching(
        source_filter=("sensor",),
        max_age=timedelta(minutes=5),
        require=("temperature_c", "humidity_pct"),
    )
    assert stale_sensor is None

    fallback = await telemetry_store.latest_matching(
        max_age=timedelta(minutes=6),
        require=("temperature_c", "humidity_pct"),
    )
    assert fallback is not None
    assert fallback.source == "weather"


def test_get_live_telemetry_endpoint(client):
    asyncio.run(telemetry_store.clear())
    asyncio.run(telemetry_store.record_environment(temperature_c=23.4, humidity_pct=51.2))
    response = client.get("/api/v1/telemetry/live?hours=2&limit=10")
    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert len(payload["data"]) == 1
    first = payload["data"][0]
    assert first["temperature_c"] == pytest.approx(23.4)
    assert first["humidity_pct"] == pytest.approx(51.2)


@pytest.mark.anyio
async def test_pot_telemetry_store_round_trip(tmp_path):
    store = PotTelemetryStore(
        db_path=tmp_path / "pot.sqlite",
        retention_hours=24,
        max_rows=100,
    )
    await store.record(
        pot_id="pot-1",
        timestamp=None,
        timestamp_ms=None,
        moisture=47.8,
        temperature=22.1,
        humidity=51.3,
        valve_open=True,
        source="test",
    )
    await store.record(
        pot_id="pot-1",
        timestamp=None,
        timestamp_ms=None,
        moisture=48.2,
        temperature=22.0,
        humidity=51.0,
        valve_open=False,
        source="test",
    )

    samples = await store.list("pot-1", hours=2)
    assert len(samples) == 2
    assert samples[0]["moisture_pct"] == pytest.approx(47.8)
    assert samples[1]["valve_open"] is False


def test_get_pot_telemetry_endpoint(client, tmp_path):
    with _override_pot_store(tmp_path, "pot.sqlite", retention_hours=24, max_rows=100) as test_store:
        asyncio.run(
            test_store.record(
                pot_id="pot-42",
                    timestamp=None,
                    timestamp_ms=None,
                moisture=52.1,
                temperature=21.9,
                humidity=55.0,
                valve_open=False,
                source="test",
            )
        )
        response = client.get("/api/v1/telemetry/pots/pot-42?hours=4&limit=12000")
        assert response.status_code == 200
        payload = response.json()
        assert payload["count"] == 1
        sample = payload["data"][0]
        assert sample["moisture_pct"] == pytest.approx(52.1)
        assert sample["potId"] == "pot-42"


def test_get_pot_telemetry_accepts_minute_window(client, tmp_path):
    with _override_pot_store(tmp_path, "pot-minute.sqlite", retention_hours=24, max_rows=500) as test_store:
        asyncio.run(
            test_store.record(
                pot_id="pot-minute",
                timestamp=None,
                timestamp_ms=None,
                moisture=50.0,
                temperature=21.5,
                humidity=55.0,
                source="test",
            )
        )
        response = client.get("/api/v1/telemetry/pots/pot-minute?hours=0.02&limit=5")
        assert response.status_code == 200
        payload = response.json()
        assert payload["count"] == 1
        assert payload["data"][0]["potId"] == "pot-minute"


def test_export_pot_telemetry_csv(client, tmp_path):
    with _override_pot_store(tmp_path, "pot-export.sqlite", retention_hours=72, max_rows=500) as test_store:
        asyncio.run(
            test_store.record(
                pot_id="pot-export",
                timestamp=None,
                timestamp_ms=None,
                moisture=61.2,
                temperature=19.4,
                humidity=58.0,
                source="test",
            )
        )
        response = client.get("/api/v1/telemetry/pots/pot-export/export?hours=1")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/csv")
        disposition = response.headers["content-disposition"]
        assert disposition.endswith('pot-export-telemetry.csv"')

        csv_reader = csv.DictReader(io.StringIO(response.content.decode("utf-8")))
        rows = list(csv_reader)
        assert len(rows) == 1
        assert rows[0]["potId"] == "pot-export"
        assert rows[0]["moisture_pct"] == "61.2"


def test_export_pot_telemetry_csv_gzip(client, tmp_path):
    with _override_pot_store(tmp_path, "pot-export-gzip.sqlite", retention_hours=72, max_rows=500) as test_store:
        asyncio.run(
            test_store.record(
                pot_id="pot-export",
                timestamp=None,
                timestamp_ms=None,
                moisture=61.2,
                temperature=19.4,
                humidity=58.0,
                source="test",
            )
        )
        response = client.get("/api/v1/telemetry/pots/pot-export/export?hours=1&gzip=true")
        assert response.status_code == 200
        assert response.headers["content-encoding"] == "gzip"
        assert response.headers["content-disposition"].endswith('pot-export-telemetry.csv.gz"')

        body = response.content
        if body.startswith(b"\x1f\x8b"):
            csv_payload = gzip.decompress(body)
        else:
            # httpx auto-decompresses gzip responses, so fall back to raw bytes
            csv_payload = body
        csv_reader = csv.DictReader(io.StringIO(csv_payload.decode("utf-8")))
        rows = list(csv_reader)
        assert len(rows) == 1
        assert rows[0]["potId"] == "pot-export"
