import asyncio
import logging
import ssl
from datetime import datetime, timezone
from typing import Optional

from asyncio_mqtt import Client, MqttCodeError, MqttError

from .bridge import MqttBridge
from etkc.worker import start_worker as start_etkc_worker, stop_worker as stop_etkc_worker


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    iso = dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


class MqttManager:
    def __init__(
        self,
        host: str,
        port: int,
        username: Optional[str] = None,
        password: Optional[str] = None,
        client_id: Optional[str] = None,
        tls: bool = False,
    ):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.client_id = client_id
        self.tls = tls
        self.log = logging.getLogger("projectplant.hub.mqtt")
        self._client: Optional[Client] = None
        self._bridge: Optional[MqttBridge] = None
        self._reconnect_lock = asyncio.Lock()
        self._connected_event = asyncio.Event()
        self._should_run = True
        self._reconnect_task: Optional[asyncio.Task[None]] = None
        self._last_connect_time: Optional[datetime] = None
        self._last_disconnect_time: Optional[datetime] = None
        self._last_disconnect_reason: Optional[str] = None

    async def connect(self):
        self._should_run = True
        async with self._reconnect_lock:
            await self._connect_and_start()

    def get_client(self) -> Client:
        if not self._client:
            raise RuntimeError("MQTT client is not connected")
        return self._client

    async def disconnect(self):
        self._should_run = False
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass
            self._reconnect_task = None

        async with self._reconnect_lock:
            await self._teardown_current()

    async def notify_disconnect(self, source: str, exc: BaseException | None = None) -> None:
        if not self._should_run:
            return
        self._connected_event.clear()
        if exc:
            self.log.warning("MQTT disconnect reported by %s: %s", source, exc)
            self._last_disconnect_reason = f"{source}: {exc}"
        else:
            self.log.warning("MQTT disconnect reported by %s", source)
            self._last_disconnect_reason = source
        self._last_disconnect_time = _utc_now()

        if self._reconnect_task is None or self._reconnect_task.done():
            self._reconnect_task = asyncio.create_task(self._reconnect_loop(), name="mqtt-reconnect")

    async def _reconnect_loop(self) -> None:
        backoff = 1.0
        max_backoff = 30.0
        try:
            while self._should_run:
                try:
                    async with self._reconnect_lock:
                        await self._teardown_current()
                    await asyncio.sleep(backoff)
                    async with self._reconnect_lock:
                        if not self._should_run:
                            return
                        await self._connect_and_start()
                        self._connected_event.set()
                        self.log.info("MQTT reconnected after backoff %.1fs", backoff)
                        return
                except asyncio.CancelledError:
                    raise
                except MqttError as exc:
                    self._connected_event.clear()
                    self.log.warning("MQTT reconnect attempt failed: %s", exc)
                except Exception as exc:  # pragma: no cover - defensive logging
                    self._connected_event.clear()
                    self.log.warning("Unexpected error during MQTT reconnect: %s", exc)

                backoff = min(backoff * 2.0, max_backoff)
        finally:
            self._reconnect_task = None

    async def _connect_and_start(self) -> None:
        kwargs = {}
        if self.username:
            kwargs["username"] = self.username
            kwargs["password"] = self.password
        if self.tls:
            kwargs["tls_context"] = ssl.create_default_context()

        client = Client(self.host, port=self.port, client_id=self.client_id, **kwargs)
        await client.connect()
        self._client = client
        self._connected_event.set()
        self.log.info("MQTT connected to %s:%s", self.host, self.port)
        self._last_connect_time = _utc_now()
        self._last_disconnect_reason = None
        self._bridge = MqttBridge(client, on_disconnect=self.notify_disconnect)
        await self._bridge.start()
        await start_etkc_worker(client, on_disconnect=self.notify_disconnect)

    async def _teardown_current(self) -> None:
        self._connected_event.clear()
        if self._bridge:
            await self._bridge.stop()
            self._bridge = None
        await stop_etkc_worker()
        if self._client:
            try:
                await self._client.disconnect()
            except MqttCodeError:
                await self._client.force_disconnect()
            except MqttError:
                await self._client.force_disconnect()
            finally:
                self.log.info("MQTT disconnected")
                self._client = None
                self._last_disconnect_time = _utc_now()
                if self._last_disconnect_reason is None:
                    self._last_disconnect_reason = "shutdown"

    def status_snapshot(self) -> dict:
        connected = self._client is not None
        reconnecting = self._reconnect_task is not None and not self._reconnect_task.done()
        return {
            "connected": connected,
            "reconnecting": reconnecting,
            "host": self.host,
            "port": self.port,
            "client_id": self.client_id,
            "last_connect_time": _iso(self._last_connect_time),
            "last_disconnect_time": _iso(self._last_disconnect_time),
            "last_disconnect_reason": self._last_disconnect_reason,
        }

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
