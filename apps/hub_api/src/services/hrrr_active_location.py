from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _ensure_utc(value: Optional[datetime] = None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    iso = value.astimezone(timezone.utc).isoformat(timespec="seconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def _parse_iso(value: object) -> Optional[datetime]:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    try:
        parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class HrrrActiveLocation:
    lat: float
    lon: float
    accuracy_m: float | None
    source: str
    observed_at: datetime | None
    updated_at: datetime

    def to_payload(self) -> dict[str, object]:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "accuracy_m": self.accuracy_m,
            "source": self.source,
            "observed_at": _isoformat(self.observed_at),
            "updated_at": _isoformat(self.updated_at),
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "HrrrActiveLocation":
        source = str(payload.get("source", "")).strip()
        if not source:
            raise ValueError("Active location source is required")
        updated_at = _parse_iso(payload.get("updated_at"))
        if updated_at is None:
            raise ValueError("Active location updated_at is required")
        return cls(
            lat=float(payload["lat"]),
            lon=float(payload["lon"]),
            accuracy_m=float(payload["accuracy_m"]) if payload.get("accuracy_m") is not None else None,
            source=source,
            observed_at=_parse_iso(payload.get("observed_at")),
            updated_at=updated_at,
        )


class HrrrActiveLocationStore:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def get(self) -> HrrrActiveLocation | None:
        if not self._path.exists():
            return None
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        try:
            return HrrrActiveLocation.from_payload(payload)
        except (KeyError, TypeError, ValueError):
            return None

    def upsert(
        self,
        *,
        lat: float,
        lon: float,
        accuracy_m: float | None,
        source: str,
        observed_at: datetime | None = None,
        updated_at: datetime | None = None,
    ) -> HrrrActiveLocation:
        cleaned_source = str(source).strip()
        if not cleaned_source:
            raise ValueError("Active location source is required")
        accuracy = float(accuracy_m) if accuracy_m is not None else None
        if accuracy is not None and accuracy < 0:
            raise ValueError("Active location accuracy must be non-negative")
        record = HrrrActiveLocation(
            lat=float(lat),
            lon=float(lon),
            accuracy_m=accuracy,
            source=cleaned_source,
            observed_at=_ensure_utc(observed_at) if observed_at is not None else None,
            updated_at=_ensure_utc(updated_at),
        )
        payload = json.dumps(record.to_payload(), separators=(",", ":"), sort_keys=True)
        temp_path = self._path.with_suffix(self._path.suffix + ".tmp")
        temp_path.write_text(payload, encoding="utf-8")
        os.replace(temp_path, self._path)
        return record


__all__ = [
    "HrrrActiveLocation",
    "HrrrActiveLocationStore",
]
