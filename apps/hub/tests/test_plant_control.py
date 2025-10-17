from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from services.commands import CommandServiceError, CommandTimeoutError, SensorReadResult, command_service
from services.pump_status import PumpStatusSnapshot, pump_status_cache


def _build_payload(pot_id: str) -> dict[str, object]:
    return {
        "potId": pot_id,
        "moisture": 42.5,
        "temperature": 21.3,
        "valveOpen": False,
        "timestamp": "2025-10-14T12:00:00.000Z",
        "humidity": 48.2,
    }


def test_sensor_read_endpoint_success(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-abc"
    payload = _build_payload(pot_id)
    mock = AsyncMock(return_value=SensorReadResult(request_id="req-1", payload=payload))
    monkeypatch.setattr(command_service, "request_sensor_read", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/sensor-read", params={"timeout": "1.5"})

    assert response.status_code == 200
    assert response.json() == payload
    assert response.headers["X-Command-Request-Id"] == "req-1"
    mock.assert_awaited_once()
    assert mock.await_args.kwargs["timeout"] == 1.5


def test_sensor_read_endpoint_timeout(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-timeout"
    mock = AsyncMock(side_effect=CommandTimeoutError("Timed out waiting for sensor reading"))
    monkeypatch.setattr(command_service, "request_sensor_read", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/sensor-read")

    assert response.status_code == 504
    assert response.json() == {"detail": "Timed out waiting for sensor reading"}
    mock.assert_awaited_once()


def test_sensor_read_endpoint_service_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-error"
    mock = AsyncMock(side_effect=CommandServiceError("MQTT manager is not connected"))
    monkeypatch.setattr(command_service, "request_sensor_read", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/sensor-read")

    assert response.status_code == 503
    assert response.json() == {"detail": "MQTT manager is not connected"}
    mock.assert_awaited_once()


def test_control_pump_endpoint_success(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-pump"
    payload = _build_payload(pot_id)
    mock = AsyncMock(return_value=SensorReadResult(request_id="pump-req-1", payload=payload))
    monkeypatch.setattr(command_service, "control_pump", mock)

    response = client.post(
        f"/api/v1/plant-control/{pot_id}/pump",
        json={"on": True, "durationMs": 1250, "timeout": 0.75},
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert response.headers["X-Command-Request-Id"] == "pump-req-1"
    mock.assert_awaited_once()
    kwargs = mock.await_args.kwargs
    assert kwargs["on"] is True
    assert kwargs["duration_ms"] == pytest.approx(1250.0)
    assert kwargs["timeout"] == pytest.approx(0.75)


def test_control_pump_endpoint_timeout(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-timeout"
    mock = AsyncMock(side_effect=CommandTimeoutError("Timed out waiting for pump response"))
    monkeypatch.setattr(command_service, "control_pump", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/pump", json={"on": False})

    assert response.status_code == 504
    assert response.json() == {"detail": "Timed out waiting for pump response"}
    mock.assert_awaited_once()


def test_control_pump_endpoint_service_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-error"
    mock = AsyncMock(side_effect=CommandServiceError("MQTT manager is not connected"))
    monkeypatch.setattr(command_service, "control_pump", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/pump", json={"on": True})

    assert response.status_code == 503
    assert response.json() == {"detail": "MQTT manager is not connected"}
    mock.assert_awaited_once()


def test_get_pump_status_endpoint_success(client: TestClient) -> None:
    pot_id = "pot-status"
    snapshot = PumpStatusSnapshot(
        pot_id=pot_id,
        status="pump_on",
        pump_on=True,
        request_id="req-42",
        timestamp="2025-10-14T12:00:00.000Z",
        timestamp_ms=1_700_000_000_000,
        received_at="2025-10-14T12:00:01.000Z",
    )
    pump_status_cache.update(snapshot)

    response = client.get(f"/api/v1/plant-control/{pot_id}/status")

    assert response.status_code == 200
    assert response.json() == {
        "potId": pot_id,
        "status": "pump_on",
        "pumpOn": True,
        "requestId": "req-42",
        "timestamp": "2025-10-14T12:00:00.000Z",
        "timestampMs": 1_700_000_000_000,
        "receivedAt": "2025-10-14T12:00:01.000Z",
    }


def test_get_pump_status_endpoint_missing(client: TestClient) -> None:
    response = client.get("/api/v1/plant-control/pot-missing/status")

    assert response.status_code == 404
    assert response.json() == {"detail": "Pump status unavailable"}
