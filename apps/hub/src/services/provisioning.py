from __future__ import annotations

import asyncio
import json
import logging
import string
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Optional

logger = logging.getLogger("projectplant.hub.provisioning")


def _now() -> float:
    return time.time()


def _utc_iso() -> str:
    iso = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    return iso.replace("+00:00", "Z")


def normalize_device_id(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    cleaned = "".join(ch for ch in value if ch in string.hexdigits).upper()
    if len(cleaned) != 12:
        return None
    return cleaned


@dataclass(slots=True)
class ProvisionedDeviceSnapshot:
    id: str
    topic: str
    online: bool
    last_seen: float
    first_seen: float
    retained: bool
    state: Optional[str] = None
    fresh: bool = False
    method: Optional[str] = None

    def to_payload(self) -> Dict[str, object]:
        return {
            "id": self.id,
            "topic": self.topic,
            "online": self.online,
            "state": self.state,
            "last_seen": int(self.last_seen),
            "first_seen": int(self.first_seen),
            "retained": self.retained,
            "fresh": self.fresh,
            "method": self.method,
        }


@dataclass(slots=True)
class ProvisioningEvent:
    device: ProvisionedDeviceSnapshot
    timestamp: float


@dataclass(slots=True)
class _DeviceRecord:
    id: str
    topic: str
    online: bool
    state: Optional[str]
    first_seen: float
    last_seen: float
    retained: bool
    last_method: Optional[str] = None

    def snapshot(self, *, fresh: bool, method: Optional[str]) -> ProvisionedDeviceSnapshot:
        return ProvisionedDeviceSnapshot(
            id=self.id,
            topic=self.topic,
            online=self.online,
            state=self.state,
            last_seen=self.last_seen,
            first_seen=self.first_seen,
            retained=self.retained,
            fresh=fresh,
            method=method or self.last_method,
        )


@dataclass(slots=True)
class _Waiter:
    future: asyncio.Future[ProvisioningEvent]
    device_id: Optional[str]
    require_fresh: bool
    since: float
    method: Optional[str]


class ProvisioningStore:
    """Tracks provisioning state transitions and coordinates waiters."""

    def __init__(self, *, log_path_factory: Optional[Callable[[], Optional[str]]] = None) -> None:
        self._devices: Dict[str, _DeviceRecord] = {}
        self._waiters: list[_Waiter] = []
        self._lock = asyncio.Lock()
        self._log_path_factory = log_path_factory
        self._logger = logger

    async def record_state(
        self,
        *,
        device_id: str,
        topic: str,
        payload: str,
        retained: bool,
    ) -> None:
        normalized = normalize_device_id(device_id)
        if normalized is None:
            self._logger.debug("Ignoring state update with invalid device id: %s", device_id)
            return

        state = payload.strip() or None
        lowered = state.lower() if state else ""
        online = lowered not in {"offline", "disconnected", "0", "false"}
        now = _now()

        notifications: list[_Waiter] = []
        record_created = False

        async with self._lock:
            record = self._devices.get(normalized)
            if record is None:
                record_created = True
                record = _DeviceRecord(
                    id=normalized,
                    topic=topic,
                    online=online,
                    state=state,
                    first_seen=now,
                    last_seen=now,
                    retained=bool(retained),
                )
                self._devices[normalized] = record
            else:
                record.topic = topic
                record.online = online
                record.state = state
                record.last_seen = now
                record.retained = bool(retained)

            for waiter in list(self._waiters):
                if waiter.device_id and waiter.device_id != normalized:
                    continue
                if waiter.require_fresh and now <= waiter.since:
                    continue
                notifications.append(waiter)
                self._waiters.remove(waiter)

        for waiter in notifications:
            fresh = now >= waiter.since
            snapshot = record.snapshot(fresh=fresh, method=waiter.method)
            event = ProvisioningEvent(device=snapshot, timestamp=now)
            if waiter.method:
                record.last_method = waiter.method
            if not waiter.future.done():
                waiter.future.set_result(event)

        self._log_event(
            "state_message",
            device_id=normalized,
            topic=topic,
            state=state,
            online=online,
            retained=bool(retained),
            waiters_notified=len(notifications),
            created=record_created,
        )

    async def wait_for_device(
        self,
        *,
        timeout: float,
        device_id: Optional[str],
        require_fresh: bool,
        method: Optional[str],
    ) -> tuple[Optional[ProvisioningEvent], float]:
        normalized = normalize_device_id(device_id)
        start = _now()
        loop = asyncio.get_running_loop()

        async with self._lock:
            if not require_fresh:
                record = None
                if normalized:
                    record = self._devices.get(normalized)
                elif self._devices:
                    record = max(self._devices.values(), key=lambda item: item.last_seen)
                if record is not None:
                    snapshot = record.snapshot(fresh=False, method=method)
                    event = ProvisioningEvent(device=snapshot, timestamp=start)
                    record.last_method = method or record.last_method
                    self._log_event(
                        "wait_cached",
                        method=method,
                        device_id=record.id,
                    )
                    self._log_event(
                        "wait_success",
                        method=method,
                        device_id=record.id,
                        elapsed=0.0,
                        fresh=False,
                    )
                    return event, 0.0

            future: asyncio.Future[ProvisioningEvent] = loop.create_future()
            waiter = _Waiter(
                future=future,
                device_id=normalized,
                require_fresh=require_fresh,
                since=start,
                method=method,
            )
            self._waiters.append(waiter)

        self._log_event(
            "wait_start",
            method=method,
            device_id=normalized,
            timeout=timeout,
            require_fresh=require_fresh,
        )

        try:
            event = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            async with self._lock:
                try:
                    self._waiters.remove(waiter)
                except ValueError:
                    pass
            elapsed = _now() - start
            self._log_event(
                "wait_timeout",
                method=method,
                device_id=normalized,
                elapsed=elapsed,
            )
            return None, elapsed
        except asyncio.CancelledError:
            async with self._lock:
                try:
                    self._waiters.remove(waiter)
                except ValueError:
                    pass
            raise

        elapsed = max(event.timestamp - start, 0.0)
        self._log_event(
            "wait_success",
            method=method,
            device_id=event.device.id,
            elapsed=elapsed,
            fresh=event.device.fresh,
        )
        return event, elapsed

    async def clear(self) -> None:
        async with self._lock:
            waiters = list(self._waiters)
            self._waiters.clear()
            self._devices.clear()
        for waiter in waiters:
            if not waiter.future.done():
                waiter.future.cancel()

    async def list_devices(self) -> list[ProvisionedDeviceSnapshot]:
        async with self._lock:
            records = list(self._devices.values())
        return [record.snapshot(fresh=False, method=None) for record in records]

    def _log_event(self, kind: str, **fields: object) -> None:
        path = self._resolve_log_path()
        entry = {"timestamp": _utc_iso(), "event": kind}
        entry.update({k: v for k, v in fields.items() if v is not None})
        try:
            data = json.dumps(entry, separators=(",", ":"), ensure_ascii=True)
        except (TypeError, ValueError) as exc:
            self._logger.debug("Failed to serialize provisioning log entry %s: %s", entry, exc)
            return

        if path is None:
            self._logger.debug("Provisioning event %s: %s", kind, entry)
            return

        try:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(data + "\n")
        except OSError as exc:
            self._logger.debug("Failed to append provisioning log: %s", exc)

    def _resolve_log_path(self) -> Optional[Path]:
        if self._log_path_factory is None:
            return None
        raw = self._log_path_factory()
        if not raw:
            return None
        path = Path(raw)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self._logger.debug("Unable to create provisioning log directory %s: %s", path.parent, exc)
            return None
        return path


from config import settings

provisioning_store = ProvisioningStore(log_path_factory=lambda: settings.provision_event_log)

__all__ = [
    "ProvisionedDeviceSnapshot",
    "ProvisioningEvent",
    "ProvisioningStore",
    "normalize_device_id",
    "provisioning_store",
]
