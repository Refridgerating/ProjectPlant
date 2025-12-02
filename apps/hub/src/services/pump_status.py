from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
from typing import Dict, Iterable, List, Optional


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
        if self.request_id is not None:
            payload["requestId"] = self.request_id
        if self.timestamp is not None:
            payload["timestamp"] = self.timestamp
        if self.timestamp_ms is not None:
            payload["timestampMs"] = self.timestamp_ms
        return payload


class PumpStatusCache:
    """Thread-safe cache of the latest pump status per pot."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._entries: Dict[str, PumpStatusSnapshot] = {}

    def update(self, snapshot: PumpStatusSnapshot) -> None:
        with self._lock:
            self._entries[snapshot.pot_id] = snapshot

    def get(self, pot_id: str) -> Optional[PumpStatusSnapshot]:
        with self._lock:
            return self._entries.get(pot_id)

    def list(self) -> List[PumpStatusSnapshot]:
        with self._lock:
            return list(self._entries.values())

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


pump_status_cache = PumpStatusCache()

