import pytest
from fastapi.testclient import TestClient

from config import settings
from main import create_app


@pytest.fixture
def disable_mqtt():
    original = settings.mqtt_enabled
    settings.mqtt_enabled = False
    try:
        yield
    finally:
        settings.mqtt_enabled = original


def test_meta_health(disable_mqtt):
    app = create_app()
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": settings.app_version}


def test_v1_info(disable_mqtt):
    app = create_app()
    with TestClient(app) as client:
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
