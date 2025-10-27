
from fastapi.testclient import TestClient

from config import settings


def test_meta_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": settings.app_version}


def test_v1_info(client: TestClient) -> None:
    response = client.get("/api/v1/info")
    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == settings.app_name
    assert payload["version"] == settings.app_version
    assert payload["debug"] == settings.debug
    assert payload["cors_origins"] == settings.cors_origins
    assert payload["mqtt_enabled"] == settings.mqtt_enabled
    assert payload["mqtt_host"] == settings.mqtt_host
    assert payload["mqtt_port"] == settings.mqtt_port
    assert payload["pot_telemetry_retention_hours"] == settings.pot_telemetry_retention_hours
    assert payload["pot_telemetry_max_rows"] == settings.pot_telemetry_max_rows


def test_etkc_metrics_endpoint(client: TestClient) -> None:
    response = client.get("/api/v1/etkc/metrics/test-pot")
    assert response.status_code == 200
    assert response.json() == []
