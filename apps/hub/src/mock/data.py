from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
import random
from typing import Iterable, List

@dataclass(slots=True)
class TelemetryReading:
    timestamp: datetime
    temperature_c: float
    humidity_pct: float
    pressure_hpa: float
    solar_radiation_w_m2: float

    def to_dict(self) -> dict[str, float | str]:
        payload = asdict(self)
        payload["timestamp"] = self.timestamp.isoformat()
        return payload


def _base_time(now: datetime | None = None) -> datetime:
    if now is None:
        now = datetime.now(timezone.utc)
    return now.replace(minute=0, second=0, microsecond=0)


def generate_telemetry(samples: int = 24, *, seed: int | None = None, now: datetime | None = None) -> List[TelemetryReading]:
    if samples <= 0:
        return []

    rng = random.Random(seed)
    base = _base_time(now)
    results: list[TelemetryReading] = []
    for idx in range(samples):
        ts = base - timedelta(hours=samples - idx - 1)
        temperature_c = 20.0 + rng.uniform(-5.0, 5.0)
        humidity_pct = 55.0 + rng.uniform(-20.0, 20.0)
        pressure_hpa = 1013.25 + rng.uniform(-15.0, 15.0)
        solar_radiation_w_m2 = max(0.0, 650.0 + rng.uniform(-300.0, 300.0))
        results.append(
            TelemetryReading(
                timestamp=ts,
                temperature_c=round(temperature_c, 2),
                humidity_pct=round(humidity_pct, 2),
                pressure_hpa=round(pressure_hpa, 2),
                solar_radiation_w_m2=round(solar_radiation_w_m2, 2),
            )
        )
    return results


def telemetry_payload(samples: int = 24, *, seed: int | None = None, now: datetime | None = None) -> List[dict[str, float | str]]:
    readings = generate_telemetry(samples, seed=seed, now=now)
    return [reading.to_dict() for reading in readings]
