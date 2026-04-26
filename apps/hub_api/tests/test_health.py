import asyncio
import os
import sqlite3
from datetime import datetime, timezone, timedelta

from fastapi.testclient import TestClient

from auth.jwt import create_access_token
from main import create_app
from services.alerts import alerts_service
from services.hrrr_active_location import HrrrActiveLocation


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


def test_health_weather_cache_stats(settings_override, tmp_path, monkeypatch):
    cache_dir = tmp_path / "hrrr"
    cache_dir.mkdir()
    db_path = tmp_path / "solar.sqlite"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE hrrr_solar_history (
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            valid_time TEXT NOT NULL,
            solar_radiation_w_m2 REAL NOT NULL,
            run_cycle TEXT NOT NULL,
            forecast_hour INTEGER NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (lat, lon, valid_time)
        );
        """
    )
    now = datetime.now(timezone.utc)
    valid_time = now - timedelta(minutes=30)
    run_cycle = valid_time - timedelta(hours=1)
    fetched_at = valid_time + timedelta(minutes=5)
    conn.execute(
        """
        INSERT INTO hrrr_solar_history (lat, lon, valid_time, solar_radiation_w_m2, run_cycle, forecast_hour, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?);
        """,
        (
            38.9,
            -77.0,
            valid_time.isoformat().replace("+00:00", "Z"),
            320.0,
            run_cycle.isoformat().replace("+00:00", "Z"),
            1,
            fetched_at.isoformat().replace("+00:00", "Z"),
        ),
    )
    conn.commit()
    conn.close()
    size = db_path.stat().st_size

    settings_override(
        hrrr_cache_dir=str(cache_dir),
        hrrr_solar_history_db=str(db_path),
        mqtt_enabled=False,
    )
    active_location = HrrrActiveLocation(
        lat=38.944184,
        lon=-77.062402,
        accuracy_m=10.0,
        source="browser_geolocation",
        observed_at=now - timedelta(minutes=5),
        updated_at=now - timedelta(minutes=4),
    )

    from api.v1 import health_router

    async def _location_stub():
        return active_location

    monkeypatch.setattr(health_router.hrrr_weather_service, "get_active_location", _location_stub)

    with _build_client() as client:
        response = client.get("/api/v1/health/weather_cache")

    assert response.status_code == 200
    payload = response.json()
    assert payload["cache_dir"] == str(cache_dir)
    assert payload["file_count"] == 1
    assert payload["status"] in {"ok", "warning"}
    assert payload["bytes"] == size
    assert payload["db_path"] == str(db_path)
    assert payload["active_location"] == {"lat": 38.944184, "lon": -77.062402}
    assert payload["location_source"] == "browser_geolocation"


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
