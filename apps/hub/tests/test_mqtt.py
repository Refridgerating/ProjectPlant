import ssl
import types

import pytest
from asyncio_mqtt import MqttError

from mqtt import client as mqtt_client


class DummyClient:
    instances = []

    def __init__(self, host, port, client_id, **kwargs):
        self.host = host
        self.port = port
        self.client_id = client_id
        self.kwargs = kwargs
        self.connected = False
        self.disconnected = False
        DummyClient.instances.append(self)

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.disconnected = True


class DummyBridge:
    def __init__(self, client):
        self.client = client
        self.started = False
        self.stopped = False

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True


@pytest.mark.anyio("asyncio")
async def test_startup_and_shutdown_toggle_manager(monkeypatch):
    DummyClient.instances.clear()
    monkeypatch.setattr(mqtt_client, "Client", DummyClient)
    monkeypatch.setattr(mqtt_client, "MqttBridge", DummyBridge)

    settings = types.SimpleNamespace(
        mqtt_host="broker.example",
        mqtt_port=1883,
        mqtt_username="user",
        mqtt_password="secret",
        mqtt_client_id="client-id",
        mqtt_tls=True,
    )

    await mqtt_client.startup(settings)
    manager = mqtt_client.get_mqtt_manager()
    assert manager is not None
    assert manager.host == "broker.example"
    instance = DummyClient.instances[0]
    assert instance.connected is True
    assert instance.kwargs["username"] == "user"
    assert instance.kwargs["password"] == "secret"
    assert isinstance(instance.kwargs["tls_context"], ssl.SSLContext)

    await mqtt_client.shutdown()
    assert mqtt_client.get_mqtt_manager() is None
    assert instance.disconnected is True


@pytest.mark.anyio("asyncio")
async def test_startup_logs_on_failure(monkeypatch, caplog):
    class FailingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def connect(self):
            raise MqttError("boom")

    monkeypatch.setattr(mqtt_client, "Client", FailingClient)
    monkeypatch.setattr(mqtt_client, "MqttBridge", DummyBridge)
    caplog.set_level("ERROR", logger="projectplant.hub.mqtt")

    settings = types.SimpleNamespace(
        mqtt_host="broken",
        mqtt_port=1883,
        mqtt_username=None,
        mqtt_password=None,
        mqtt_client_id="client-id",
        mqtt_tls=False,
    )

    await mqtt_client.startup(settings)
    assert "MQTT failed to connect" in caplog.text
    assert mqtt_client.get_mqtt_manager() is None

    await mqtt_client.shutdown()
