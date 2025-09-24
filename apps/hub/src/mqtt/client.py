import logging
import ssl
from typing import Optional
from asyncio_mqtt import Client, MqttError

class MqttManager:
    def __init__(self, host: str, port: int, username: Optional[str] = None, password: Optional[str] = None,
                 client_id: Optional[str] = None, tls: bool = False):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.client_id = client_id
        self.tls = tls
        self.log = logging.getLogger("projectplant.hub.mqtt")
        self._client: Optional[Client] = None

    async def connect(self):
        kwargs = {}
        if self.username:
            kwargs["username"] = self.username
            kwargs["password"] = self.password
        if self.tls:
            kwargs["tls_context"] = ssl.create_default_context()
        self._client = Client(self.host, port=self.port, client_id=self.client_id, **kwargs)
        await self._client.connect()
        self.log.info("MQTT connected to %s:%s", self.host, self.port)

    async def disconnect(self):
        if self._client:
            try:
                await self._client.disconnect()
            finally:
                self.log.info("MQTT disconnected")
                self._client = None

_manager: Optional[MqttManager] = None

def get_mqtt_manager() -> Optional[MqttManager]:
    return _manager

async def startup(settings):
    global _manager
    manager = MqttManager(
        host=settings.mqtt_host,
        port=settings.mqtt_port,
        username=settings.mqtt_username,
        password=settings.mqtt_password,
        client_id=settings.mqtt_client_id,
        tls=settings.mqtt_tls,
    )
    try:
        await manager.connect()
        _manager = manager
    except MqttError as e:
        logging.getLogger("projectplant.hub.mqtt").error("MQTT failed to connect: %s", e)
        _manager = None

async def shutdown():
    global _manager
    if _manager:
        await _manager.disconnect()
        _manager = None
