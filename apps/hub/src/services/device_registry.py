from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Dict, List, Tuple

from config import settings
from services.pot_ids import normalize_pot_id

logger = logging.getLogger("projectplant.hub.device_registry")


def _utc_now_iso() -> str:
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return iso.replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class DeviceRegistryEntry:
    pot_id: str
    added_at: str

    def to_payload(self) -> Dict[str, str]:
        return {"potId": self.pot_id, "addedAt": self.added_at}


class DeviceRegistry:
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._lock = RLock()
        self._loaded = False
        self._entries: Dict[str, DeviceRegistryEntry] = {}

    def list_entries(self) -> List[DeviceRegistryEntry]:
        self._ensure_loaded()
        with self._lock:
            return sorted(self._entries.values(), key=lambda entry: entry.pot_id)

    def add(self, pot_id: str) -> Tuple[DeviceRegistryEntry, bool]:
        normalized = normalize_pot_id(pot_id)
        if not normalized:
            raise ValueError("pot_id is required")
        self._ensure_loaded()
        with self._lock:
            existing = self._entries.get(normalized)
            if existing is not None:
                return existing, False
            entry = DeviceRegistryEntry(pot_id=normalized, added_at=_utc_now_iso())
            self._entries[normalized] = entry
            self._save_locked()
            return entry, True

    def remove(self, pot_id: str) -> bool:
        normalized = normalize_pot_id(pot_id)
        if not normalized:
            return False
        self._ensure_loaded()
        with self._lock:
            removed = self._entries.pop(normalized, None) is not None
            if removed:
                self._save_locked()
            return removed

    def contains(self, pot_id: str) -> bool:
        normalized = normalize_pot_id(pot_id)
        if not normalized:
            return False
        self._ensure_loaded()
        with self._lock:
            return normalized in self._entries

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._loaded = True
            self._entries = {}
            if not self._path.exists():
                return
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to load device registry: %s", exc)
                return

            entries: Dict[str, DeviceRegistryEntry] = {}
            if isinstance(raw, dict):
                devices = raw.get("devices", raw)
                if isinstance(devices, dict):
                    for pot_id, payload in devices.items():
                        normalized = normalize_pot_id(pot_id)
                        if not normalized:
                            continue
                        added_at = None
                        if isinstance(payload, dict):
                            added_at = payload.get("addedAt") or payload.get("added_at")
                        if not isinstance(added_at, str):
                            added_at = _utc_now_iso()
                        entries[normalized] = DeviceRegistryEntry(pot_id=normalized, added_at=added_at)
                elif isinstance(devices, list):
                    for item in devices:
                        if isinstance(item, str):
                            normalized = normalize_pot_id(item)
                            if not normalized:
                                continue
                            entries[normalized] = DeviceRegistryEntry(pot_id=normalized, added_at=_utc_now_iso())
                        elif isinstance(item, dict):
                            pot_id = item.get("potId") or item.get("pot_id")
                            normalized = normalize_pot_id(pot_id)
                            if not normalized:
                                continue
                            added_at = item.get("addedAt") or item.get("added_at")
                            if not isinstance(added_at, str):
                                added_at = _utc_now_iso()
                            entries[normalized] = DeviceRegistryEntry(pot_id=normalized, added_at=added_at)
            self._entries = entries

    def _save_locked(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning("Failed to create device registry directory %s: %s", self._path.parent, exc)
            return
        payload = {
            "version": 1,
            "devices": {entry.pot_id: entry.to_payload() for entry in self._entries.values()},
        }
        try:
            self._path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")
        except OSError as exc:
            logger.warning("Failed to save device registry: %s", exc)


device_registry = DeviceRegistry(settings.device_registry_path)

__all__ = ["DeviceRegistryEntry", "DeviceRegistry", "device_registry"]
