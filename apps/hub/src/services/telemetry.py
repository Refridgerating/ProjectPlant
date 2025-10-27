from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Deque, List, Optional, Sequence


def _ensure_utc(timestamp: Optional[datetime] = None) -> datetime:
    """Normalize timestamps so everything is stored in UTC."""
    if timestamp is None:
        return datetime.now(timezone.utc)
    if timestamp.tzinfo is None:
        return timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(timezone.utc)


def _isoformat(timestamp: datetime) -> str:
    """Serialize timestamps with millisecond precision and trailing Z."""
    iso = timestamp.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


@dataclass(slots=True)
class EnvironmentSample:
    """Represents a single environment telemetry observation."""

    timestamp: datetime
    temperature_c: Optional[float]
    humidity_pct: Optional[float]
    pressure_hpa: Optional[float] = None
    solar_radiation_w_m2: Optional[float] = None
    wind_speed_m_s: Optional[float] = None
    source: str = "sensor"

    def to_payload(self) -> dict[str, object]:
        return {
            "timestamp": _isoformat(self.timestamp),
            "temperature_c": self.temperature_c,
            "humidity_pct": self.humidity_pct,
            "pressure_hpa": self.pressure_hpa,
            "solar_radiation_w_m2": self.solar_radiation_w_m2,
            "wind_speed_m_s": self.wind_speed_m_s,
            "station": None,
            "source": self.source,
        }


class TelemetryStore:
    """In-memory store for the latest environment telemetry samples."""

    def __init__(self, *, retention_hours: float = 72.0, max_samples: int = 4096) -> None:
        self._retention = max(retention_hours, 0.0)
        self._samples: Deque[EnvironmentSample] = deque(maxlen=max(1, max_samples))
        self._lock = asyncio.Lock()

    async def record_environment(
        self,
        *,
        timestamp: Optional[datetime] = None,
        temperature_c: Optional[float],
        humidity_pct: Optional[float],
        pressure_hpa: Optional[float] = None,
        solar_radiation_w_m2: Optional[float] = None,
        wind_speed_m_s: Optional[float] = None,
        source: str = "sensor",
    ) -> None:
        sample = EnvironmentSample(
            timestamp=_ensure_utc(timestamp),
            temperature_c=temperature_c,
            humidity_pct=humidity_pct,
            pressure_hpa=pressure_hpa,
            solar_radiation_w_m2=solar_radiation_w_m2,
            wind_speed_m_s=wind_speed_m_s,
            source=source,
        )
        async with self._lock:
            self._samples.append(sample)
            self._prune_locked()

    async def update_pressure(self, pressure_hpa: Optional[float], *, timestamp: Optional[datetime] = None) -> None:
        """Attach the latest pressure reading so new samples inherit it."""
        if pressure_hpa is None:
            return
        ts = _ensure_utc(timestamp)
        async with self._lock:
            # Update the last sample if it is close in time, otherwise append a new entry.
            if self._samples and (ts - self._samples[-1].timestamp) <= timedelta(minutes=10):
                last = self._samples[-1]
                self._samples[-1] = EnvironmentSample(
                    timestamp=last.timestamp,
                    temperature_c=last.temperature_c,
                    humidity_pct=last.humidity_pct,
                    pressure_hpa=pressure_hpa,
                    solar_radiation_w_m2=last.solar_radiation_w_m2,
                    wind_speed_m_s=last.wind_speed_m_s,
                    source=last.source,
                )
            else:
                self._samples.append(
                    EnvironmentSample(
                        timestamp=ts,
                        temperature_c=None,
                        humidity_pct=None,
                        pressure_hpa=pressure_hpa,
                        solar_radiation_w_m2=None,
                        wind_speed_m_s=None,
                        source="weather",
                    )
                )
            self._prune_locked()

    async def list_samples(
        self,
        *,
        hours: Optional[float] = None,
        limit: Optional[int] = None,
    ) -> List[EnvironmentSample]:
        async with self._lock:
            samples = list(self._samples)

        if hours is not None and hours > 0:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            samples = [sample for sample in samples if sample.timestamp >= cutoff]

        if limit is not None and limit > 0:
            samples = samples[-limit:]

        return samples

    async def latest(self) -> Optional[EnvironmentSample]:
        async with self._lock:
            return self._samples[-1] if self._samples else None

    async def latest_matching(
        self,
        *,
        source_filter: Optional[Sequence[str]] = None,
        max_age: Optional[timedelta] = None,
        require: Optional[Sequence[str]] = None,
    ) -> Optional[EnvironmentSample]:
        async with self._lock:
            snapshot = list(self._samples)

        if not snapshot:
            return None

        now = datetime.now(timezone.utc)
        allowed_sources = set(source_filter) if source_filter is not None else None
        required = tuple(require or ())

        for sample in reversed(snapshot):
            if allowed_sources is not None and sample.source not in allowed_sources:
                continue
            if max_age is not None and (now - sample.timestamp) > max_age:
                continue
            if required and any(getattr(sample, field, None) is None for field in required):
                continue
            return sample

        return None

    async def clear(self) -> None:
        async with self._lock:
            self._samples.clear()

    def _prune_locked(self) -> None:
        if not self._samples or self._retention <= 0:
            return
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self._retention)
        while self._samples and self._samples[0].timestamp < cutoff:
            self._samples.popleft()


telemetry_store = TelemetryStore()

