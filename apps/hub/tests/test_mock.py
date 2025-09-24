from datetime import datetime, timezone

from fastapi.testclient import TestClient

from mock.data import generate_telemetry, telemetry_payload
from main import create_app
from config import settings


def test_generate_telemetry_deterministic():
    now = datetime(2025, 9, 23, 12, tzinfo=timezone.utc)
    readings = generate_telemetry(samples=2, seed=123, now=now)
    assert len(readings) == 2
    assert readings[0].timestamp.isoformat() == "2025-09-23T11:00:00+00:00"
    assert readings[1].timestamp.isoformat() == "2025-09-23T12:00:00+00:00"


def test_telemetry_payload_round_trip():
    payload = telemetry_payload(samples=1, seed=1)
    assert len(payload) == 1
    keys = payload[0].keys()
    assert {"timestamp", "temperature_c", "humidity_pct", "pressure_hpa", "solar_radiation_w_m2"}.issubset(keys)


def test_mock_endpoint(monkeypatch):
    monkeypatch.setattr(settings, "mqtt_enabled", False)
    app = create_app()
    with TestClient(app) as client:
        response = client.get("/api/v1/mock/telemetry", params={"samples": 5})
    assert response.status_code == 200
    data = response.json()
    assert data["samples"] == 5
    assert len(data["data"]) == 5
