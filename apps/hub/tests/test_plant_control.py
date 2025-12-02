from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Callable, Optional
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from fastapi.testclient import TestClient

from main import create_app
from services import commands as commands_module
from services.commands import CommandServiceError, CommandTimeoutError, SensorReadResult, command_service
from services.pump_status import PumpStatusSnapshot, pump_status_cache


def _build_payload(pot_id: str) -> dict[str, object]:
    return {
        "potId": pot_id,
        "moisture": 42.5,
        "temperature": 21.3,
        "valveOpen": False,
        "fanOn": False,
        "misterOn": False,
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


class _EndpointMessageStream:
    def __init__(self, queue_factory: Callable[[], asyncio.Queue[SimpleNamespace]]) -> None:
        self._queue_factory = queue_factory

    async def __aenter__(self) -> "_EndpointMessageStream":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    def __aiter__(self) -> "_EndpointMessageStream":
        return self

    async def __anext__(self):
        queue = self._queue_factory()
        return await queue.get()


class _EndpointFakeClient:
    def __init__(self, pot_id: str) -> None:
        self.pot_id = pot_id
        self._queues: dict[str, asyncio.Queue[SimpleNamespace]] = {}
        self.subscription_history: list[str] = []
        self.unsubscription_history: list[str] = []
        self.published: list[tuple[str, str, int, bool]] = []
        self.request_ids: list[str] = []
        self._current_topic: Optional[str] = None

    def messages(self) -> _EndpointMessageStream:
        return _EndpointMessageStream(self._active_queue)

    def _active_queue(self) -> asyncio.Queue[SimpleNamespace]:
        if self._current_topic is None:
            raise RuntimeError("No active subscription")
        return self._queues.setdefault(self._current_topic, asyncio.Queue())

    async def subscribe(self, topic: str) -> None:
        self.subscription_history.append(topic)
        self._current_topic = topic

    async def unsubscribe(self, topic: str) -> None:
        self.unsubscription_history.append(topic)
        if self._current_topic == topic:
            self._current_topic = None

    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        self.published.append((topic, payload, qos, retain))
        data = json.loads(payload)
        request_id = data["requestId"]
        self.request_ids.append(request_id)

        sensors_topic = topic.replace("/command", "/sensors")
        queue = self._queues.setdefault(sensors_topic, asyncio.Queue())

        stale_payload = json.dumps(
            {
                "potId": self.pot_id,
                "timestamp": (datetime.now(timezone.utc) - timedelta(seconds=12)).isoformat().replace("+00:00", "Z"),
                "moisture": 41.0,
                "temperature": 20.5,
                "valveOpen": False,
            },
            separators=(",", ":"),
        )
        fresh_payload = json.dumps(
            {
                "potId": self.pot_id,
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "moisture": 58.1,
                "temperature": 21.7,
                "valveOpen": False,
                "requestId": request_id,
            },
            separators=(",", ":"),
        )
        await queue.put(SimpleNamespace(topic=sensors_topic, payload=stale_payload.encode("utf-8")))
        await queue.put(SimpleNamespace(topic=sensors_topic, payload=fresh_payload.encode("utf-8")))


@pytest.mark.anyio
async def test_sensor_read_endpoint_integration_round_trip(monkeypatch: pytest.MonkeyPatch, settings_override) -> None:
    pot_id = "pot-integration"
    fake_client = _EndpointFakeClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    # ensure MQTT startup not attempted during app creation
    settings_override(mqtt_enabled=False)
    app = create_app()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as async_client:
        response = await async_client.post(f"/api/v1/plant-control/{pot_id}/sensor-read", params={"timeout": "1.5"})

    assert response.status_code == 200
    data = response.json()
    assert data["moisture"] == pytest.approx(58.1)
    assert response.headers["X-Command-Request-Id"] == fake_client.request_ids[0]


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


def test_control_fan_endpoint_success(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-fan"
    payload = _build_payload(pot_id)
    mock = AsyncMock(return_value=SensorReadResult(request_id="fan-req-1", payload=payload))
    monkeypatch.setattr(command_service, "control_fan", mock)

    response = client.post(
        f"/api/v1/plant-control/{pot_id}/fan",
        json={"on": False, "durationMs": 0, "timeout": 1.0},
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert response.headers["X-Command-Request-Id"] == "fan-req-1"
    mock.assert_awaited_once()
    kwargs = mock.await_args.kwargs
    assert kwargs["on"] is False
    assert kwargs["duration_ms"] == pytest.approx(0.0)
    assert kwargs["timeout"] == pytest.approx(1.0)


def test_control_fan_endpoint_timeout(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-fan-timeout"
    mock = AsyncMock(side_effect=CommandTimeoutError("Timed out waiting for fan response"))
    monkeypatch.setattr(command_service, "control_fan", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/fan", json={"on": True})

    assert response.status_code == 504
    assert response.json() == {"detail": "Timed out waiting for fan response"}
    mock.assert_awaited_once()


def test_control_fan_endpoint_service_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-fan-error"
    mock = AsyncMock(side_effect=CommandServiceError("MQTT manager is not connected"))
    monkeypatch.setattr(command_service, "control_fan", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/fan", json={"on": True})

    assert response.status_code == 503
    assert response.json() == {"detail": "MQTT manager is not connected"}
    mock.assert_awaited_once()


def test_control_mister_endpoint_success(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-mister"
    payload = _build_payload(pot_id)
    mock = AsyncMock(return_value=SensorReadResult(request_id="mister-req-1", payload=payload))
    monkeypatch.setattr(command_service, "control_mister", mock)

    response = client.post(
        f"/api/v1/plant-control/{pot_id}/mister",
        json={"on": True, "durationMs": 1000, "timeout": 2.5},
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert response.headers["X-Command-Request-Id"] == "mister-req-1"
    mock.assert_awaited_once()
    kwargs = mock.await_args.kwargs
    assert kwargs["on"] is True
    assert kwargs["duration_ms"] == pytest.approx(1000.0)
    assert kwargs["timeout"] == pytest.approx(2.5)


def test_control_mister_endpoint_timeout(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-mister-timeout"
    mock = AsyncMock(side_effect=CommandTimeoutError("Timed out waiting for mister response"))
    monkeypatch.setattr(command_service, "control_mister", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/mister", json={"on": False})

    assert response.status_code == 504
    assert response.json() == {"detail": "Timed out waiting for mister response"}
    mock.assert_awaited_once()


def test_control_mister_endpoint_service_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-mister-error"
    mock = AsyncMock(side_effect=CommandServiceError("MQTT manager is not connected"))
    monkeypatch.setattr(command_service, "control_mister", mock)

    response = client.post(f"/api/v1/plant-control/{pot_id}/mister", json={"on": True})

    assert response.status_code == 503
    assert response.json() == {"detail": "MQTT manager is not connected"}
    mock.assert_awaited_once()


def test_get_pump_status_endpoint_success(client: TestClient) -> None:
    pot_id = "pot-status"
    snapshot = PumpStatusSnapshot(
        pot_id=pot_id,
        status="pump_on",
        pump_on=True,
        fan_on=False,
        mister_on=True,
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
        "fanOn": False,
        "misterOn": True,
        "requestId": "req-42",
        "timestamp": "2025-10-14T12:00:00.000Z",
        "timestampMs": 1_700_000_000_000,
        "receivedAt": "2025-10-14T12:00:01.000Z",
    }


def test_get_pump_status_endpoint_missing(client: TestClient) -> None:
    response = client.get("/api/v1/plant-control/pot-missing/status")

    assert response.status_code == 404
    assert response.json() == {"detail": "Pump status unavailable"}
