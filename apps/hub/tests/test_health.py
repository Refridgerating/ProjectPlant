import asyncio
import os
import sqlite3
from datetime import datetime, timezone, timedelta

from fastapi.testclient import TestClient

from auth.jwt import create_access_token
from main import create_app
from services.alerts import alerts_service


def _build_client() -> TestClient:
    app = create_app()
    token = create_access_token("user-demo-owner")
    return TestClient(app, headers={"Authorization": f"Bearer {token}"})


def test_health_summary_reports_database(settings_override, tmp_path):
    db_path = tmp_path / "telemetry.sqlite"
    sqlite3.connect(db_path).close()
    settings_override(pot_telemetry_db=str(db_path), mqtt_enabled=False)

    with _build_client() as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"ok", "warning"}
    assert payload["database"]["path"] == str(db_path)
    assert payload["database"]["status"] in {"ok", "warning"}
    assert "uptime" in payload
    assert payload["uptime"]["seconds"] is not None


def test_health_mqtt_disabled(settings_override):
    settings_override(mqtt_enabled=False)

    with _build_client() as client:
        response = client.get("/api/v1/health/mqtt")

    assert response.status_code == 200
    payload = response.json()
    assert payload["enabled"] is False
    assert payload["status"] == "disabled"
    assert payload["heartbeat"]["status"] == "unknown"


def test_health_weather_cache_stats(settings_override, tmp_path):
    cache_dir = tmp_path / "hrrr"
    cache_dir.mkdir()
    file_path = cache_dir / "sample.grib2"
    file_path.write_bytes(b"data")
    age = datetime.now(timezone.utc) - timedelta(minutes=30)
    os.utime(file_path, (age.timestamp(), age.timestamp()))
    size = file_path.stat().st_size

    settings_override(hrrr_cache_dir=str(cache_dir), mqtt_enabled=False)

    with _build_client() as client:
        response = client.get("/api/v1/health/weather_cache")

    assert response.status_code == 200
    payload = response.json()
    assert payload["cache_dir"] == str(cache_dir)
    assert payload["file_count"] == 1
    assert payload["status"] in {"ok", "warning"}
    assert payload["bytes"] == size


def test_health_events_endpoint_returns_alerts(settings_override):
    settings_override(mqtt_enabled=False)
    asyncio.run(
        alerts_service.emit(
            "test.alert",
            severity="info",
            message="Test alert event",
            context={"source": "test"},
            notify=False,
        )
    )

    with _build_client() as client:
        response = client.get("/api/v1/health/events?limit=5")

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] >= 1
    assert any(event["event_type"] == "test.alert" for event in payload["events"])
