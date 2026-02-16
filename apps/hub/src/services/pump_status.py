from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
from typing import Dict, Iterable, List, Optional

from services.pot_ids import normalize_pot_id


@dataclass(frozen=True, slots=True)
class PumpStatusSnapshot:
    """Represents the latest normalized pump status for a single pot."""

    pot_id: str
    status: Optional[str]
    pump_on: Optional[bool]
    request_id: Optional[str]
    timestamp: Optional[str]
    timestamp_ms: Optional[int]
    received_at: str
    fan_on: Optional[bool] = None
    mister_on: Optional[bool] = None
    light_on: Optional[bool] = None
    device_name: Optional[str] = None
    is_named: Optional[bool] = None
    sensor_mode: Optional[str] = None

    def to_dict(self) -> Dict[str, object]:
        payload: Dict[str, object] = {"potId": self.pot_id, "receivedAt": self.received_at}
        if self.status is not None:
            payload["status"] = self.status
        if self.pump_on is not None:
            payload["pumpOn"] = self.pump_on
        if self.fan_on is not None:
            payload["fanOn"] = self.fan_on
        if self.mister_on is not None:
            payload["misterOn"] = self.mister_on
        if self.light_on is not None:
            payload["lightOn"] = self.light_on
        if self.request_id is not None:
            payload["requestId"] = self.request_id
        if self.timestamp is not None:
            payload["timestamp"] = self.timestamp
        if self.timestamp_ms is not None:
            payload["timestampMs"] = self.timestamp_ms
        if self.device_name is not None:
            payload["deviceName"] = self.device_name
        if self.is_named is not None:
            payload["isNamed"] = self.is_named
        if self.sensor_mode is not None:
            payload["sensorMode"] = self.sensor_mode
        return payload


class PumpStatusCache:
    """Thread-safe cache of the latest pump status per pot."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._entries: Dict[str, PumpStatusSnapshot] = {}

    def update(self, snapshot: PumpStatusSnapshot, *, merge: bool = False) -> None:
        original_id = snapshot.pot_id
        normalized_id = normalize_pot_id(original_id) or original_id
        if normalized_id != original_id:
            snapshot = PumpStatusSnapshot(
                pot_id=normalized_id,
                status=snapshot.status,
                pump_on=snapshot.pump_on,
                fan_on=snapshot.fan_on,
                mister_on=snapshot.mister_on,
                light_on=snapshot.light_on,
                request_id=snapshot.request_id,
                timestamp=snapshot.timestamp,
                timestamp_ms=snapshot.timestamp_ms,
                received_at=snapshot.received_at,
                device_name=snapshot.device_name,
                is_named=snapshot.is_named,
                sensor_mode=snapshot.sensor_mode,
            )
        with self._lock:
            if merge:
                existing = self._entries.get(snapshot.pot_id)
                if existing is not None:
                    snapshot = PumpStatusSnapshot(
                        pot_id=snapshot.pot_id,
                        status=snapshot.status if snapshot.status is not None else existing.status,
                        pump_on=snapshot.pump_on if snapshot.pump_on is not None else existing.pump_on,
                        fan_on=snapshot.fan_on if snapshot.fan_on is not None else existing.fan_on,
                        mister_on=snapshot.mister_on if snapshot.mister_on is not None else existing.mister_on,
                        light_on=snapshot.light_on if snapshot.light_on is not None else existing.light_on,
                        request_id=snapshot.request_id if snapshot.request_id is not None else existing.request_id,
                        timestamp=snapshot.timestamp if snapshot.timestamp is not None else existing.timestamp,
                        timestamp_ms=snapshot.timestamp_ms
                        if snapshot.timestamp_ms is not None
                        else existing.timestamp_ms,
                        received_at=snapshot.received_at,
                        device_name=snapshot.device_name
                        if snapshot.device_name is not None
                        else existing.device_name,
                        is_named=snapshot.is_named if snapshot.is_named is not None else existing.is_named,
                        sensor_mode=snapshot.sensor_mode
                        if snapshot.sensor_mode is not None
                        else existing.sensor_mode,
                    )
            if normalized_id != original_id:
                self._entries.pop(original_id, None)
            self._entries[snapshot.pot_id] = snapshot

    def get(self, pot_id: str) -> Optional[PumpStatusSnapshot]:
        with self._lock:
            normalized = normalize_pot_id(pot_id)
            if not normalized:
                return None
            return self._entries.get(normalized)

    def list(self) -> List[PumpStatusSnapshot]:
        with self._lock:
            return list(self._entries.values())

    def delete(self, pot_id: str) -> bool:
        normalized = normalize_pot_id(pot_id)
        if not normalized:
            return False
        with self._lock:
            removed = self._entries.pop(normalized, None) is not None
            if not removed and normalized != pot_id:
                removed = self._entries.pop(pot_id, None) is not None
            return removed

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


pump_status_cache = PumpStatusCache()

