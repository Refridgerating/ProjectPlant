from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from services.commands import (
    CommandServiceError,
    CommandTimeoutError,
    SensorReadResult,
    command_service,
)


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
