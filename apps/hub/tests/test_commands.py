from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from services import commands as commands_module
from services.commands import CommandService, CommandServiceError, CommandTimeoutError


@dataclass
class StubMessage:
    payload: bytes


class FakeMessageStream:
    def __init__(self, queue: asyncio.Queue[StubMessage]) -> None:
        self._queue = queue

    async def __aenter__(self) -> FakeMessageStream:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    def __aiter__(self) -> FakeMessageStream:
        return self

    async def __anext__(self) -> StubMessage:
        return await self._queue.get()


class FakeClient:
    def __init__(self, pot_id: str) -> None:
        self.pot_id = pot_id
        self._queues: dict[str, asyncio.Queue[StubMessage]] = {}
        self.subscription_history: list[str] = []
        self.unsubscription_history: list[str] = []
        self.published: list[tuple[str, str, int, bool]] = []
        self.request_ids: list[str] = []

    def filtered_messages(self, topic: str) -> FakeMessageStream:
        queue = self._queues.setdefault(topic, asyncio.Queue())
        return FakeMessageStream(queue)

    async def subscribe(self, topic: str) -> None:
        self.subscription_history.append(topic)

    async def unsubscribe(self, topic: str) -> None:
        self.unsubscription_history.append(topic)

    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        self.published.append((topic, payload, qos, retain))
        data = json.loads(payload)
        self.request_ids.append(data["requestId"])
        sensors_topic = topic.replace("/command", "/sensors")

        # Simulate retained reading followed by a fresh reading triggered by the command.
        stale_payload = json.dumps(
            {
                "timestamp": (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat().replace("+00:00", "Z"),
                "moisture": 47.2,
            },
            separators=(",", ":"),
        )
        fresh_payload = json.dumps(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "moisture": 58.1,
                "requestId": data["requestId"],
            },
            separators=(",", ":"),
        )
        queue = self._queues.setdefault(sensors_topic, asyncio.Queue())
        await queue.put(StubMessage(payload=stale_payload.encode("utf-8")))
        await queue.put(StubMessage(payload=fresh_payload.encode("utf-8")))


class SilentClient(FakeClient):
    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        # Record the publish but do not emit any sensor messages to trigger timeout.
        self.published.append((topic, payload, qos, retain))


class MalformedClient(FakeClient):
    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        self.published.append((topic, payload, qos, retain))
        data = json.loads(payload)
        self.request_ids.append(data["requestId"])
        sensors_topic = topic.replace("/command", "/sensors")
        queue = self._queues.setdefault(sensors_topic, asyncio.Queue())

        # First emit an invalid payload that should be ignored, then the real reading.
        await queue.put(StubMessage(payload=b"not-json"))
        fresh_payload = json.dumps(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "moisture": 61.2,
                "requestId": data["requestId"],
            },
            separators=(",", ":"),
        )
        await queue.put(StubMessage(payload=fresh_payload.encode("utf-8")))


class PumpStatusClient:
    def __init__(self, pot_id: str) -> None:
        self.pot_id = pot_id
        self._queues: dict[str, asyncio.Queue[StubMessage]] = {}
        self.subscription_history: list[str] = []
        self.unsubscription_history: list[str] = []
        self.published: list[tuple[str, str, int, bool]] = []
        self.request_ids: list[str] = []

    def filtered_messages(self, topic: str) -> FakeMessageStream:
        queue = self._queues.setdefault(topic, asyncio.Queue())
        return FakeMessageStream(queue)

    async def subscribe(self, topic: str) -> None:
        self.subscription_history.append(topic)

    async def unsubscribe(self, topic: str) -> None:
        self.unsubscription_history.append(topic)

    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        self.published.append((topic, payload, qos, retain))
        data = json.loads(payload)
        self.request_ids.append(data["requestId"])
        status_topic = topic.replace("/command", "/status")
        queue = self._queues.setdefault(status_topic, asyncio.Queue())

        # Emit an unrelated status first to ensure filtering by requestId.
        unrelated_payload = json.dumps({"status": "online"}, separators=(",", ":"))
        await queue.put(StubMessage(payload=unrelated_payload.encode("utf-8")))

        status_payload = json.dumps(
            {
                "status": "pump_on" if data.get("pump") in ("on", True) else "pump_off",
                "requestId": data["requestId"],
                "potId": self.pot_id,
                "timestampMs": 123456,
            },
            separators=(",", ":"),
        )
        await queue.put(StubMessage(payload=status_payload.encode("utf-8")))


class SilentPumpStatusClient(PumpStatusClient):
    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        self.published.append((topic, payload, qos, retain))
        self.request_ids.append(json.loads(payload)["requestId"])
        # Do not emit matching statuses to trigger timeout.


class MismatchedRequestClient(FakeClient):
    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        self.published.append((topic, payload, qos, retain))
        data = json.loads(payload)
        self.request_ids.append(data["requestId"])
        sensors_topic = topic.replace("/command", "/sensors")

        queue = self._queues.setdefault(sensors_topic, asyncio.Queue())

        mismatched_payload = json.dumps(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "moisture": 12.3,
                "requestId": "other-request",
            },
            separators=(",", ":"),
        )
        await queue.put(StubMessage(payload=mismatched_payload.encode("utf-8")))

        matching_payload = json.dumps(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "moisture": 64.5,
                "requestId": data["requestId"],
            },
            separators=(",", ":"),
        )
        await queue.put(StubMessage(payload=matching_payload.encode("utf-8")))


@pytest.mark.anyio
async def test_request_sensor_read_publishes_command_and_returns_fresh_payload(monkeypatch):
    pot_id = "pot-123"
    fake_client = FakeClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=1.0)
    result = await service.request_sensor_read(pot_id)

    assert fake_client.subscription_history == [f"pots/{pot_id}/sensors"]
    assert fake_client.unsubscription_history == [f"pots/{pot_id}/sensors"]
    topic, payload, qos, retain = fake_client.published[0]
    assert topic == f"pots/{pot_id}/command"
    assert qos == 1
    assert retain is False
    published_data = json.loads(payload)
    assert published_data["command"] == "sensor_read"
    assert result.request_id == published_data["requestId"]
    assert result.payload["moisture"] == pytest.approx(58.1)


@pytest.mark.anyio
async def test_request_sensor_read_times_out(monkeypatch):
    pot_id = "pot-321"
    fake_client = SilentClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=0.2)
    with pytest.raises(CommandTimeoutError):
        await service.request_sensor_read(pot_id, timeout=0.1)


@pytest.mark.anyio
async def test_request_sensor_read_skips_malformed_payloads(monkeypatch):
    pot_id = "pot-malformed"
    fake_client = MalformedClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=1.0)
    result = await service.request_sensor_read(pot_id)

    assert fake_client.subscription_history == [f"pots/{pot_id}/sensors"]
    assert fake_client.unsubscription_history == [f"pots/{pot_id}/sensors"]
    assert fake_client.request_ids == [result.request_id]
    assert result.payload["moisture"] == pytest.approx(61.2)


@pytest.mark.anyio
async def test_request_sensor_read_ignores_unmatched_request_ids(monkeypatch):
    pot_id = "pot-mismatch"
    fake_client = MismatchedRequestClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=1.0)
    result = await service.request_sensor_read(pot_id)

    assert fake_client.subscription_history == [f"pots/{pot_id}/sensors"]
    assert fake_client.unsubscription_history == [f"pots/{pot_id}/sensors"]
    assert result.payload["moisture"] == pytest.approx(64.5)
    # Ensure the requestId echoed back matches the command
    assert result.request_id == fake_client.request_ids[0]


@pytest.mark.anyio
async def test_request_sensor_read_requires_manager(monkeypatch):
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: None)
    service = CommandService()
    with pytest.raises(CommandServiceError):
        await service.request_sensor_read("pot-999")


@pytest.mark.anyio
async def test_send_pump_override_publishes_command_and_waits_for_matching_status(monkeypatch):
    pot_id = "pot-pump"
    fake_client = PumpStatusClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=1.0)
    result = await service.send_pump_override(pot_id, pump_on=True, duration_ms=1500)

    status_topic = f"pots/{pot_id}/status"
    command_topic = f"pots/{pot_id}/command"

    assert fake_client.subscription_history == [status_topic]
    assert fake_client.unsubscription_history == [status_topic]
    topic, payload, qos, retain = fake_client.published[0]
    assert topic == command_topic
    assert qos == 1
    assert retain is False
    published_data = json.loads(payload)
    assert published_data["pump"] == "on"
    assert published_data["duration_ms"] == 1500
    assert result.request_id == published_data["requestId"]
    assert result.payload["status"] == "pump_on"
    assert result.payload["requestId"] == result.request_id


@pytest.mark.anyio
async def test_send_pump_override_times_out(monkeypatch):
    pot_id = "pot-silent-pump"
    fake_client = SilentPumpStatusClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=0.2)
    with pytest.raises(CommandTimeoutError):
        await service.send_pump_override(pot_id, pump_on=False, timeout=0.1)


@pytest.mark.anyio
async def test_control_pump_publishes_command_with_duration(monkeypatch):
    pot_id = "pot-pump"
    fake_client = FakeClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=1.0)
    result = await service.control_pump(pot_id, on=True, duration_ms=1500.0, timeout=0.4)

    assert fake_client.subscription_history == [f"pots/{pot_id}/sensors"]
    assert fake_client.unsubscription_history == [f"pots/{pot_id}/sensors"]
    topic, payload, qos, retain = fake_client.published[0]
    assert topic == f"pots/{pot_id}/command"
    assert qos == 1
    assert retain is False
    published_data = json.loads(payload)
    assert published_data["command"] == "pump"
    assert published_data["on"] is True
    assert published_data["durationMs"] == 1500.0
    assert result.request_id == published_data["requestId"]
    assert result.payload["moisture"] == pytest.approx(58.1)


@pytest.mark.anyio
async def test_control_pump_requires_positive_duration(monkeypatch):
    pot_id = "pot-pump-negative"
    fake_client = FakeClient(pot_id)
    manager = SimpleNamespace(get_client=lambda: fake_client)
    monkeypatch.setattr(commands_module, "get_mqtt_manager", lambda: manager)

    service = CommandService(default_timeout=1.0)
    with pytest.raises(ValueError):
        await service.control_pump(pot_id, on=False, duration_ms=0)
